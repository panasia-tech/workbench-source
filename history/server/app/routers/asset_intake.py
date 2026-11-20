"""资产录入：所有员工把别的系统里的电脑、显示器手工录成在库商品，拿来变卖。

录完直接在库、免议价、上架信息已填好，出现在群控中心的待上架里，由有上架权限的人
（仓管/销售/管理员）看一眼再点一键上架——录入本身不发布，录错的价格不会直接挂到所有真店。
也不进自动上架流水线：流水线会把员工填的售价改成行情价。

库位选填：只有仓管知道库位，其他岗位留空，仓管之后在商品编辑页补。
员工看、改自己录的，管理员看全部；还没上架前能改，上架后改价走群控中心。
录入不算采购，录入人不拿提成（见 services/asset_intake.py）。
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import ListingInfoStatus, ReserveSource, ShopListingStatus, SkuStatus, StaffRole
from app.models import AssetIntake, PurchaseOrder, Sku, SkuListingInfo, SkuShopListing, Staff
from app.schemas.asset_intake import (
    AssetIntakeIn,
    AssetIntakeListItem,
    AssetIntakeListResponse,
    AssetIntakeOut,
    AssetIntakeResult,
)
from app.services import asset_intake as intake
from app.services.manual_sku import create_in_stock_sku, normalize_image_urls
from app.services.order_no import generate_sku_code
from app.services.oss_media import first_non_video_url, sign_media_payload, strip_oss_signature
from app.services.short_code import ensure_short_code
from app.services.staff_lookup import map_staff_names

router = APIRouter(prefix="/api/asset-intake", tags=["asset-intake"])

# 所有员工账号都能录（管理员 require_roles 默认放行）；RFID 手持、爬虫、行情机这类设备账号不行
_STAFF = require_roles(
    StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.NEGOTIATOR, StaffRole.SALES, StaffRole.FINANCE,
)
# 能直接点上架的岗位，与 /api/listing 发布接口的放行口径一致
_CAN_PUBLISH = (StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)
# 上架图上限（与 listing.save_listing 的 [:9] 对齐）
MAX_IMAGES = 9


def _clean(body: AssetIntakeIn) -> dict:
    """校验并整理表单。不合格直接 400，文案是给录入的员工看的。"""

    def text(v: str | None) -> str:
        return (v or "").strip()

    brand, model = text(body.brand), text(body.model)
    if not brand or not model:
        raise HTTPException(status_code=400, detail="请填写品牌和型号")
    product_type = text(body.product_type)
    if not product_type:
        raise HTTPException(status_code=400, detail="请选择商品类型")
    serial_number = text(body.serial_number)
    if not serial_number:
        raise HTTPException(status_code=400, detail="请填写序列号")
    condition_grade = text(body.condition_grade)
    if not condition_grade:
        raise HTTPException(status_code=400, detail="请选择成色")
    if body.price is None or body.price <= 0:
        raise HTTPException(status_code=400, detail="售价必须大于 0")
    images = normalize_image_urls(body.images or [])[:MAX_IMAGES]
    if not images:
        raise HTTPException(status_code=400, detail="至少传 1 张商品实拍图")
    return {
        "product_type": product_type,
        "brand": brand,
        "model": model,
        "product_name": f"{brand} {model}",
        "spec": text(body.spec) or None,
        "serial_number": serial_number,
        "condition_grade": condition_grade,
        "price": body.price,
        "express_fee": body.express_fee,
        "images": images,
        "desc": text(body.desc) or None,
        "cost_price": body.cost_price,
        "source_asset_no": text(body.source_asset_no) or None,
        "location_code": text(body.location_code) or None,
        "remark": text(body.remark) or None,
    }


def _check_serial(db: Session, serial_number: str, *, exclude_sku_id: str | None = None) -> None:
    """同一序列号还在我们手上（在库/锁定）就拦下：多半是两个人录了同一台。"""
    q = db.query(Sku).filter(
        Sku.serial_number == serial_number,
        Sku.status.in_((SkuStatus.IN_STOCK, SkuStatus.RESERVED)),
    )
    if exclude_sku_id:
        q = q.filter(Sku.id != exclude_sku_id)
    dup = q.first()
    if dup:
        raise HTTPException(
            status_code=400, detail=f"序列号 {serial_number} 已经在库里了（货号 {dup.sku_code}），不能重复录"
        )


def _check_source(
    db: Session, source_asset_no: str | None, allow: bool, *, exclude_id: str | None = None
) -> None:
    """来源编号录过就 409，前端问一句，确认是另一台后带 allow_duplicate_source 重提。"""
    if not source_asset_no or allow:
        return
    q = (
        db.query(AssetIntake, Sku)
        .join(Sku, AssetIntake.sku_id == Sku.id)
        .filter(AssetIntake.source_asset_no == source_asset_no)
    )
    if exclude_id:
        q = q.filter(AssetIntake.id != exclude_id)
    row = q.first()
    if row:
        prev, sku = row
        who = map_staff_names(db, {prev.entered_by_id}).get(prev.entered_by_id) or "别人"
        raise HTTPException(
            status_code=409,
            detail=f"来源编号 {source_asset_no} 已经录过：货号 {sku.sku_code}（{who}录的）。确定是另一台再继续。",
        )


def _po_remark(remark: str | None) -> str:
    return f"资产录入{'：' + remark if remark else ''}"


def _apply_listing(info: SkuListingInfo, f: dict) -> None:
    """群控发布只读图、售价、运费、保底文案；标题由闲鱼 AI 写，这里填品名只是给列表页看。"""
    info.title = f["product_name"]
    info.desc = f["desc"]
    info.price = f["price"]
    info.express_fee = f["express_fee"]
    # 存干净原始 URL，不存短效签名（与 listing.save_listing 同一口径）
    info.images = [strip_oss_signature(u) for u in f["images"]]
    info.status = ListingInfoStatus.READY


def _shop_counts(db: Session, sku_ids: list[str]) -> dict[str, dict[str, int]]:
    """{sku_id: {店铺上架状态: 店铺数}}，一次查完整页。"""
    out: dict[str, dict[str, int]] = {}
    if not sku_ids:
        return out
    for sid, status, cnt in (
        db.query(SkuShopListing.sku_id, SkuShopListing.publish_status, func.count())
        .filter(SkuShopListing.sku_id.in_(sku_ids))
        .group_by(SkuShopListing.sku_id, SkuShopListing.publish_status)
        .all()
    ):
        out.setdefault(sid, {})[status] = cnt
    return out


def _status(sku: Sku, info: SkuListingInfo | None, shops: dict[str, int]) -> tuple[str, str, bool]:
    """(状态, 文案, 还能不能改)。只有还没发出去的才能改；发过的改价走群控中心。"""
    if sku.status == SkuStatus.SHIPPED:
        return "sold", "已售出", False
    if sku.status == SkuStatus.RESERVED:
        if sku.reserve_source == ReserveSource.PLATFORM_SOLD:
            return "to_ship", "待发货", False
        return "locked", "已锁定", False
    if sku.status == SkuStatus.LOSS:
        return "loss", "已报损", False
    if sku.status == SkuStatus.SPLIT:
        return "split", "已拆分", False
    if shops.get(ShopListingStatus.LISTED, 0):
        return "on_sale", "在售", False
    in_progress = shops.get(ShopListingStatus.PENDING, 0) + shops.get(ShopListingStatus.LISTING, 0)
    if in_progress or (info is not None and info.status == ListingInfoStatus.PUBLISHING):
        return "listing", "上架中", False
    editable = not shops.get(ShopListingStatus.SOLD, 0) and (
        info is None
        or info.status in (ListingInfoStatus.DRAFT, ListingInfoStatus.READY, ListingInfoStatus.FAILED)
    )
    return "pending", "待上架", editable


def _item(row: AssetIntake, sku: Sku, info: SkuListingInfo | None, shops: dict[str, int], names: dict) -> dict:
    status, label, editable = _status(sku, info, shops)
    return {
        "sku_code": sku.sku_code,
        "product_name": sku.product_name,
        "spec": sku.spec,
        "serial_number": sku.serial_number,
        "source_asset_no": row.source_asset_no,
        "price": info.price if info else None,
        # 只签图片字段：自由文本不进 sign_media_payload
        "cover_url": sign_media_payload(sku.cover_url),
        "status": status,
        "status_label": label,
        "editable": editable,
        "entered_by_name": names.get(row.entered_by_id),
        "created_at": row.created_at,
    }


def _detail(db: Session, row: AssetIntake, sku: Sku) -> AssetIntakeOut:
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    shops = _shop_counts(db, [sku.id]).get(sku.id, {})
    names = map_staff_names(db, {row.entered_by_id})
    images = (info.images if info and info.images else None) or sku.images or []
    return AssetIntakeOut(
        **_item(row, sku, info, shops, names),
        product_type=sku.product_type,
        brand=sku.brand,
        model=sku.model,
        condition_grade=sku.condition_grade,
        express_fee=info.express_fee if info else None,
        images=sign_media_payload(list(images)),
        desc=info.desc if info else None,
        cost_price=sku.cost_price,
        location_code=sku.location_code,
        remark=row.remark,
    )


def _owned(db: Session, user: Staff, sku_code: str) -> tuple[AssetIntake, Sku]:
    """员工只能看/改自己录的，管理员看全部；别人的一律当不存在。"""
    found = (
        db.query(AssetIntake, Sku)
        .join(Sku, AssetIntake.sku_id == Sku.id)
        .filter(Sku.sku_code == sku_code)
        .first()
    )
    if not found or (user.role != StaffRole.ADMIN and found[0].entered_by_id != user.id):
        raise HTTPException(status_code=404, detail="录入记录不存在")
    return found


@router.post("", summary="录入一台资产（直接在库、进待上架）", response_model=AssetIntakeResult)
def create_intake(
    body: AssetIntakeIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(_STAFF),
):
    f = _clean(body)
    _check_serial(db, f["serial_number"])
    _check_source(db, f["source_asset_no"], body.allow_duplicate_source)

    now = datetime.utcnow()
    sku, _po = create_in_stock_sku(
        db,
        user,
        source=intake.SOURCE,
        po_prefix=intake.PO_PREFIX,
        inspect_prefix=intake.INSPECT_PREFIX,
        # 录入不是验货：不挂验货人，不算任何人的验货计件
        inspector_id=None,
        sku_code=generate_sku_code(db),
        product_name=f["product_name"],
        brand=f["brand"],
        model=f["model"],
        spec=f["spec"],
        serial_number=f["serial_number"],
        barcode=None,
        location_code=f["location_code"],
        condition_grade=f["condition_grade"],
        product_type=f["product_type"],
        cost_price=f["cost_price"],
        images=f["images"],
        location_images=[],
        inbound_at=now,
        po_remark=_po_remark(f["remark"]),
        negotiation_remark="资产录入免议价",
        event_payload={"source_asset_no": f["source_asset_no"]},
    )
    info = SkuListingInfo(sku_id=sku.id, created_by_id=user.id)
    _apply_listing(info, f)
    db.add(info)
    # 上架短编码：进入上架流程即分配（与保存上架信息同口径）
    ensure_short_code(db, sku)
    db.add(
        AssetIntake(
            sku_id=sku.id,
            source_asset_no=f["source_asset_no"],
            remark=f["remark"],
            entered_by_id=user.id,
            created_at=now,
        )
    )
    db.commit()
    return AssetIntakeResult(sku_code=sku.sku_code, can_publish=user.role in _CAN_PUBLISH)


@router.get("", summary="我录入的资产（管理员看全部）", response_model=AssetIntakeListResponse)
def list_intakes(
    q: str | None = Query(None, description="序列号 / 型号 / 货号 / 来源编号，空格分词"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(_STAFF),
):
    query = db.query(AssetIntake, Sku).join(Sku, AssetIntake.sku_id == Sku.id)
    if user.role != StaffRole.ADMIN:
        query = query.filter(AssetIntake.entered_by_id == user.id)
    for term in (q or "").split():
        like = f"%{term}%"
        query = query.filter(
            Sku.sku_code.like(like)
            | Sku.serial_number.like(like)
            | Sku.product_name.like(like)
            | Sku.spec.like(like)
            | AssetIntake.source_asset_no.like(like)
        )
    total = query.count()
    rows = (
        query.order_by(AssetIntake.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    sku_ids = [sku.id for _, sku in rows]
    infos = {
        info.sku_id: info
        for info in db.query(SkuListingInfo).filter(SkuListingInfo.sku_id.in_(sku_ids)).all()
    } if sku_ids else {}
    shops = _shop_counts(db, sku_ids)
    names = map_staff_names(db, {row.entered_by_id for row, _ in rows})
    items = [
        AssetIntakeListItem(**_item(row, sku, infos.get(sku.id), shops.get(sku.id, {}), names))
        for row, sku in rows
    ]
    return AssetIntakeListResponse(items=items, total=total, page=page, size=size)


@router.get("/{sku_code}", summary="录入详情", response_model=AssetIntakeOut)
def get_intake(
    sku_code: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(_STAFF),
):
    row, sku = _owned(db, user, sku_code)
    return _detail(db, row, sku)


@router.put("/{sku_code}", summary="修改还没上架的录入", response_model=AssetIntakeOut)
def update_intake(
    sku_code: str,
    body: AssetIntakeIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(_STAFF),
):
    row, sku = _owned(db, user, sku_code)
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    _, _, editable = _status(sku, info, _shop_counts(db, [sku.id]).get(sku.id, {}))
    if not editable:
        raise HTTPException(status_code=400, detail="这件货已经上架了，改价格或图片请到群控中心")
    f = _clean(body)
    _check_serial(db, f["serial_number"], exclude_sku_id=sku.id)
    if f["source_asset_no"] != row.source_asset_no:
        _check_source(db, f["source_asset_no"], body.allow_duplicate_source, exclude_id=row.id)

    sku.product_name = f["product_name"]
    sku.brand = f["brand"]
    sku.model = f["model"]
    sku.spec = f["spec"]
    sku.serial_number = f["serial_number"]
    sku.condition_grade = f["condition_grade"]
    sku.product_type = f["product_type"]
    sku.location_code = f["location_code"]
    sku.cost_price = f["cost_price"]
    sku.suggest_price = f["cost_price"]
    sku.images = f["images"]
    sku.cover_url = first_non_video_url(f["images"]) or f["images"][0]
    # 占位采购单跟着改，后台按采购单看时品名/成本对得上
    po = db.get(PurchaseOrder, sku.purchase_order_id)
    if po is not None:
        po.product_name = f["product_name"]
        po.brand = f["brand"]
        po.model = f["model"]
        po.spec = f["spec"]
        po.unit_price = f["cost_price"]
        po.product_images = f["images"]
        po.remark = _po_remark(f["remark"])
    if info is None:
        info = SkuListingInfo(sku_id=sku.id, created_by_id=user.id)
        db.add(info)
    _apply_listing(info, f)
    row.source_asset_no = f["source_asset_no"]
    row.remark = f["remark"]
    db.commit()
    return _detail(db, row, sku)
