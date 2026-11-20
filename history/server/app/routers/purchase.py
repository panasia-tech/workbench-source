import io
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import condition_scan, export_xlsx
from app.deps import get_current_user, require_roles
from app.enums import OrderStatus, StaffRole, StockEventType
from app.models import (
    BargainSession,
    EventLog,
    Inspection,
    PurchaseItemSnapshot,
    PurchaseOrder,
    SalesOutbound,
    Sku,
    Staff,
    StockEvent,
)
from app.services.app_config import is_valid_purchase_account
from app.services.asset_intake import not_asset_intake_po
from app.schemas._tz import utc_to_cn
from app.schemas.purchase import (
    PurchaseChangeField,
    PurchaseChangeListResponse,
    PurchaseChangeOut,
    PurchaseListResponse,
    PurchaseOrderCreate,
    PurchaseOrderOut,
    PurchaseOrderUpdate,
    PurchasePiecesMissingIn,
    PurchaseQuantityIn,
    PurchaseSnapshotIn,
    PurchaseSnapshotOut,
)
from app.services.order_no import calc_suggest_price, generate_order_no
from app.services.query_filters import parse_date_range
from app.services.oss_media import first_image_list_urls, sign_media_payload
from app.services.express import (
    detect_overdue_by_express,
    get_cached_tracking,
    normalize_phone_suffix,
)
from app.services import bargain as bargain_svc
from app.services import purchase_pieces, purchase_snapshot as snap
from app.services import purchase_platform as platform_svc
from app.services import purchase_price as price_svc
from app.services.staff_lookup import map_staff_names
router = APIRouter(prefix="/api/purchase", tags=["purchase"])

PURCHASE_UPDATE_EVENT = "PURCHASE_ORDER_UPDATE"

# 可编辑业务字段 → 中文标签（用于变更留痕展示），顺序即展示顺序
PURCHASE_FIELD_LABELS: dict[str, str] = {
    "brand": "品牌",
    "model": "型号",
    "spec": "规格",
    "unit_price": "成交金额",
    "quantity": "件数",
    "external_order_no": "闲鱼订单号",
    "transaction_no": "交易流水号",
    "tracking_no": "物流单号",
    "tracking_phone_suffix": "顺丰手机后四位",
    "order_time": "下单时间",
    "paid_at": "付款时间",
    "purchase_account": "采购账号",
    "seller_name": "卖家昵称",
    "remark": "备注",
    "product_images": "商品图",
    "attachments": "附件",
    "screenshot_url": "闲鱼截图1",
    "screenshot_url_2": "闲鱼截图2",
    "is_overdue": "逾期采购",
    "condition_warning": "货况警示",
}


def compose_product_name(brand: str, model: str) -> str:
    parts = [p.strip() for p in (brand, model) if p and p.strip()]
    return " ".join(parts)


# 顺丰单（单号以 SF 开头）默认收/寄件人手机后四位，便于直接查物流
SF_DEFAULT_PHONE_SUFFIX = "5080"


def default_phone_suffix(tracking_no: str | None, phone_suffix: str) -> str:
    """已填后四位则原样返回；未填且为顺丰单（SF 开头）时默认 5080。"""
    if phone_suffix:
        return phone_suffix
    if (tracking_no or "").strip().upper().startswith("SF"):
        return SF_DEFAULT_PHONE_SUFFIX
    return phone_suffix


def _diff_repr(value) -> str | None:
    """把字段值转成可读、可存 JSON 的字符串，用于前后值对比。"""
    if value is None:
        return None
    if isinstance(value, list):
        return "、".join(str(v) for v in value) if value else ""
    if isinstance(value, datetime):
        return utc_to_cn(value).strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


def _purchase_out(
    order: PurchaseOrder,
    names: dict[str, str],
    db: Session,
    *,
    for_list: bool = False,
) -> PurchaseOrderOut:
    data = PurchaseOrderOut.model_validate(order).model_dump()
    data["operator_name"] = names.get(order.created_by_id)
    # 资产编号：仅详情回填，列表不查关系避免 N+1
    data["asset_no"] = None
    if not for_list and getattr(order, "asset_device", None):
        data["asset_no"] = order.asset_device.asset_no
    if for_list:
        data.update(first_image_list_urls(order.product_images))
        data["product_images"] = []
    cached = None
    if order.tracking_no:
        cached = get_cached_tracking(db, order.tracking_no, phone_suffix=order.tracking_phone_suffix or "")
    # 物流轨迹/备注等自由文本不能进 sign_media_payload（会被误当成 OSS 路径签名），签完媒体再挂上
    signed = sign_media_payload(data)
    if cached:
        signed["express_tracking"] = cached
    return PurchaseOrderOut(**signed)


@router.post("/orders", response_model=PurchaseOrderOut, summary="创建采购单")
def create_order(
    body: PurchaseOrderCreate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.ADMIN)),
):
    if not is_valid_purchase_account(db, body.purchase_account):
        raise HTTPException(status_code=400, detail="采购账号无效或已停用")
    product_images = [u for u in body.product_images if u][:9]
    if not product_images:
        raise HTTPException(status_code=400, detail="至少上传 1 张商品图")
    attachments = [u for u in body.attachments if u]
    brand = body.brand.strip()
    model = body.model.strip()
    if not brand:
        raise HTTPException(status_code=400, detail="请填写品牌")
    if not model:
        raise HTTPException(status_code=400, detail="请填写型号")

    # 按订单号去重：同 external_order_no 已存在采购单则拒绝，需前端二次确认后置 allow_duplicate 放行（兼容一单多件）
    ext_no = (body.external_order_no or "").strip()
    if ext_no and not body.allow_duplicate:
        existing = (
            db.query(PurchaseOrder)
            .filter(PurchaseOrder.external_order_no == ext_no)
            .order_by(PurchaseOrder.created_at)
            .all()
        )
        if existing:
            names = "、".join(
                f"{o.order_no}（{(o.product_name or '')[:16]}）" for o in existing[:5]
            )
            raise HTTPException(
                status_code=409,
                detail=f"该订单号已存在 {len(existing)} 张采购单：{names}。若确属同一订单的另一件商品，请确认后再创建。",
            )

    order_no = generate_order_no(db, "PO", PurchaseOrder, "order_no")
    payload = body.model_dump()
    payload.pop("allow_duplicate", None)
    # 快照 / 议价字段不进采购单表
    snap_id = payload.pop("snapshot_id", None)
    bargain_id = payload.pop("bargain_session_id", None)
    platform_order_id = payload.pop("platform_order_id", None)
    price_rule_id = payload.pop("price_rule_id", None)
    snap_fields = {
        "platform_item_id": payload.pop("platform_item_id", None),
        "source_url": payload.pop("source_url", None),
        "title": payload.pop("snapshot_title", None),
        "description": payload.pop("snapshot_description", None),
        "condition_text": payload.pop("snapshot_condition", None),
        "accessories_text": payload.pop("snapshot_accessories", None),
        "listed_price": payload.pop("snapshot_listed_price", None),
    }
    quantity = payload.pop("quantity", 1) or 1
    if quantity < 1 or quantity > purchase_pieces.MAX_PIECES:
        raise HTTPException(status_code=400, detail=f"件数要在 1 到 {purchase_pieces.MAX_PIECES} 之间")
    payload["brand"] = brand
    payload["model"] = model
    payload["product_name"] = compose_product_name(brand, model)
    payload["product_images"] = product_images
    payload["attachments"] = attachments
    suffix = normalize_phone_suffix(body.tracking_phone_suffix)
    suffix = default_phone_suffix(body.tracking_no, suffix)
    payload["tracking_phone_suffix"] = suffix or None
    # 提交时查一次物流：快件最新轨迹已到浙江省内 → 标记逾期采购（不发放基础提成）
    is_overdue = detect_overdue_by_express(body.tracking_no, phone_suffix=suffix or "")
    order = PurchaseOrder(
        order_no=order_no,
        status=OrderStatus.PENDING_INSPECT,
        created_by_id=user.id,
        is_overdue=is_overdue,
        quantity=quantity,
        **payload,
    )
    db.add(order)
    db.flush()
    # 每件一张验货单，分几次到也能各验各的
    purchase_pieces.add_pieces(db, order, 1, quantity)
    db.add(
        StockEvent(
            purchase_order_id=order.id,
            event_type=StockEventType.PURCHASE,
            ref_no=order_no,
            operator_id=user.id,
        )
    )
    # W04：建单时落/绑商品快照并冻结（Copilot 议价对照底座）
    if snap_id:
        snap.attach_to_order(db, snap_id, order, user.id)
        snap.freeze_latest(db, order.id)
    elif snap_fields["platform_item_id"] or snap_fields["source_url"]:
        # 没有商品 ID / 链接就不建：原来每张单都建一份「无商品ID · 已冻结」的快照，之后想补也补不了
        snap.create_version(
            db,
            purchase_order_id=order.id,
            user_id=user.id,
            seller_name=body.seller_name,
            images=product_images,
            freeze=True,
            **{k: v for k, v in snap_fields.items() if v is not None},
        )
    # W10：从平台订单一键建的直接挂上；手填的按订单号 + 采购号找抓回来的那单
    platform_svc.bind_new_order(db, user, order, platform_order_id)
    # W06：锁住下单时那一版公司价
    price_svc.lock_for_order(db, order, price_rule_id)
    # W07：谈妥会话绑采购单；未谈妥则按成交价推进到 DEAL 再绑
    if bargain_id:
        session = db.get(BargainSession, bargain_id)
        if session is None:
            raise HTTPException(status_code=400, detail="议价会话不存在")
        if session.state != "DEAL":
            bargain_svc.transition(
                db, session, action="deal", price=body.unit_price, note="建采购单时确认谈妥", user_id=user.id,
            )
        bargain_svc.bind_purchase(db, session, order.id, strict=False)
    db.commit()
    db.refresh(order)
    # 投递到受控扫描池：OCR 实拍图，命中「全新/几乎全新」回填货况警示（不阻塞提交，洪峰自动排队/丢弃）
    condition_scan.enqueue(order.id, list(product_images))
    return _purchase_out(order, {user.id: user.name}, db)


def _orders_query(
    db: Session,
    user: Staff,
    status: str | None,
    q: str | None,
    date_from: str | None,
    date_to: str | None,
):
    """采购单列表/导出共用的筛选查询，保证两边口径一致。"""
    # 资产录入的占位单不是采购，谁的采购记录里都不该有
    query = db.query(PurchaseOrder).filter(not_asset_intake_po())
    if user.role != StaffRole.ADMIN:
        query = query.filter(PurchaseOrder.created_by_id == user.id)
    if status:
        query = query.filter(PurchaseOrder.status == status)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (PurchaseOrder.order_no.like(like))
            | (PurchaseOrder.external_order_no.like(like))
            | (PurchaseOrder.transaction_no.like(like))
            | (PurchaseOrder.tracking_no.like(like))
            | (PurchaseOrder.product_name.like(like))
            | (PurchaseOrder.brand.like(like))
            | (PurchaseOrder.model.like(like))
            | (PurchaseOrder.seller_name.like(like))
        )
    start, end = parse_date_range(date_from, date_to)
    if start:
        query = query.filter(PurchaseOrder.created_at >= start)
    if end:
        query = query.filter(PurchaseOrder.created_at < end)
    return query


def _unnegotiated_order_ids(db: Session, order_ids: list[str]) -> set[str]:
    """已入库但从未议价的采购单 id 集合。

    判定与议价待办一致（Sku.negotiated_at 为空、排除 LEGACY_IMPORT 老库存占位），
    但不限 SKU 当前状态：已出库仍未议价的照样算——审计视角看「漏议价」，
    而待办只关心还堵在库里的（IN_STOCK）。
    """
    if not order_ids:
        return set()
    rows = (
        db.query(Sku.purchase_order_id)
        .filter(
            Sku.purchase_order_id.in_(order_ids),
            Sku.negotiated_at.is_(None),
            # coalesce 兜底 tags 为 NULL 的行（JSON_CONTAINS(NULL,..) 返回 NULL，会误排除）
            func.coalesce(func.JSON_CONTAINS(Sku.tags, func.JSON_QUOTE("LEGACY_IMPORT")), 0) == 0,
        )
        .all()
    )
    return {r[0] for r in rows}


@router.get("/orders", response_model=PurchaseListResponse, summary="采购单列表")
def list_orders(
    status: str | None = None,
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    query = _orders_query(db, user, status, q, date_from, date_to)
    total = query.count()
    orders = (
        query.order_by(PurchaseOrder.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    names = map_staff_names(db, {o.created_by_id for o in orders})
    unnegotiated = _unnegotiated_order_ids(db, [o.id for o in orders])
    items = [_purchase_out(o, names, db, for_list=True) for o in orders]
    for item in items:
        item.is_unnegotiated = item.id in unnegotiated
    return PurchaseListResponse(items=items, total=total, page=page, size=size)


@router.get("/orders/export", summary="导出采购单")
def export_orders(
    status: str | None = None,
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """导出当前筛选条件下的全部采购记录（xlsx），仅管理员。"""
    query = _orders_query(db, user, status, q, date_from, date_to)
    total = query.count()
    if total > export_xlsx.EXPORT_MAX_ROWS:
        raise HTTPException(
            status_code=400,
            detail=f"待导出 {total} 条超过上限 {export_xlsx.EXPORT_MAX_ROWS} 条，请缩小日期范围",
        )
    orders = query.order_by(PurchaseOrder.created_at.desc()).all()
    names = map_staff_names(db, {o.created_by_id for o in orders})
    unnegotiated = _unnegotiated_order_ids(db, [o.id for o in orders])
    content = export_xlsx.build_purchase_export(orders, names, unnegotiated)
    return StreamingResponse(
        io.BytesIO(content),
        media_type=export_xlsx.XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": 'attachment; filename="purchase_orders.xlsx"'},
    )


@router.get("/orders/{order_id}", response_model=PurchaseOrderOut, summary="采购单详情")
def get_order(order_id: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    order = db.get(PurchaseOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    if user.role != StaffRole.ADMIN and order.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="无权查看")
    names = map_staff_names(db, {order.created_by_id})
    out = _purchase_out(order, names, db)
    out.is_unnegotiated = order.id in _unnegotiated_order_ids(db, [order.id])
    return out


@router.put("/orders/{order_id}", response_model=PurchaseOrderOut, summary="编辑采购单")
def update_order(
    order_id: str,
    body: PurchaseOrderUpdate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.ADMIN)),
):
    """编辑历史采购单的业务字段。采购员只能改自己创建的单，管理员可改任意单。
    所有字段级变更写入 event_log；改成交金额会联动回写未议价商品的成本价。"""
    order = db.get(PurchaseOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    if user.role != StaffRole.ADMIN and order.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="无权编辑")

    fields = body.model_dump(exclude_unset=True)

    # 归一化文本/列表字段
    for key in ("brand", "model", "spec", "external_order_no", "transaction_no",
                "tracking_no", "purchase_account", "seller_name", "remark"):
        if key in fields and fields[key] is not None:
            fields[key] = fields[key].strip()
    if "product_images" in fields:
        fields["product_images"] = [u for u in (fields["product_images"] or []) if u][:9]
        if not fields["product_images"]:
            raise HTTPException(status_code=400, detail="至少保留 1 张商品图")
    if "attachments" in fields:
        fields["attachments"] = [u for u in (fields["attachments"] or []) if u]
    if "tracking_phone_suffix" in fields:
        fields["tracking_phone_suffix"] = normalize_phone_suffix(fields["tracking_phone_suffix"]) or None

    if "purchase_account" in fields and not is_valid_purchase_account(db, fields["purchase_account"]):
        raise HTTPException(status_code=400, detail="采购账号无效或已停用")

    # 品牌/型号变动后重算 product_name，避免与展示名脱节
    new_brand = fields.get("brand", order.brand)
    new_model = fields.get("model", order.model)
    if ("brand" in fields or "model" in fields):
        product_name = compose_product_name(new_brand or "", new_model or "")
        if not product_name:
            raise HTTPException(status_code=400, detail="品牌与型号不能同时为空")

    # 计算字段级 diff，并落实改动（按值比较：Decimal/datetime 数值相等即视为未变）
    changes: list[dict] = []
    price_changed = False
    for key, new_value in fields.items():
        old_value = getattr(order, key)
        if old_value == new_value:
            continue
        setattr(order, key, new_value)
        if key == "unit_price":
            price_changed = True
        changes.append({
            "field": key,
            "label": PURCHASE_FIELD_LABELS.get(key, key),
            "old": _diff_repr(old_value),
            "new": _diff_repr(new_value),
        })

    if not changes:
        names = map_staff_names(db, {order.created_by_id})
        return _purchase_out(order, names, db)

    if "brand" in fields or "model" in fields:
        order.product_name = compose_product_name(new_brand or "", new_model or "")

    # 改成交金额：联动回写未议价（actual_amount 为空）商品的成本价
    cost_synced = False
    if price_changed:
        # 一单多件按件均摊；软删的占位验货单也照旧同步（老单 SKU 可能挂在它上面）
        pieces = db.query(Inspection).filter(Inspection.purchase_order_id == order.id).all()
        for inspection in pieces:
            sku = db.query(Sku).filter(Sku.inspection_id == inspection.id).first()
            if sku and inspection.actual_amount is None:
                old_cost = sku.cost_price
                new_cost = purchase_pieces.piece_cost(order, inspection.piece_no)
                sku.cost_price = new_cost
                sku.suggest_price = Decimal(
                    str(calc_suggest_price(float(new_cost), sku.condition_grade))
                )
                db.add(
                    StockEvent(
                        purchase_order_id=order.id,
                        sku_id=sku.id,
                        event_type=StockEventType.INSPECT,
                        ref_no=order.order_no,
                        operator_id=user.id,
                        payload={
                            "action": "purchase_unit_price_edit",
                            "old_cost_price": _diff_repr(old_cost),
                            "new_cost_price": _diff_repr(new_cost),
                        },
                    )
                )
                cost_synced = True

    db.add(
        EventLog(
            event_type=PURCHASE_UPDATE_EVENT,
            entity_type="purchase_order",
            entity_id=order.id,
            operator_id=user.id,
            occurred_at=datetime.utcnow(),
            payload={"changes": changes, "cost_synced": cost_synced},
        )
    )
    db.commit()
    db.refresh(order)
    # 实拍图变更 → 重扫货况警示（命中/取消「全新」都会刷新）
    if any(c["field"] == "product_images" for c in changes):
        condition_scan.enqueue(order.id, list(order.product_images or []))
    names = map_staff_names(db, {order.created_by_id})
    return _purchase_out(order, names, db)


PURCHASE_DELETE_EVENT = "PURCHASE_ORDER_DELETE"


@router.delete("/orders/{order_id}", status_code=204, summary="删除采购单")
def delete_order(
    order_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """删除采购单（仅管理员）。仅允许删除尚未验货（PENDING_INSPECT）的单——
    一旦验货生成 SKU/库存，删除会破坏库存与财务对账，此时拒绝。
    连同占位验货单、库存事件、修改记录一并清理，并留一条删除审计日志。"""
    order = db.get(PurchaseOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    if order.status != OrderStatus.PENDING_INSPECT or db.query(Sku.id).filter(Sku.purchase_order_id == order.id).first():
        raise HTTPException(
            status_code=400,
            detail="该采购单已验货入库，不能删除；如需作废请走库存/财务流程",
        )

    order_no = order.order_no
    db.query(StockEvent).filter(StockEvent.purchase_order_id == order.id).delete(
        synchronize_session=False
    )
    db.query(Inspection).filter(Inspection.purchase_order_id == order.id).delete(
        synchronize_session=False
    )
    db.query(EventLog).filter(
        EventLog.entity_type == "purchase_order",
        EventLog.entity_id == order.id,
    ).delete(synchronize_session=False)
    db.delete(order)
    db.add(
        EventLog(
            event_type=PURCHASE_DELETE_EVENT,
            entity_type="purchase_order",
            entity_id=order_id,
            operator_id=user.id,
            occurred_at=datetime.utcnow(),
            payload={"order_no": order_no},
        )
    )
    db.commit()


@router.get("/orders/{order_id}/changes", response_model=PurchaseChangeListResponse, summary="采购单修改记录")
def list_order_changes(
    order_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """采购单修改记录（仅管理后台可见）。"""
    order = db.get(PurchaseOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    logs = (
        db.query(EventLog)
        .filter(
            EventLog.event_type == PURCHASE_UPDATE_EVENT,
            EventLog.entity_type == "purchase_order",
            EventLog.entity_id == order_id,
        )
        .order_by(EventLog.created_at.desc())
        .all()
    )
    names = map_staff_names(db, {log.operator_id for log in logs})
    items = []
    for log in logs:
        payload = log.payload or {}
        changes = [PurchaseChangeField(**c) for c in payload.get("changes", [])]
        items.append(
            PurchaseChangeOut(
                id=log.id,
                operator_id=log.operator_id,
                operator_name=names.get(log.operator_id),
                changes=changes,
                cost_synced=bool(payload.get("cost_synced")),
                created_at=log.created_at,
            )
        )
    return PurchaseChangeListResponse(items=items, total=len(items))


# ---------- 一单多件、分次到货（禅道 WH01-04） ----------


def _piece_order(db: Session, order_id: str, user: Staff) -> PurchaseOrder:
    order = db.get(PurchaseOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    if user.role == StaffRole.PURCHASER and order.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="无权查看")
    return order


_PIECE_ROLES = (StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.ADMIN)


@router.get("/orders/{order_id}/pieces", summary="这张采购单每件的到货与验货情况")
def list_pieces(order_id: str, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_PIECE_ROLES))):
    return purchase_pieces.pieces_out(db, _piece_order(db, order_id, user))


@router.put("/orders/{order_id}/quantity", summary="改件数（一件都还没验时）")
def set_quantity(
    order_id: str,
    body: PurchaseQuantityIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_PIECE_ROLES)),
):
    order = _piece_order(db, order_id, user)
    old = purchase_pieces.set_quantity(db, order, body.quantity)
    if old != body.quantity:
        db.add(EventLog(
            event_type=PURCHASE_UPDATE_EVENT, entity_type="purchase_order", entity_id=order.id,
            operator_id=user.id, occurred_at=datetime.utcnow(),
            payload={"changes": [{"field": "quantity", "label": "件数", "old": str(old), "new": str(body.quantity)}],
                     "cost_synced": False},
        ))
    db.commit()
    return purchase_pieces.pieces_out(db, order)


@router.post("/orders/{order_id}/pieces/{piece_no}/missing", summary="标记这件没到货：关掉这件，按这件金额跟退款")
def mark_piece_missing(
    order_id: str,
    piece_no: int,
    body: PurchasePiecesMissingIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_PIECE_ROLES)),
    background: BackgroundTasks = None,
):
    order = _piece_order(db, order_id, user)
    if (order.quantity or 1) <= 1:
        raise HTTPException(status_code=400, detail="一单一件的采购单没到货请走拒签或取消")
    task = next((t for t in purchase_pieces.tasks_of(db, order) if t.piece_no == piece_no), None)
    if not task:
        raise HTTPException(status_code=404, detail="没有这一件")
    purchase_pieces.mark_missing(db, order, task, body.reason, user.id)
    db.commit()
    if background is not None:  # 直接调函数（单测）时没有
        from app.services import inspection_ops as ops

        background.add_task(ops.deliver_in_background)
    return purchase_pieces.pieces_out(db, order)


# ---------- 商品快照（W04 / 采购 Copilot 底座） ----------


_SNAP_ROLES = (StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)


@router.post("/snapshots", response_model=PurchaseSnapshotOut, summary="保存商品快照（可先不绑采购单）")
def save_snapshot(
    body: PurchaseSnapshotIn,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_SNAP_ROLES)),
):
    if body.purchase_order_id:
        _piece_order(db, body.purchase_order_id, user)
    row = snap.create_version(
        db,
        purchase_order_id=body.purchase_order_id,
        user_id=user.id,
        platform=body.platform,
        platform_item_id=body.platform_item_id,
        source_url=body.source_url,
        title=body.title,
        description=body.description,
        condition_text=body.condition_text,
        accessories_text=body.accessories_text,
        listed_price=body.listed_price,
        seller_name=body.seller_name,
        images=body.images,
        raw_payload=body.raw_payload,
        capture_status=body.capture_status,
        capture_error=body.capture_error,
        freeze=body.freeze,
        declared_model=body.declared_model,
        specs=body.specs,
        capture_kind=body.capture_kind,
        videos=body.videos,
        reports=body.reports,
    )
    db.commit()
    db.refresh(row)
    background.add_task(_archive_in_background)
    return PurchaseSnapshotOut(**snap.snapshot_out(row))


def _archive_in_background() -> None:
    """快照里外面的原图 / 视频转存到我们图床（自己开会话，不占请求）。"""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        snap.archive_pending(db)
    finally:
        db.close()


@router.post("/snapshots/{snapshot_id}/archive", response_model=PurchaseSnapshotOut, summary="原图没存上的再存一次")
def archive_snapshot(
    snapshot_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_SNAP_ROLES)),
):
    row = db.get(PurchaseItemSnapshot, snapshot_id)
    if row is None:
        raise HTTPException(status_code=404, detail="快照不存在")
    if row.purchase_order_id:
        _piece_order(db, row.purchase_order_id, user)
    snap.archive_media(row)
    db.commit()
    db.refresh(row)
    return PurchaseSnapshotOut(**snap.snapshot_out(row))


@router.get("/orders/{order_id}/snapshots", summary="采购单的商品快照版本（新→旧）")
def list_order_snapshots(
    order_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_SNAP_ROLES)),
):
    order = _piece_order(db, order_id, user)
    rows = snap.for_order(db, order)
    return {"items": [PurchaseSnapshotOut(**snap.snapshot_out(r)) for r in rows], "total": len(rows)}


@router.post("/orders/{order_id}/snapshots/freeze", response_model=PurchaseSnapshotOut, summary="冻结最新快照（下单后）")
def freeze_order_snapshot(
    order_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_SNAP_ROLES)),
):
    _piece_order(db, order_id, user)
    row = snap.freeze_latest(db, order_id)
    if row is None:
        raise HTTPException(status_code=404, detail="这张采购单还没有商品快照")
    db.commit()
    db.refresh(row)
    return PurchaseSnapshotOut(**snap.snapshot_out(row))
