import copy
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import exists, func, or_, update
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import (
    AdjustType,
    OrderStatus,
    OutboundType,
    ReserveSource,
    SaleOrderStatus,
    ShopListingStatus,
    SkuStatus,
    StaffRole,
    StockEventType,
    StocktakeDiffType,
    StocktakeProposalStatus,
    StocktakeStatus,
    WarehousePhase,
)
from app.models import (
    EventLog,
    AiRedrawJob,
    Inspection,
    InventoryAdjustment,
    LegacySnapshot,
    PickupPayment,
    PurchaseOrder,
    ReturnOrder,
    SaleOrder,
    SalesOutbound,
    Sku,
    SkuListingInfo,
    SkuShopListing,
    Staff,
    StockEvent,
    StocktakeAdjustment,
    StocktakeSession,
)
from app.services import purchase_pieces
from app.services.warehouse_phase import apply_phase_filter, compute_warehouse_phase
from app.schemas._tz import utc_to_cn_iso
from app.schemas.inventory import (
    SkuMarketInfoIn,
    AdjustRequest,
    BarcodeLookupIn,
    BarcodeMigrationIn,
    BarcodeMigrationItem,
    BarcodeMigrationListResponse,
    InventorySummary,
    LegacySnapshotOut,
    OutboundManualRequest,
    OutboundScanRequest,
    ManualInboundIn,
    ManualInboundResult,
    RecodeIn,
    RecodeOut,
    RfidScanIn,
    RfidScanResult,
    SalesOutboundOut,
    SkuDetailOut,
    SkuListResponse,
    SkuMigrationItem,
    SkuMigrationListResponse,
    SkuMigrationRecodeIn,
    SkuMigrationRecodeOut,
    SkuOut,
    SkuSplitRequest,
    SkuSplitResult,
    SkuUpdateIn,
    StockEventOut,
    StocktakeDiffOut,
    StocktakeItemIn,
    StocktakeListItem,
    StocktakeProposalIn,
    StocktakeProposalOut,
    StocktakeReviewIn,
    StocktakeSessionOut,
    StocktakeSkuBrief,
)
from app.services.express import normalize_phone_suffix
from app.services.barcode import (
    BARCODE_MIGRATION_SOURCE,
    apply_sku_barcode,
    barcode_source_label,
    barcode_status,
    enrich_sku_spu,
    load_last_barcode_event_map,
    normalize_barcode,
    query_barcode,
    spu_text,
)
from app.services.auto_listing.pipeline import enqueue_on_inbound
from app.services.manual_sku import create_in_stock_sku
from app.services.manual_sku import normalize_image_urls as _normalize_image_urls
from app.services.order_no import generate_order_no, generate_sku_code
from app.services.oss_media import sign_media_payload, thumb_url_for_cover
from app.services.staff_lookup import map_staff_names
from app.services.stocktake import apply_inventory_adjustment
from app.services import stock_lock_delist
from app.services import practice
from app.services.sku_recode import (
    SCOPED_STATUSES as _SKU_MIGRATION_SCOPED_STATUSES,
    SKU_MIGRATION_PREFIX as _SKU_MIGRATION_PREFIX,
    SKU_MIGRATION_SOURCE as _SKU_MIGRATION_SOURCE,
    load_last_recode_event_map,
    migration_status as _sku_migration_status,
    recode_source_label as _recode_source_label,
    recode_sku,
)

router = APIRouter(prefix="/api/inventory", tags=["inventory"])


def _sku_out(
    sku: Sku,
    names: dict[str, str],
    inspector_id: str | None,
    *,
    for_list: bool = False,
    listing: SkuListingInfo | None = None,
    listed_count: int = 0,
    listing_count: int = 0,
    hide_cost: bool = False,
) -> SkuOut:
    data = SkuOut.model_validate(sku).model_dump()
    if hide_cost:
        data["cost_price"] = None
    data["tags"] = list(sku.tags or [])
    data["operator_name"] = names.get(inspector_id) if inspector_id else None
    data["warehouse_phase"] = compute_warehouse_phase(
        sku, listing, listed_count=listed_count, listing_count=listing_count
    )
    data["listing_status"] = listing.status if listing else None
    data["on_shelf_count"] = listed_count
    payload = sign_media_payload(data)
    if for_list and payload.get("cover_url"):
        payload["cover_thumb_url"] = thumb_url_for_cover(payload["cover_url"])
    return SkuOut(**payload)


def _inspector_filter(query, user: Staff):
    # 管理员/仓管看全部仓库的货;销售要选品/编辑上架信息,也看全部;
    # 采购要在工作台上比价、核对型号,也看全部——它从不验货,按验货人过滤就是一片空,
    # 接口通、鉴权过、数据空,现场表现是"连不上"(爬虫账号踩过同一个坑);
    # 行情爬虫与行情工作台要按在库型号采集闲鱼行情,同样看全部;
    # 其余角色只看自己验的货
    if user.role in (StaffRole.ADMIN, StaffRole.SALES, StaffRole.WAREHOUSE,
                     StaffRole.PURCHASER, StaffRole.CRAWLER, StaffRole.MARKET_BOT):
        return query
    return query.filter(Inspection.inspector_id == user.id)


def _hide_cost(user: Staff) -> bool:
    """只有只读采集端(CRAWLER)看不到库存成本。

    它要的是"在库有哪些型号",型号/规格够用,成本价对它没有用途,不该跟着库存列表出门。

    销售曾经也在这一档。2026-09-16 老板定:销售要自己登工作台定价、上下架,
    没有成本价就没有成本底价,调价只能靠猜。这条放开是**全局的**——同一套角色
    判定,小程序和后台也吃,销售在那两处一样看得到进价。这是明知代价后的决定,
    不是漏网。

    行情工作台(MARKET_BOT)同理:候选价低于成本底价一律拦下,看不到成本等于没有
    底价,调价台只能永远停在"需复核"。

    看得到成本 ≠ 能改任何东西:写接口仍各自按角色单独把门
    (见 tests/test_market_bot_role.py)。
    """
    return user.role in (StaffRole.CRAWLER,)


@router.get("/summary", summary="查询库存汇总", response_model=InventorySummary)
def summary(
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    base = db.query(Sku).join(Inspection, Sku.inspection_id == Inspection.id)
    base = _inspector_filter(base, user)
    in_warehouse = base.filter(Sku.status.in_((SkuStatus.IN_STOCK, SkuStatus.RESERVED)))
    rows = in_warehouse.all()
    on_sale_q = apply_phase_filter(
        db.query(Sku).join(Inspection, Sku.inspection_id == Inspection.id),
        WarehousePhase.ON_SALE,
    )
    on_sale_q = _inspector_filter(on_sale_q, user)
    locked_q = apply_phase_filter(
        db.query(Sku).join(Inspection, Sku.inspection_id == Inspection.id),
        WarehousePhase.LOCKED,
    )
    locked_q = _inspector_filter(locked_q, user)
    return InventorySummary(
        total_cost=None if _hide_cost(user) else sum((r.cost_price for r in rows), Decimal("0")),
        total_count=len(rows),
        on_sale_count=on_sale_q.count(),
        locked_count=locked_q.count(),
    )


@router.get("/skus", summary="查询 SKU 列表", response_model=SkuListResponse)
def list_skus(
    status: str | None = None,
    on_shelf: bool | None = None,
    phase: str | None = None,
    in_warehouse: bool | None = None,
    q: str | None = None,
    tags: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    query = db.query(Sku, Inspection).join(Inspection, Sku.inspection_id == Inspection.id)
    query = _inspector_filter(query, user)
    if phase:
        query = apply_phase_filter(query, phase)
    elif in_warehouse:
        in_warehouse_statuses = [SkuStatus.IN_STOCK, SkuStatus.RESERVED]
        if q:
            # 综合搜索：纳入已发货，便于按销售物流单号/序列号定位已售出商品
            in_warehouse_statuses.append(SkuStatus.SHIPPED)
        query = query.filter(Sku.status.in_(in_warehouse_statuses))
    else:
        effective_status = status if status is not None else SkuStatus.IN_STOCK
        query = query.filter(Sku.status == effective_status)
        if on_shelf is not None:
            listed_exists = exists().where(
                SkuShopListing.sku_id == Sku.id,
                SkuShopListing.publish_status == ShopListingStatus.LISTED,
            )
            query = query.filter(listed_exists) if on_shelf else query.filter(~listed_exists)
    if q:
        # 多关键词模糊：按空格分词，每个词都要在某个字段命中（词间 AND、字段间 OR），
        # 支持「iphone 白 128」这类乱序/不相邻输入；单个词时与原来 %q% 效果一致。
        for term in q.split():
            like = f"%{term}%"
            # 入库物流单号（采购单，SKU 直连）
            inbound_tracking = exists().where(
                PurchaseOrder.id == Sku.purchase_order_id,
                PurchaseOrder.tracking_no.like(like),
            )
            # 销售物流单号：出库记录自身的运单号
            outbound_tracking = exists().where(
                SalesOutbound.sku_id == Sku.id,
                SalesOutbound.tracking_no.like(like),
            )
            # 销售物流单号：出库关联销售单上的运单号
            sale_order_tracking = exists().where(
                SalesOutbound.sku_id == Sku.id,
                SalesOutbound.sale_order_id == SaleOrder.id,
                SaleOrder.tracking_no.like(like),
            )
            query = query.filter(
                (Sku.sku_code.like(like))       # 货号 / 条形码（标签印的即货号）
                | (Sku.short_code.like(like))     # 4 位上架短编码（历史订单标题里的 #NNNN）
                | (Sku.serial_number.like(like))  # 序列号 / 商品条形
                | (Sku.rfid_epc.like(like))       # RFID 标签 EPC
                | (Sku.product_name.like(like))
                | (Sku.brand.like(like))
                | (Sku.model.like(like))
                | (Sku.spec.like(like))
                | (Sku.location_code.like(like))
                | inbound_tracking                # 入库物流单号
                | outbound_tracking               # 销售物流单号（出库单）
                | sale_order_tracking             # 销售物流单号（销售单）
            )
    if tags:
        tag_names = [name.strip() for name in tags.split(",") if name.strip()]
        if tag_names:
            conditions = [
                func.JSON_CONTAINS(Sku.tags, func.JSON_QUOTE(name)) == 1
                for name in tag_names
            ]
            query = query.filter(or_(*conditions))
    total = query.count()
    rows = (
        query.order_by(Sku.inbound_at.desc(), Sku.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    sku_ids = [sku.id for sku, _ in rows]
    listings = {
        row.sku_id: row
        for row in db.query(SkuListingInfo).filter(SkuListingInfo.sku_id.in_(sku_ids)).all()
    } if sku_ids else {}
    listed_counts: dict[str, int] = {}
    listing_counts: dict[str, int] = {}
    if sku_ids:
        for sid, cnt in (
            db.query(SkuShopListing.sku_id, func.count())
            .filter(
                SkuShopListing.sku_id.in_(sku_ids),
                SkuShopListing.publish_status == ShopListingStatus.LISTED,
            )
            .group_by(SkuShopListing.sku_id)
            .all()
        ):
            listed_counts[sid] = cnt
        for sid, cnt in (
            db.query(SkuShopListing.sku_id, func.count())
            .filter(
                SkuShopListing.sku_id.in_(sku_ids),
                SkuShopListing.publish_status == ShopListingStatus.LISTING,
            )
            .group_by(SkuShopListing.sku_id)
            .all()
        ):
            listing_counts[sid] = cnt
    names = map_staff_names(db, {insp.inspector_id for _, insp in rows})
    items = [
        _sku_out(
            sku,
            names,
            insp.inspector_id,
            for_list=True,
            listing=listings.get(sku.id),
            listed_count=listed_counts.get(sku.id, 0),
            listing_count=listing_counts.get(sku.id, 0),
            hide_cost=_hide_cost(user),
        )
        for sku, insp in rows
    ]
    # 搜索兜底:新系统查无结果时,附带查老系统快照,防止仓库误判商品不存在。
    # 只在第 1 页返回;老货号/序列号/条码走前缀索引,商品名走模糊。
    legacy_matches: list[LegacySnapshotOut] = []
    if q and total == 0 and page == 1:
        like = f"%{q}%"
        legacy_rows = (
            db.query(LegacySnapshot)
            .filter(
                (LegacySnapshot.goods_no.like(like))
                | (LegacySnapshot.serial_no.like(like))
                | (LegacySnapshot.barcode.like(like))
                | (LegacySnapshot.product_name.like(like))
            )
            .order_by(LegacySnapshot.inbound_at.desc())
            .limit(10)
            .all()
        )
        legacy_matches = [LegacySnapshotOut.model_validate(r) for r in legacy_rows]
    return SkuListResponse(items=items, total=total, page=page, size=size, legacy_matches=legacy_matches)


@router.get("/skus/{sku_code}", summary="查询 SKU 详情", response_model=SkuDetailOut)
def sku_detail(sku_code: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    sku = (
        db.query(Sku)
        .options(joinedload(Sku.stock_events))
        .filter(Sku.sku_code == sku_code)
        .first()
    )
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    listing = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    listed_count = (
        db.query(SkuShopListing)
        .filter(
            SkuShopListing.sku_id == sku.id,
            SkuShopListing.publish_status == ShopListingStatus.LISTED,
        )
        .count()
    )
    listing_count = (
        db.query(SkuShopListing)
        .filter(
            SkuShopListing.sku_id == sku.id,
            SkuShopListing.publish_status == ShopListingStatus.LISTING,
        )
        .count()
    )
    events = [StockEventOut.model_validate(e).model_dump() for e in sku.stock_events]
    base = _sku_out(
        sku, {}, None, listing=listing, listed_count=listed_count, listing_count=listing_count,
        hide_cost=_hide_cost(user),
    ).model_dump()
    payload = sign_media_payload({**base, "stock_events": events})
    # 入库快递单号在采购单上，签名后再挂（自由文本不能进 sign_media_payload）
    order = db.get(PurchaseOrder, sku.purchase_order_id)
    payload["tracking_no"] = order.tracking_no if order else None
    payload["purchase_order_no"] = order.order_no if order else None
    return SkuDetailOut(**payload)


@router.post("/skus/{sku_code}/split", summary="拆分库存 SKU", response_model=SkuSplitResult)
def split_sku(
    sku_code: str,
    body: SkuSplitRequest,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    """历史库存拆分：把 1 条 SKU 按金额拆成 N 条独立 SKU（原件退役）。"""
    from app.services import inventory_split

    try:
        return inventory_split.split_sku(db, user, sku_code, body.items)
    except inventory_split.SplitError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


_CN_TZ = timezone(timedelta(hours=8))


def _cn_wall_to_utc(dt: datetime | None) -> datetime | None:
    """前端传来的北京时间墙上时间 → naive-UTC（与 inbound_at/created_at 存储口径一致）。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_CN_TZ)
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


@router.post("/manual-inbound", summary="手动入库商品", response_model=ManualInboundResult)
def manual_inbound(
    body: ManualInboundIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    """仓管手动入库（迁移旧系统货品）：自动造占位采购单+验货单，直接生成在库 SKU，免议价。

    与正常验货入库的差异：不依赖真实采购单；货号可手填旧码（留空自动生成）；
    可回填旧系统原始入库时间；入库即定价（negotiated_at 直接写），跳过议价直接进上架待办。
    """
    brand = (body.brand or "").strip()
    model = (body.model or "").strip()
    spec = (body.spec or "").strip() or None
    product_name = (body.product_name or "").strip() or " ".join(p for p in (brand, model) if p)
    if not product_name:
        raise HTTPException(status_code=400, detail="请填写商品名称（或品牌+型号）")
    serial_number = (body.serial_number or "").strip()
    if not serial_number:
        raise HTTPException(status_code=400, detail="序列号不能为空")
    location_code = (body.location_code or "").strip()
    if not location_code:
        raise HTTPException(status_code=400, detail="库位不能为空")
    condition_grade = (body.condition_grade or "").strip()
    if not condition_grade:
        raise HTTPException(status_code=400, detail="成色不能为空")
    images = _normalize_image_urls(body.images or [])
    if not images:
        raise HTTPException(status_code=400, detail="至少 1 张商品图")
    location_images = _normalize_image_urls(body.location_images or [])

    # 货号：手填旧码（查重撞库 409）或留空自动生成
    sku_code = (body.sku_code or "").strip().upper()
    if sku_code:
        if db.query(Sku).filter(Sku.sku_code == sku_code).first():
            raise HTTPException(status_code=409, detail=f"货号 {sku_code} 已存在")
    else:
        sku_code = generate_sku_code(db)

    remark = (body.remark or "").strip() or None
    sku, po = create_in_stock_sku(
        db,
        user,
        source="MANUAL_INBOUND",
        po_prefix="POMAN",
        inspect_prefix="INMAN",
        inspector_id=user.id,
        sku_code=sku_code,
        product_name=product_name,
        brand=brand or None,
        model=model or None,
        spec=spec,
        serial_number=serial_number,
        barcode=(body.barcode or "").strip() or None,
        location_code=location_code,
        condition_grade=condition_grade,
        product_type=(body.product_type or "").strip() or None,
        cost_price=body.cost_price,
        images=images,
        location_images=location_images,
        inbound_at=_cn_wall_to_utc(body.inbound_at) or datetime.utcnow(),
        po_remark=f"手动入库{'：' + remark if remark else ''}",
        negotiation_remark="手动入库免议价",
        event_payload={"old_sku_code": (body.sku_code or "").strip() or None},
    )

    # 有 69码 则自动查询一次条码库，写入 spu（失败不阻断入库）
    enrich_sku_spu(sku)

    # 入库即登记自动上架（开关关着则不登记；跟入库同一笔事务落库）
    enqueue_on_inbound(db, sku)

    db.commit()
    return ManualInboundResult(sku_code=sku_code, purchase_order_no=po.order_no)


@router.patch("/skus/{sku_code}/market-info", summary="回写商品名/品牌/型号（设备账号窄接口）",
              response_model=SkuDetailOut)
def update_sku_market_info(
    sku_code: str,
    body: SkuMarketInfoIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(
        StaffRole.MARKET_BOT, StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    """行情工作台把闲鱼上查到的正确品名回写进库存。

    为什么单开一条而不是放行上面那条 PATCH:那条是仓管的**全量编辑**,能改货号、
    改 69 码、改规格库位成色。桌面端只想改一个商品名,却要为此在每台工位上存一份
    能开那扇门的管理员密码——权限放大得离谱,审计上还全部记成「管理员干的」。
    这条接口的可写字段就是 schema 里那三个,服务端强制,不依赖客户端自觉。

    每次回写落一条 EventLog(前后值 + 操作者),这样「谁在哪台机器改了什么」查得到。
    """
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status not in (SkuStatus.IN_STOCK, SkuStatus.RESERVED):
        raise HTTPException(status_code=400, detail="只能编辑在库/锁单中的商品")

    data = body.model_dump(exclude_unset=True)
    before, after = {}, {}
    for field in ("product_name", "brand", "model"):
        if field not in data:
            continue
        value = (data[field] or "").strip() or None
        if field == "product_name" and not value:
            raise HTTPException(status_code=400, detail="商品名称不能为空")
        old_value = getattr(sku, field, None)
        if old_value == value:
            continue
        before[field] = old_value
        after[field] = value
        setattr(sku, field, value)

    if after:
        db.add(EventLog(
            event_type="sku_market_info_writeback",
            entity_type="sku", entity_id=sku.sku_code, operator_id=user.id,
            payload={"before": before, "after": after, "role": user.role},
            occurred_at=datetime.utcnow(),
        ))
        db.commit()
    return sku_detail(sku.sku_code, db, user)


@router.patch("/skus/{sku_code}", summary="更新 SKU 信息", response_model=SkuDetailOut)
def update_sku(
    sku_code: str,
    body: SkuUpdateIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status not in (SkuStatus.IN_STOCK, SkuStatus.RESERVED):
        raise HTTPException(status_code=400, detail="只能编辑在库/锁单中的商品")

    data = body.model_dump(exclude_unset=True)
    new_code = sku_code
    if "sku_code" in data:
        candidate = (data["sku_code"] or "").strip()
        if not candidate:
            raise HTTPException(status_code=400, detail="货号不能为空")
        if candidate.upper() != sku.sku_code:
            # 改货号必须走共享改码逻辑:同步所有冗余 sku_code 表并留 RECODE 痕
            # (仓管实际常用编辑页换新货号标签,原先这里裸改 sku_code 不留痕不同步)
            sku, _ = recode_sku(
                db,
                user,
                old_sku_code=sku.sku_code,
                new_sku_code=candidate,
                source="MINIPROGRAM_WAREHOUSE_EDIT",
                commit=False,
            )
            new_code = sku.sku_code
    if "barcode" in data:
        # 69码变更走统一入口:校验位数 + 重查 SPU + 留 BARCODE_SET 痕(与 69码更换页同一套)
        apply_sku_barcode(
            db, user, sku, barcode=data["barcode"],
            source="MINIPROGRAM_WAREHOUSE_EDIT", commit=False,
        )
    for field in ("product_name", "model", "spec", "serial_number", "location_code", "condition_grade"):
        if field in data:
            value = (data[field] or "").strip() or None
            if field == "product_name" and not value:
                raise HTTPException(status_code=400, detail="商品名称不能为空")
            setattr(sku, field, value)
    if "images" in data and data["images"] is not None:
        images = _normalize_image_urls(data["images"])
        sku.images = images
        sku.cover_url = images[0] if images else None
    if "location_images" in data and data["location_images"] is not None:
        sku.location_images = _normalize_image_urls(data["location_images"])
    db.commit()
    return sku_detail(new_code, db, user)


@router.post("/skus/{sku_code}/barcode-lookup", summary="查询69码并写入 SPU 商品信息", response_model=SkuDetailOut)
def lookup_sku_barcode(
    sku_code: str,
    body: BarcodeLookupIn | None = None,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    code = normalize_barcode((body.barcode if body else None) or sku.barcode)
    if not code:
        raise HTTPException(status_code=400, detail="该商品还没有 69码，请先编辑填写商品条码")
    spu = query_barcode(code)  # 查不到直接抛 4xx/5xx，前端 toast 提示
    if code != ((sku.barcode or "").strip() or None):
        # 这次顺带换了码：留 BARCODE_SET 痕（SPU 用上面查到的，不重复打付费接口）
        apply_sku_barcode(db, user, sku, barcode=code, source="BARCODE_LOOKUP", commit=False, spu=spu)
    sku.spu = spu
    db.commit()
    return sku_detail(sku_code, db, user)


@router.get("/outbounds", summary="查询出库记录列表", response_model=list[SalesOutboundOut])
def list_outbounds(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    return (
        db.query(SalesOutbound)
        .order_by(SalesOutbound.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )


def _checked_fee(req, outbound_type: str) -> Decimal | None:
    """出库时填的闲鱼实际服务费：自提不收服务费、不记；不能比售价还多。"""
    fee = getattr(req, "platform_fee", None)
    if fee is None or outbound_type == OutboundType.PICKUP:
        return None
    if Decimal(fee) > Decimal(req.sale_price):
        raise HTTPException(status_code=400, detail="服务费比售价还多，核对一下闲鱼订单页上的数")
    return Decimal(fee)


def _do_outbound(db: Session, user: Staff, sku: Sku, req, outbound_type: str) -> SalesOutbound:
    outbound_ok = sku.status == SkuStatus.IN_STOCK or (
        sku.status == SkuStatus.RESERVED and sku.reserve_source == ReserveSource.PLATFORM_SOLD
    ) or (
        sku.status == SkuStatus.RESERVED
        and sku.reserve_source == ReserveSource.SWITCH
        and outbound_type == OutboundType.SWITCH
    )
    if not outbound_ok:
        raise HTTPException(status_code=400, detail="商品不在库或不可出库")
    from app.services.inspection_ops import assert_outbound_reviewed

    review = assert_outbound_reviewed(db, sku, outbound_type)
    order = db.get(PurchaseOrder, sku.purchase_order_id)
    now = datetime.utcnow()
    outbound_no = generate_order_no(db, "OB", SalesOutbound, "outbound_no")
    outbound = SalesOutbound(
        outbound_no=outbound_no,
        sku_id=sku.id,
        sale_order_id=getattr(req, "sale_order_id", None),
        buyer_name=getattr(req, "buyer_name", None),
        outbound_type=outbound_type,
        sale_price=req.sale_price,
        cost_price=sku.cost_price,
        evidence_urls=getattr(req, "evidence_urls", []) or [],
        payment_screenshot_url=getattr(req, "payment_screenshot_url", None),
        express_fee=getattr(req, "express_fee", None),
        worry_free=getattr(req, "worry_free", None),
        platform_fee=_checked_fee(req, outbound_type),
        tracking_no=getattr(req, "tracking_no", None),
        tracking_phone_suffix=normalize_phone_suffix(getattr(req, "tracking_phone_suffix", None)) or None,
        remark=getattr(req, "remark", None),
        operator_id=user.id,
        created_at=now,
    )
    sku.status = SkuStatus.SHIPPED
    sku.reserve_source = None
    sku.outbound_at = now
    sku.short_code = None  # 4 位上架编码出库即回收复用(见 services/short_code.py)
    if order:
        order.status = OrderStatus.SHIPPED
        purchase_pieces.sync_order_status(db, order)  # 一单多件按各件算
    sale_order_id = getattr(req, "sale_order_id", None)
    if sale_order_id:
        sale_order = db.get(SaleOrder, sale_order_id)
        if sale_order:
            sale_order.status = SaleOrderStatus.SHIPPED
            tn = getattr(req, "tracking_no", None)
            if tn:
                sale_order.tracking_no = tn
            ts = getattr(req, "tracking_phone_suffix", None)
            if ts:
                sale_order.tracking_phone_suffix = normalize_phone_suffix(ts) or None
            if sale_order.tracking_no:
                from app.services.logistics_poll import ENTITY_SALE_ORDER, register_poll

                register_poll(
                    db,
                    entity_type=ENTITY_SALE_ORDER,
                    entity_id=sale_order.id,
                    order_no=sale_order.order_no,
                    tracking_no=sale_order.tracking_no,
                    phone_suffix=sale_order.tracking_phone_suffix,
                    shipped_at=now,
                )
    db.add(outbound)
    if review:
        db.flush()
        review.consumed_at = now
        review.outbound_id = outbound.id
    db.add(
        StockEvent(
            purchase_order_id=sku.purchase_order_id,
            sku_id=sku.id,
            event_type=StockEventType.OUTBOUND,
            ref_no=outbound_no,
            operator_id=user.id,
            payload={"type": outbound_type, "sale_price": str(req.sale_price)},
        )
    )
    # OA/台账推送：登记销售统计 + 提成明细（同事务，随调用方 commit 后自动异步投递）
    from app.services import oa_push

    oa_push.on_outbound_created(db, outbound=outbound, purchase_order=order, operator_role=user.role)
    return outbound


@router.post("/outbound/scan", summary="扫码出库", response_model=SalesOutboundOut)
def outbound_scan(
    body: OutboundScanRequest,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    practice.gate(db, user)
    sku = db.query(Sku).filter(Sku.sku_code == body.sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    outbound = _do_outbound(db, user, sku, body, body.outbound_type)
    db.commit()
    db.refresh(outbound)
    stock_lock_delist.after_stock_left(db, sku, reason="扫码出库", operator_id=user.id)
    return outbound


@router.post("/outbound/manual", summary="手动出库", response_model=SalesOutboundOut)
def outbound_manual(
    body: OutboundManualRequest,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    practice.gate(db, user)
    if body.outbound_type == OutboundType.PICKUP and not body.payment_screenshot_url:
        raise HTTPException(status_code=400, detail="自提需上传收款小荷包截图")
    if body.outbound_type == OutboundType.PICKUP and not body.evidence_urls:
        raise HTTPException(status_code=400, detail="自提需上传现场证据图")
    if body.outbound_type == OutboundType.SWITCH and not (body.tracking_no or "").strip():
        raise HTTPException(status_code=400, detail="切单发货需填写运单号")
    if body.outbound_type == OutboundType.SWITCH and not body.evidence_urls:
        raise HTTPException(status_code=400, detail="切单发货需上传成交凭证（图片/视频）")
    sku = db.query(Sku).filter(Sku.sku_code == body.sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    outbound = _do_outbound(db, user, sku, body, body.outbound_type)
    db.commit()
    db.refresh(outbound)
    stock_lock_delist.after_stock_left(db, sku, reason="手动出库", operator_id=user.id)
    return outbound


@router.post("/adjust", summary="登记库存调整")
def adjust(
    body: AdjustRequest,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == body.sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    order = db.get(PurchaseOrder, sku.purchase_order_id)
    adjust_no = generate_order_no(db, "AD", InventoryAdjustment, "adjust_no")
    db.add(
        InventoryAdjustment(
            adjust_no=adjust_no,
            sku_id=sku.id,
            adjust_type=body.adjust_type,
            reason=body.reason,
            operator_id=user.id,
        )
    )
    event_type = StockEventType.LOSS if body.adjust_type == AdjustType.LOSS else StockEventType.OVERFLOW
    if body.adjust_type == AdjustType.LOSS:
        sku.status = SkuStatus.LOSS
        if order:
            order.status = OrderStatus.LOSS
            purchase_pieces.sync_order_status(db, order)  # 一单多件按各件算
    db.add(
        StockEvent(
            purchase_order_id=sku.purchase_order_id,
            sku_id=sku.id,
            event_type=event_type,
            ref_no=adjust_no,
            operator_id=user.id,
        )
    )
    db.commit()
    if body.adjust_type == AdjustType.LOSS:
        stock_lock_delist.after_stock_left(db, sku, reason="报损", operator_id=user.id)
    return {"adjust_no": adjust_no}


def _warehouse_count(db: Session) -> int:
    return db.query(Sku).filter(Sku.status == SkuStatus.IN_STOCK).count()


def _sku_brief(sku: Sku | None, sku_code: str) -> StocktakeSkuBrief:
    if not sku:
        return StocktakeSkuBrief(sku_code=sku_code)
    return StocktakeSkuBrief(
        sku_code=sku.sku_code,
        product_name=sku.product_name,
        spec=sku.spec,
        location_code=sku.location_code,
        status=sku.status,
    )


def _is_rfid_session(db: Session, session: StocktakeSession) -> bool:
    """会话是否由 RFID 设备账号发起（用于仓管可见性判断）。"""
    operator = db.get(Staff, session.operator_id)
    return bool(operator and operator.role == StaffRole.RFID_DEVICE)


def _build_diff(db: Session, scanned_items: list) -> StocktakeDiffOut:
    scanned_codes: list[str] = []
    for item in scanned_items:
        code = (item.get("sku_code") or "").strip().upper()
        if code and code not in scanned_codes:
            scanned_codes.append(code)

    # RFID 标签 EPC 即 sku_code（入库时小程序写入），基准为全部在库货。
    warehouse_skus = db.query(Sku).filter(Sku.status == SkuStatus.IN_STOCK).all()
    warehouse_map = {s.sku_code: s for s in warehouse_skus}
    scanned_set = set(scanned_codes)

    matched: list[StocktakeSkuBrief] = []
    missing: list[StocktakeSkuBrief] = []
    surplus: list[StocktakeSkuBrief] = []

    for sku in warehouse_skus:
        brief = _sku_brief(sku, sku.sku_code)
        if sku.sku_code in scanned_set:
            matched.append(brief)
        else:
            missing.append(brief)

    for code in scanned_codes:
        sku = db.query(Sku).filter(Sku.sku_code == code).first()
        if code not in warehouse_map:
            surplus.append(_sku_brief(sku, code))

    return StocktakeDiffOut(
        warehouse_count=len(warehouse_skus),
        scanned_count=len(scanned_codes),
        matched_count=len(matched),
        matched=matched,
        missing=missing,
        surplus=surplus,
    )


def _attach_covers(db: Session, diff_data: dict | None, scanned_items: list) -> None:
    """按 sku_code 批量补当前商品封面缩略图(就地写入,传入须为副本)。"""
    codes: set[str] = set()
    groups = []
    if diff_data:
        for key in ("matched", "missing", "surplus"):
            groups.append(diff_data.get(key) or [])
    groups.append(scanned_items or [])
    for items in groups:
        for it in items:
            if isinstance(it, dict) and it.get("sku_code"):
                codes.add(it["sku_code"])
    if not codes:
        return
    cover_map = {
        sc: thumb_url_for_cover(cu)
        for sc, cu in db.query(Sku.sku_code, Sku.cover_url).filter(Sku.sku_code.in_(codes)).all()
    }
    for items in groups:
        for it in items:
            if isinstance(it, dict) and it.get("sku_code"):
                it["cover_url"] = cover_map.get(it["sku_code"])


def _session_out(db: Session, session: StocktakeSession) -> StocktakeSessionOut:
    diff = None
    diff_data = copy.deepcopy(session.diff_result) if session.diff_result else None
    scanned = copy.deepcopy(session.scanned_items) if session.scanned_items else []
    _attach_covers(db, diff_data, scanned)
    if diff_data:
        diff = StocktakeDiffOut.model_validate(diff_data)
    proposals = (
        db.query(StocktakeAdjustment)
        .filter(StocktakeAdjustment.session_id == session.id)
        .order_by(StocktakeAdjustment.created_at.asc())
        .all()
    )
    operator = db.get(Staff, session.operator_id)
    return StocktakeSessionOut(
        id=session.id,
        session_no=session.session_no,
        status=session.status,
        scanned_items=scanned,
        warehouse_count=_warehouse_count(db),
        scanned_count=len(scanned),
        started_at=session.started_at,
        paused_at=session.paused_at,
        completed_at=session.completed_at,
        submitted_at=session.submitted_at,
        reviewed_at=session.reviewed_at,
        review_comment=session.review_comment,
        operator_name=operator.name if operator else None,
        diff_result=diff,
        proposals=[StocktakeProposalOut.model_validate(p) for p in proposals],
    )


def _get_counting_session(db: Session, user: Staff) -> StocktakeSession | None:
    return (
        db.query(StocktakeSession)
        .filter(
            StocktakeSession.operator_id == user.id,
            StocktakeSession.status.in_([StocktakeStatus.IN_PROGRESS, StocktakeStatus.PAUSED]),
        )
        .order_by(StocktakeSession.started_at.desc())
        .first()
    )


def _get_open_session(db: Session, user: Staff) -> StocktakeSession | None:
    return (
        db.query(StocktakeSession)
        .filter(
            StocktakeSession.operator_id == user.id,
            StocktakeSession.status.in_(
                [
                    StocktakeStatus.IN_PROGRESS,
                    StocktakeStatus.PAUSED,
                    StocktakeStatus.COMPLETED,
                    StocktakeStatus.PENDING_APPROVAL,
                    StocktakeStatus.REJECTED,
                ]
            ),
        )
        .order_by(StocktakeSession.started_at.desc())
        .first()
    )


def _get_counting_editable_session(db: Session, session_id: str, user: Staff) -> StocktakeSession:
    session = db.get(StocktakeSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="盘点会话不存在")
    if session.operator_id != user.id:
        raise HTTPException(status_code=403, detail="无权操作此盘点会话")
    if session.status in (
        StocktakeStatus.COMPLETED,
        StocktakeStatus.APPROVED,
        StocktakeStatus.PENDING_APPROVAL,
        StocktakeStatus.REJECTED,
    ):
        raise HTTPException(status_code=400, detail="盘点已结束")
    return session


def _get_session(db: Session, session_id: str) -> StocktakeSession:
    session = db.get(StocktakeSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="盘点会话不存在")
    return session


def _can_view_session(session: StocktakeSession, user: Staff, db: Session | None = None) -> bool:
    if user.role == StaffRole.ADMIN:
        return True
    if session.operator_id == user.id:
        return True
    # 仓管可查看 RFID 手持机发起的盘点（设备账号建的会话，便于核对）
    if user.role == StaffRole.WAREHOUSE and db is not None and _is_rfid_session(db, session):
        return True
    return False


def _can_edit_proposals(session: StocktakeSession, user: Staff) -> bool:
    if session.status not in (StocktakeStatus.COMPLETED, StocktakeStatus.REJECTED):
        return False
    return session.operator_id == user.id or user.role == StaffRole.ADMIN


def _get_proposal_editable_session(db: Session, session_id: str, user: Staff) -> StocktakeSession:
    session = _get_session(db, session_id)
    if not _can_edit_proposals(session, user):
        raise HTTPException(status_code=403, detail="当前状态不可编辑处理方案")
    return session


def _upsert_proposal(
    db: Session,
    session: StocktakeSession,
    user: Staff,
    body: StocktakeProposalIn,
) -> StocktakeAdjustment:
    sku_code = body.sku_code.strip().upper()
    if not sku_code:
        raise HTTPException(status_code=400, detail="货号不能为空")

    existing = (
        db.query(StocktakeAdjustment)
        .filter(
            StocktakeAdjustment.session_id == session.id,
            StocktakeAdjustment.sku_code == sku_code,
            StocktakeAdjustment.status.in_(
                [
                    StocktakeProposalStatus.PROPOSED,
                    StocktakeProposalStatus.REJECTED,
                    StocktakeProposalStatus.SKIPPED,
                ]
            ),
        )
        .first()
    )
    if existing and existing.status == StocktakeProposalStatus.PENDING:
        raise HTTPException(status_code=400, detail="该货号已提交审批，无法修改")

    if body.adjust_type is None:
        adjust_type = None
        status = StocktakeProposalStatus.SKIPPED
    else:
        adjust_type = body.adjust_type
        status = StocktakeProposalStatus.PROPOSED
        if body.diff_type == StocktakeDiffType.MISSING and adjust_type != AdjustType.LOSS:
            raise HTTPException(status_code=400, detail="盘亏仅支持报损")
        if body.diff_type == StocktakeDiffType.SURPLUS and adjust_type != AdjustType.OVERFLOW:
            raise HTTPException(status_code=400, detail="盘盈仅支持盈出入库")

    if existing:
        existing.adjust_type = adjust_type
        existing.reason = body.reason
        existing.status = status
        existing.review_comment = None
        existing.reviewer_id = None
        existing.reviewed_at = None
        return existing

    row = StocktakeAdjustment(
        session_id=session.id,
        sku_code=sku_code,
        diff_type=body.diff_type,
        adjust_type=adjust_type,
        reason=body.reason,
        status=status,
        operator_id=user.id,
    )
    db.add(row)
    return row


@router.get("/stocktake/active", summary="查询当前盘点会话", response_model=StocktakeSessionOut | None)
def stocktake_active(
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    session = _get_open_session(db, user)
    if not session:
        return None
    return _session_out(db, session)


@router.get("/stocktake", summary="查询盘点会话列表", response_model=list[StocktakeListItem])
def stocktake_list(
    status: str | None = None,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    query = db.query(StocktakeSession)
    if user.role != StaffRole.ADMIN:
        # 仓管：可见自己的会话 + 所有 RFID 手持机发起的盘点
        device_ids = [
            row[0]
            for row in db.query(Staff.id)
            .filter(Staff.role == StaffRole.RFID_DEVICE, Staff.deleted_at.is_(None))
            .all()
        ]
        if device_ids:
            query = query.filter(
                or_(
                    StocktakeSession.operator_id == user.id,
                    StocktakeSession.operator_id.in_(device_ids),
                )
            )
        else:
            query = query.filter(StocktakeSession.operator_id == user.id)
    if status:
        query = query.filter(StocktakeSession.status == status)
    sessions = query.order_by(StocktakeSession.started_at.desc()).limit(50).all()
    items: list[StocktakeListItem] = []
    for session in sessions:
        diff = session.diff_result or {}
        operator = db.get(Staff, session.operator_id)
        items.append(
            StocktakeListItem(
                id=session.id,
                session_no=session.session_no,
                status=session.status,
                operator_name=operator.name if operator else None,
                scanned_count=len(session.scanned_items or []),
                missing_count=len(diff.get("missing") or []),
                surplus_count=len(diff.get("surplus") or []),
                started_at=session.started_at,
                completed_at=session.completed_at,
                submitted_at=session.submitted_at,
            )
        )
    return items


@router.get("/stocktake/{session_id}", summary="查询盘点会话详情", response_model=StocktakeSessionOut)
def stocktake_detail(
    session_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    session = _get_session(db, session_id)
    if not _can_view_session(session, user, db):
        raise HTTPException(status_code=403, detail="无权查看此盘点")
    return _session_out(db, session)


@router.post("/stocktake/start", summary="开始盘点", response_model=StocktakeSessionOut)
def stocktake_start(
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN, StaffRole.RFID_DEVICE)),
):
    existing = _get_open_session(db, user)
    if existing:
        if existing.status == StocktakeStatus.PAUSED:
            existing.status = StocktakeStatus.IN_PROGRESS
            existing.paused_at = None
            db.commit()
            db.refresh(existing)
        return _session_out(db, existing)

    session_no = generate_order_no(db, "ST", StocktakeSession, "session_no")
    session = StocktakeSession(
        session_no=session_no,
        status=StocktakeStatus.IN_PROGRESS,
        operator_id=user.id,
        scanned_items=[],
        started_at=datetime.utcnow(),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


@router.post("/stocktake/{session_id}/items", summary="录入盘点商品", response_model=StocktakeSessionOut)
def stocktake_add_item(
    session_id: str,
    body: StocktakeItemIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    session = _get_counting_editable_session(db, session_id, user)
    if session.status == StocktakeStatus.PAUSED:
        raise HTTPException(status_code=400, detail="盘点已暂停，请先继续盘点")

    sku_code = body.sku_code.strip().upper()
    if not sku_code:
        raise HTTPException(status_code=400, detail="货号不能为空")

    items = list(session.scanned_items or [])
    if any(i.get("sku_code") == sku_code for i in items):
        raise HTTPException(status_code=400, detail="该货号已盘点")

    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    items.append(
        {
            "sku_code": sku_code,
            "product_name": sku.product_name if sku else None,
            "spec": sku.spec if sku else None,
            "location_code": sku.location_code if sku else None,
            "source": body.source,
            "scanned_at": utc_to_cn_iso(datetime.utcnow()),
        }
    )
    session.scanned_items = items
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


@router.post("/stocktake/{session_id}/pause", summary="暂停盘点", response_model=StocktakeSessionOut)
def stocktake_pause(
    session_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    session = _get_counting_editable_session(db, session_id, user)
    if session.status != StocktakeStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail="当前状态无法暂停")
    session.status = StocktakeStatus.PAUSED
    session.paused_at = datetime.utcnow()
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


@router.post("/stocktake/{session_id}/resume", summary="继续盘点", response_model=StocktakeSessionOut)
def stocktake_resume(
    session_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    session = _get_counting_editable_session(db, session_id, user)
    if session.status != StocktakeStatus.PAUSED:
        raise HTTPException(status_code=400, detail="当前状态无法继续")
    session.status = StocktakeStatus.IN_PROGRESS
    session.paused_at = None
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


@router.post("/stocktake/{session_id}/complete", summary="完成盘点比对", response_model=StocktakeSessionOut)
def stocktake_complete(
    session_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN, StaffRole.RFID_DEVICE)),
):
    session = _get_counting_editable_session(db, session_id, user)
    diff = _build_diff(db, session.scanned_items or [])
    session.completed_at = datetime.utcnow()
    session.paused_at = None
    session.diff_result = diff.model_dump()
    if not diff.missing and not diff.surplus:
        session.status = StocktakeStatus.APPROVED
    else:
        session.status = StocktakeStatus.COMPLETED
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


@router.post("/stocktake/{session_id}/proposals", summary="提交盘点差异方案", response_model=StocktakeSessionOut)
def stocktake_propose(
    session_id: str,
    body: StocktakeProposalIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    session = _get_proposal_editable_session(db, session_id, user)
    _upsert_proposal(db, session, user, body)
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


@router.post("/stocktake/{session_id}/proposals/auto", summary="自动生成盘点方案", response_model=StocktakeSessionOut)
def stocktake_auto_propose(
    session_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    session = _get_proposal_editable_session(db, session_id, user)
    diff = session.diff_result or {}
    for item in diff.get("missing") or []:
        _upsert_proposal(
            db,
            session,
            user,
            StocktakeProposalIn(
                sku_code=item["sku_code"],
                diff_type=StocktakeDiffType.MISSING,
                adjust_type=AdjustType.LOSS,
                reason="盘点盘亏，申请报损",
            ),
        )
    for item in diff.get("surplus") or []:
        sku = db.query(Sku).filter(Sku.sku_code == item["sku_code"]).first()
        if not sku:
            _upsert_proposal(
                db,
                session,
                user,
                StocktakeProposalIn(
                    sku_code=item["sku_code"],
                    diff_type=StocktakeDiffType.SURPLUS,
                    adjust_type=None,
                    reason="系统中无此货号记录",
                ),
            )
            continue
        _upsert_proposal(
            db,
            session,
            user,
            StocktakeProposalIn(
                sku_code=item["sku_code"],
                diff_type=StocktakeDiffType.SURPLUS,
                adjust_type=AdjustType.OVERFLOW,
                reason="盘点盘盈，申请盈出入库",
            ),
        )
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


@router.post("/stocktake/{session_id}/submit", summary="盘点提交审核", response_model=StocktakeSessionOut)
def stocktake_submit(
    session_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    session = _get_proposal_editable_session(db, session_id, user)
    if session.operator_id != user.id and user.role != StaffRole.ADMIN:
        raise HTTPException(status_code=403, detail="仅操作员可提交审批")

    proposals = (
        db.query(StocktakeAdjustment)
        .filter(
            StocktakeAdjustment.session_id == session.id,
            StocktakeAdjustment.status == StocktakeProposalStatus.PROPOSED,
        )
        .all()
    )
    if not proposals:
        raise HTTPException(status_code=400, detail="请先为差异商品选择处理方式")

    diff = session.diff_result or {}
    diff_codes = {i["sku_code"] for i in (diff.get("missing") or []) + (diff.get("surplus") or [])}
    handled = {p.sku_code for p in proposals} | {
        p.sku_code
        for p in db.query(StocktakeAdjustment)
        .filter(
            StocktakeAdjustment.session_id == session.id,
            StocktakeAdjustment.status == StocktakeProposalStatus.SKIPPED,
        )
        .all()
    }
    unhandled = diff_codes - handled
    if unhandled:
        raise HTTPException(status_code=400, detail=f"还有 {len(unhandled)} 条差异未处理")

    now = datetime.utcnow()
    for proposal in proposals:
        proposal.status = StocktakeProposalStatus.PENDING
    session.status = StocktakeStatus.PENDING_APPROVAL
    session.submitted_at = now
    session.review_comment = None
    session.reviewer_id = None
    session.reviewed_at = None
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


@router.post("/stocktake/{session_id}/approve", summary="审核通过盘点", response_model=StocktakeSessionOut)
def stocktake_approve(
    session_id: str,
    body: StocktakeReviewIn | None = None,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    session = _get_session(db, session_id)
    if session.status != StocktakeStatus.PENDING_APPROVAL:
        raise HTTPException(status_code=400, detail="当前状态不可审批")

    proposals = (
        db.query(StocktakeAdjustment)
        .filter(
            StocktakeAdjustment.session_id == session.id,
            StocktakeAdjustment.status == StocktakeProposalStatus.PENDING,
        )
        .all()
    )
    now = datetime.utcnow()
    comment = body.comment if body else None
    for proposal in proposals:
        adjust_no = apply_inventory_adjustment(
            db,
            user,
            proposal.sku_code,
            proposal.adjust_type,
            proposal.reason,
        )
        proposal.status = StocktakeProposalStatus.APPLIED
        proposal.adjust_no = adjust_no
        proposal.reviewer_id = user.id
        proposal.reviewed_at = now
        proposal.review_comment = comment

    session.status = StocktakeStatus.APPROVED
    session.reviewer_id = user.id
    session.reviewed_at = now
    session.review_comment = comment
    db.commit()
    for proposal in proposals:
        if proposal.adjust_type == AdjustType.LOSS:
            lost = db.query(Sku).filter(Sku.sku_code == proposal.sku_code).first()
            stock_lock_delist.after_stock_left(db, lost, reason="盘点报损", operator_id=user.id)
    db.refresh(session)
    return _session_out(db, session)


@router.post("/stocktake/{session_id}/reject", summary="驳回盘点审核", response_model=StocktakeSessionOut)
def stocktake_reject(
    session_id: str,
    body: StocktakeReviewIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    session = _get_session(db, session_id)
    if session.status != StocktakeStatus.PENDING_APPROVAL:
        raise HTTPException(status_code=400, detail="当前状态不可驳回")

    now = datetime.utcnow()
    proposals = (
        db.query(StocktakeAdjustment)
        .filter(
            StocktakeAdjustment.session_id == session.id,
            StocktakeAdjustment.status == StocktakeProposalStatus.PENDING,
        )
        .all()
    )
    for proposal in proposals:
        proposal.status = StocktakeProposalStatus.REJECTED
        proposal.reviewer_id = user.id
        proposal.reviewed_at = now
        proposal.review_comment = body.comment

    session.status = StocktakeStatus.REJECTED
    session.reviewer_id = user.id
    session.reviewed_at = now
    session.review_comment = body.comment
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


# ==================== RFID 手持机（PDA）：盘读 ====================
# 标签 EPC 即商品 sku_code（入库时小程序扫码写入），无需绑定步骤。

_RFID_ROLES = (StaffRole.RFID_DEVICE, StaffRole.WAREHOUSE, StaffRole.ADMIN)


@router.post("/stocktake/{session_id}/scan-rfid", summary="RFID 批量盘读", response_model=RfidScanResult)
def stocktake_scan_rfid(
    session_id: str,
    body: RfidScanIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_RFID_ROLES)),
):
    """PDA 批量盘读：上传一批 EPC（即 sku_code），后端去重计入当前盘点会话。
    返回新增件数、累计件数、以及系统中查不到的 EPC（外来/无效标签）。"""
    session = _get_counting_editable_session(db, session_id, user)
    if session.status == StocktakeStatus.PAUSED:
        raise HTTPException(status_code=400, detail="盘点已暂停，请先继续盘点")

    items = list(session.scanned_items or [])
    existing_codes = {i.get("sku_code") for i in items}
    unresolved: list[str] = []
    added = 0
    seen: set[str] = set()
    now = utc_to_cn_iso(datetime.utcnow())

    for raw in body.epcs or []:
        epc = (raw or "").strip().upper()
        if not epc or epc in seen:
            continue
        seen.add(epc)
        # EPC 即 sku_code，直接按货号匹配（MySQL 大小写不敏感）
        sku = db.query(Sku).filter(Sku.sku_code == epc).first()
        if not sku:
            unresolved.append(epc)
            continue
        if sku.sku_code in existing_codes:
            continue
        existing_codes.add(sku.sku_code)
        items.append({
            "sku_code": sku.sku_code,
            "product_name": sku.product_name,
            "spec": sku.spec,
            "location_code": sku.location_code,
            "source": "RFID",
            "epc": epc,
            "scanned_at": now,
        })
        added += 1

    session.scanned_items = items
    db.commit()
    db.refresh(session)
    return RfidScanResult(
        added_count=added,
        scanned_count=len(items),
        unresolved=unresolved,
        session=_session_out(db, session),
    )


# ==================== 条码迁移：改码（覆盖商品货号/条形码）====================
# 核心改码逻辑统一沉到 app/services/sku_recode.py，旧 RFID 接口与新货号更换接口共用，
# 确保所有冗余 sku_code 的表（Sku/ReturnOrder/AiRedrawJob/StocktakeAdjustment/PickupPayment）一并同步。

_SKU_MIGRATION_ROLES = (StaffRole.WAREHOUSE, StaffRole.ADMIN)


@router.post("/skus/recode", summary="更改商品货号", response_model=RecodeOut)
def sku_recode(
    body: RecodeIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_RFID_ROLES)),
):
    """把商品的旧货号(sku_code)整体改成新货号——用于把旧条形码迁移成新条形码。"""
    old = (body.old_sku_code or "").strip().upper()
    new = (body.new_sku_code or "").strip().upper()
    sku, _ = recode_sku(db, user, old_sku_code=old, new_sku_code=new, source="RFID_RECODE")
    return RecodeOut(
        old_sku_code=old, new_sku_code=sku.sku_code, product_name=sku.product_name,
        spec=sku.spec, location_code=sku.location_code, status=sku.status,
    )


# ==================== 货号更换（小程序仓库页：旧货号 → 51321154 新货号）====================


@router.get("/sku-migration/items", summary="查询货号更换列表", response_model=SkuMigrationListResponse)
def list_sku_migration_items(
    tab: str = Query("pending"),
    q: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_SKU_MIGRATION_ROLES)),
):
    """待更换/已更换列表：仅在库范围，按货号是否以 51321154 前缀开头分流。"""
    if tab not in ("pending", "done"):
        raise HTTPException(status_code=400, detail="tab 仅支持 pending 或 done")

    query = db.query(Sku).filter(Sku.status.in_(_SKU_MIGRATION_SCOPED_STATUSES))
    if tab == "pending":
        query = query.filter(~Sku.sku_code.like(f"{_SKU_MIGRATION_PREFIX}%"))
    else:
        query = query.filter(Sku.sku_code.like(f"{_SKU_MIGRATION_PREFIX}%"))

    if q and q.strip():
        # 多关键词模糊：每个词都要命中某字段（词间 AND、字段间 OR）
        for term in q.split():
            like = f"%{term}%"
            query = query.filter(
                (Sku.sku_code.like(like))
                | (Sku.product_name.like(like))
                | (Sku.brand.like(like))
                | (Sku.model.like(like))
                | (Sku.spec.like(like))
                | (Sku.location_code.like(like))
            )

    total = query.count()
    rows = (
        query.order_by(Sku.inbound_at.desc(), Sku.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    sku_ids = [row.id for row in rows]
    last_event_map = load_last_recode_event_map(db, sku_ids)
    operator_names = map_staff_names(
        db,
        {event.operator_id for event in last_event_map.values() if event.operator_id},
    )

    items = [
        SkuMigrationItem(
            id=sku.id,
            sku_code=sku.sku_code,
            product_name=sku.product_name,
            spec=sku.spec,
            location_code=sku.location_code,
            status=sku.status,
            migration_status=_sku_migration_status(sku.sku_code),
            can_migrate=_sku_migration_status(sku.sku_code) == "PENDING",
            inbound_at=sku.inbound_at,
            last_recode_at=last_event_map[sku.id].created_at if sku.id in last_event_map else None,
            last_recode_operator_name=(
                operator_names.get(last_event_map[sku.id].operator_id)
                if sku.id in last_event_map and last_event_map[sku.id].operator_id
                else None
            ),
            last_recode_source=(
                _recode_source_label(last_event_map[sku.id].payload)
                if sku.id in last_event_map
                else None
            ),
        )
        for sku in rows
    ]
    return SkuMigrationListResponse(items=items, total=total, page=page, size=size)


@router.post("/sku-migration/recode", summary="更换单件货号", response_model=SkuMigrationRecodeOut)
def sku_migration_recode(
    body: SkuMigrationRecodeIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_SKU_MIGRATION_ROLES)),
):
    """单件货号更换：新货号必须以 51321154 开头，且商品须在库。"""
    old_code = (body.old_sku_code or "").strip().upper()
    new_code = (body.new_sku_code or "").strip().upper()
    if not new_code.startswith(_SKU_MIGRATION_PREFIX):
        raise HTTPException(status_code=400, detail=f"新货号必须以 {_SKU_MIGRATION_PREFIX} 开头")
    sku = db.query(Sku).filter(Sku.sku_code == old_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="未查到该条码对应的商品")
    if sku.status not in _SKU_MIGRATION_SCOPED_STATUSES:
        raise HTTPException(status_code=400, detail="仅支持在库或锁单商品进行货号更换")

    sku, event = recode_sku(
        db, user, old_sku_code=old_code, new_sku_code=new_code, source=_SKU_MIGRATION_SOURCE
    )
    last_event = event or load_last_recode_event_map(db, [sku.id]).get(sku.id)
    operator_names = map_staff_names(
        db, {last_event.operator_id} if last_event and last_event.operator_id else set()
    )
    return SkuMigrationRecodeOut(
        old_sku_code=old_code,
        new_sku_code=sku.sku_code,
        product_name=sku.product_name,
        spec=sku.spec,
        location_code=sku.location_code,
        status=sku.status,
        migration_status=_sku_migration_status(sku.sku_code),
        last_recode_at=last_event.created_at if last_event else None,
        last_recode_operator_name=(
            operator_names.get(last_event.operator_id)
            if last_event and last_event.operator_id
            else None
        ),
        last_recode_source=_recode_source_label(last_event.payload) if last_event else None,
    )


# ==================== 69码更换（小程序仓库页：空/错 69码 → 新 69码）====================
# 与货号更换同构：pending = 在库但 69码为空，done = 已有 69码（可再更换纠错）。
# 领域逻辑在 app/services/barcode.py，编辑页改 69码走的是同一个 apply_sku_barcode。


def _barcode_migration_item(sku: Sku, event, operator_names: dict[str, str]) -> BarcodeMigrationItem:
    payload = event.payload if event else None
    return BarcodeMigrationItem(
        id=sku.id,
        sku_code=sku.sku_code,
        product_name=sku.product_name,
        spec=sku.spec,
        location_code=sku.location_code,
        status=sku.status,
        barcode=sku.barcode,
        spu_text=spu_text(sku.spu),
        migration_status=barcode_status(sku.barcode),
        can_migrate=sku.status in _SKU_MIGRATION_SCOPED_STATUSES,
        inbound_at=sku.inbound_at,
        last_barcode_at=event.created_at if event else None,
        last_barcode_operator_name=(
            operator_names.get(event.operator_id) if event and event.operator_id else None
        ),
        last_barcode_source=barcode_source_label(payload),
        last_barcode_old=(payload or {}).get("old"),
    )


@router.get("/barcode-migration/items", summary="查询69码更换列表（待更换/已更换/未查到）", response_model=BarcodeMigrationListResponse)
def list_barcode_migration_items(
    tab: str = Query("pending"),
    q: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_SKU_MIGRATION_ROLES)),
):
    """仅在库范围，三个互斥分桶（每台只会出现在其中一个 Tab）：

    pending=没 69码 / done=有码且条码库查到了 SPU / missing=有码但条码库没查到。
    missing 单独成桶是因为它需要的动作不同——多半重查一次就能补上，不必重录码。
    """
    if tab not in ("pending", "done", "missing"):
        raise HTTPException(status_code=400, detail="tab 仅支持 pending / done / missing")

    query = db.query(Sku).filter(Sku.status.in_(_SKU_MIGRATION_SCOPED_STATUSES))
    empty_barcode = (Sku.barcode.is_(None)) | (Sku.barcode == "")
    if tab == "pending":
        query = query.filter(empty_barcode)
    elif tab == "done":
        query = query.filter(~empty_barcode, Sku.spu.isnot(None))
    else:
        query = query.filter(~empty_barcode, Sku.spu.is_(None))

    if q and q.strip():
        # 多关键词模糊：每个词都要命中某字段（词间 AND、字段间 OR）
        for term in q.split():
            like = f"%{term}%"
            query = query.filter(
                (Sku.sku_code.like(like))
                | (Sku.barcode.like(like))
                | (Sku.product_name.like(like))
                | (Sku.brand.like(like))
                | (Sku.model.like(like))
                | (Sku.spec.like(like))
                | (Sku.location_code.like(like))
            )

    total = query.count()
    rows = (
        query.order_by(Sku.inbound_at.desc(), Sku.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    last_event_map = load_last_barcode_event_map(db, [row.id for row in rows])
    operator_names = map_staff_names(
        db,
        {event.operator_id for event in last_event_map.values() if event.operator_id},
    )
    items = [
        _barcode_migration_item(sku, last_event_map.get(sku.id), operator_names)
        for sku in rows
    ]
    return BarcodeMigrationListResponse(items=items, total=total, page=page, size=size)


@router.post("/barcode-migration/recode", summary="更换单件69码", response_model=BarcodeMigrationItem)
def barcode_migration_recode(
    body: BarcodeMigrationIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_SKU_MIGRATION_ROLES)),
):
    """单件 69码 录入/更换：商品须在库，新码 8/12/13/14 位数字，写码后自动查一次条码库。"""
    sku_code = (body.sku_code or "").strip().upper()
    new_code = normalize_barcode(body.barcode)
    if not new_code:
        raise HTTPException(status_code=400, detail="69码不能为空")
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="未查到该货号对应的商品")
    if sku.status not in _SKU_MIGRATION_SCOPED_STATUSES:
        raise HTTPException(status_code=400, detail="仅支持在库或锁单商品更换 69码")

    event = apply_sku_barcode(
        db, user, sku, barcode=new_code, source=BARCODE_MIGRATION_SOURCE
    )
    if event is None:
        # 与旧码相同：不留痕，直接回显最近一次历史
        event = load_last_barcode_event_map(db, [sku.id]).get(sku.id)
    operator_names = map_staff_names(
        db, {event.operator_id} if event and event.operator_id else set()
    )
    return _barcode_migration_item(sku, event, operator_names)
