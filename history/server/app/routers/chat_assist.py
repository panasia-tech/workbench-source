"""聊天页「+」面板：SKU 槽（同款在库货按成色分槽）、某件货能发给买家的实拍、自提地址。

买家聊的闲鱼链接对应一件货（群控按标题 / 价格对上，回给前端 listing_sku）。同一款（SPU）
往往还有别的成色在库：客服按成色点开，看实拍，挑图片和视频发给买家。
所以实拍只出**能给买家看的**：库位照、议价 / 改派取证、订单截图一律不出——和群控发布前的
拦截规则一致（groupcontrol-server/app/publish_spec.py），群控收到要发的图时还会再拦一遍。
"""
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import ShopListingStatus, SkuStatus, StaffRole
from app.models import Inspection, Sku, SkuListingInfo, SkuShopListing, Staff, WarehouseSpu
from app.schemas.chat_assist import (
    ChatItemFactsOut,
    MediaOut,
    PickupAddressIn,
    PickupAddressOut,
    SkuMediaOut,
    SkuSlotsOut,
    SlotItemOut,
    SlotOut,
    SpuBriefOut,
)
from app.services.app_settings import PICKUP_ADDRESS, set_setting
from app.services.condition_slot import SLOTS, UNGRADED, grade_of, slot_of
from app.services.oss_media import (
    is_oss_url_unavailable,
    is_video_url,
    sign_oss_thumb_url,
    sign_oss_url,
    sign_video_poster_url,
)
from app.services.spu_resolve import resolve_spu

router = APIRouter(prefix="/api/chat-assist", tags=["chat-assist"])

# 和群控聊天接口同一拨人（groupcontrol-server/app/auth.py 的 CHAT_ROLES），ADMIN 由 require_roles 放行
_chat_user = require_roles(StaffRole.PURCHASER, StaffRole.SALES)

MAX_SLOT_ITEMS = 20
# 解析同款时最多看这么多件候选（每件要跑一次 SPU 解析）
MAX_CANDIDATES = 200

# 不能给买家看的：订单截图、库位照、议价 / 改派取证（同群控 publish_spec._FORBIDDEN_IMG_MARKERS）
_PRIVATE_MARKERS = ("_order_", "/location", "location_images", "negotiat", "redispatch")


def buyer_safe(url) -> bool:
    if not isinstance(url, str) or not url.strip() or is_oss_url_unavailable(url):
        return False
    path = urlparse(url).path.lower()
    return not any(m in path for m in _PRIVATE_MARKERS)


def buyer_media_urls(db: Session, sku: Sku) -> list[str]:
    """能发给买家的实拍原始 URL：封面 + 商品图（验货时可能混着视频）+ 验货瑕疵视频，去重保序。"""
    urls: list[str] = [sku.cover_url, *(sku.images or [])]
    insp = db.get(Inspection, sku.inspection_id) if sku.inspection_id else None
    if insp is not None:
        urls += insp.defect_videos or []
    seen: set[str] = set()
    out: list[str] = []
    for u in urls:
        if not buyer_safe(u):
            continue
        k = urlparse(u).path
        if k in seen:
            continue
        seen.add(k)
        out.append(u)
    return out


def _cover(db: Session, sku: Sku) -> str | None:
    for u in buyer_media_urls(db, sku):
        if not is_video_url(u):
            return sign_oss_thumb_url(u, size="medium")
    return None


def _find_base_sku(db: Session, sku_code: str | None, q: str | None) -> Sku | None:
    if sku_code:
        return db.query(Sku).filter(func.lower(Sku.sku_code) == sku_code.strip().lower()).first()
    text = (q or "").strip()
    if not text:
        return None
    code = text.lstrip("#")
    if code.isdigit() and len(code) <= 4:
        # 上架编码是在库货在用的号，出库会回收复用——只认还在库的
        row = (
            db.query(Sku)
            .filter(Sku.short_code == code.zfill(4), Sku.status.in_((SkuStatus.IN_STOCK, SkuStatus.RESERVED)))
            .first()
        )
        if row is not None:
            return row
    row = db.query(Sku).filter(func.lower(Sku.sku_code) == code.lower()).first()
    if row is not None:
        return row
    return (
        db.query(Sku)
        .filter(Sku.barcode == code)
        .order_by((Sku.status == SkuStatus.IN_STOCK).desc())
        .first()
    )


def _find_spu_by_text(db: Session, q: str) -> WarehouseSpu | None:
    text = q.strip()
    if len(text) < 2:
        return None
    rows = (
        db.query(WarehouseSpu)
        .filter(
            WarehouseSpu.enabled.is_(True),
            or_(func.lower(WarehouseSpu.spu_code) == text.lower(), WarehouseSpu.model.ilike(f"%{text}%")),
        )
        .order_by(WarehouseSpu.spu_code)
        .all()
    )
    return rows[0] if rows else None


def _same_spu_in_stock(db: Session, spu: WarehouseSpu | None, base: Sku | None) -> list[Sku]:
    """同款在库货。解析得到 SPU 就按 SPU 认（和自动上架同一套解析）；解析不到只能按同 69 码 / 同型号凑。"""
    q = db.query(Sku).filter(Sku.status == SkuStatus.IN_STOCK)
    if spu is not None:
        conds = [func.lower(Sku.barcode) == spu.spu_code.lower()]
        if spu.model:
            conds.append(func.lower(Sku.model) == spu.model.lower())
        cands = q.filter(or_(*conds)).limit(MAX_CANDIDATES).all()
        rows = []
        for s in cands:
            m = resolve_spu(db, s)
            if m.spu is not None and m.spu.id == spu.id:
                rows.append(s)
    else:
        conds = []
        if base is not None and base.barcode:
            conds.append(Sku.barcode == base.barcode)
        if base is not None and base.model:
            conds.append(func.lower(Sku.model) == base.model.lower())
        rows = q.filter(or_(*conds)).limit(MAX_CANDIDATES).all() if conds else []
    if base is not None and base.status == SkuStatus.IN_STOCK and all(r.id != base.id for r in rows):
        rows.append(base)
    return rows


def _item_facts(sku: Sku, info: SkuListingInfo | None) -> ChatItemFactsOut:
    tags: list[str] = []
    if sku.location_code:
        tags.append(f"库位 {sku.location_code}")
    if sku.short_code:
        tags.append(f"#{sku.short_code}")
    if info is not None and info.express_fee is not None:
        tags.append("包邮" if info.express_fee == 0 else f"运费{info.express_fee:g}元")
    tags += [t for t in (sku.tags or []) if isinstance(t, str) and t.strip()][:3]
    return ChatItemFactsOut(sku_code=sku.sku_code, grade=grade_of(sku, info), tags=tags)


@router.get("/slots", summary="SKU 槽：同款在库货按成色分槽", response_model=SkuSlotsOut)
def sku_slots(
    sku: str | None = Query(None, description="会话对上的那件货的货号（群控回的 listing_sku）"),
    q: str | None = Query(None, description="人工输入：货号 / 上架编码 / 69 码 / 型号"),
    db: Session = Depends(get_db),
    _: Staff = Depends(_chat_user),
):
    base = _find_base_sku(db, sku, q)
    spu = resolve_spu(db, base).spu if base is not None else None
    if base is None and q:
        spu = _find_spu_by_text(db, q)
    if base is None and spu is None:
        raise HTTPException(status_code=404, detail="没找到这件货，换个货号、上架编码或型号试试")

    rows = _same_spu_in_stock(db, spu, base)
    ids = [r.id for r in rows] + ([base.id] if base is not None else [])
    infos = {
        i.sku_id: i
        for i in db.query(SkuListingInfo).filter(SkuListingInfo.sku_id.in_(ids)).all()
    } if ids else {}

    buckets: dict[str, list[Sku]] = {key: [] for key, _ in SLOTS}
    buckets[UNGRADED[0]] = []
    # 会话那件排最前，其余按入库时间新的在前
    rows.sort(key=lambda r: (base is None or r.id != base.id, -(r.inbound_at.timestamp() if r.inbound_at else 0)))
    for r in rows:
        buckets[slot_of(grade_of(r, infos.get(r.id)))].append(r)

    slots: list[SlotOut] = []
    for key, label in (*SLOTS, UNGRADED):
        group = buckets[key]
        if key == UNGRADED[0] and not group:
            continue
        items = [
            SlotItemOut(
                sku_id=r.id,
                sku_code=r.sku_code,
                short_code=r.short_code,
                grade=grade_of(r, infos.get(r.id)),
                location_code=r.location_code,
                cover=_cover(db, r),
            )
            for r in group[:MAX_SLOT_ITEMS]
        ]
        slots.append(SlotOut(
            key=key, label=label, count=len(group),
            cover=items[0].cover if items else None, items=items,
        ))

    return SkuSlotsOut(
        spu=SpuBriefOut(id=spu.id, name=spu.brand_model) if spu is not None else None,
        item=_item_facts(base, infos.get(base.id)) if base is not None else None,
        slots=slots,
    )


_SKU_STATE_LABELS = {
    SkuStatus.RESERVED: "锁单",
    SkuStatus.SHIPPED: "已发货",
    SkuStatus.LOSS: "报损",
    SkuStatus.SPLIT: "拆分退役",
}


def _state_label(sku: Sku, on_shelf_count: int) -> tuple[str, bool]:
    if sku.status == SkuStatus.IN_STOCK:
        if on_shelf_count:
            return "在售", True
        return "在库", False
    return _SKU_STATE_LABELS.get(sku.status, str(sku.status)), False


@router.get("/skus/{sku_code}/media", summary="某件货能发给买家的实拍（图片 + 视频）", response_model=SkuMediaOut)
def sku_media(
    sku_code: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(_chat_user),
):
    sku = db.query(Sku).filter(func.lower(Sku.sku_code) == sku_code.strip().lower()).first()
    if sku is None:
        raise HTTPException(status_code=404, detail="货号不存在")
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    media: list[MediaOut] = []
    for u in buyer_media_urls(db, sku):
        signed = sign_oss_url(u)
        if not signed:
            continue
        if is_video_url(u):
            media.append(MediaOut(type="video", url=signed, thumb=sign_video_poster_url(u)))
        else:
            media.append(MediaOut(type="image", url=signed, thumb=sign_oss_thumb_url(u, size="medium")))
    on_shelf_count = (
        db.query(func.count(SkuShopListing.id))
        .filter(
            SkuShopListing.sku_id == sku.id,
            SkuShopListing.publish_status == ShopListingStatus.LISTED,
        )
        .scalar()
        or 0
    )
    state_label, on_sale = _state_label(sku, on_shelf_count)
    grade = grade_of(sku, info)
    price = format(info.price.normalize(), "f") if info is not None and info.price is not None else None
    description = None
    if info is not None:
        description = (info.desc or "").strip() or None
    config = (sku.spec or "").strip() or None
    remark = (sku.negotiation_remark or "").strip() or None
    missing: list[str] = []
    if not any(m.type == "image" for m in media):
        missing.append("image")
    if not (sku.product_name or "").strip():
        missing.append("name")
    if price is None:
        missing.append("price")
    if not grade:
        missing.append("grade")
    if not sku.location_code:
        missing.append("location")
    if description is None:
        missing.append("description")
    if config is None:
        missing.append("config")
    if remark is None:
        missing.append("remark")
    return SkuMediaOut(
        sku_code=sku.sku_code,
        product_name=sku.product_name,
        grade=grade,
        location_code=sku.location_code,
        short_code=sku.short_code,
        price=price,
        media=media,
        brand=sku.brand,
        model=sku.model,
        sku_status=str(sku.status),
        state_label=state_label,
        on_sale=on_sale,
        on_shelf_count=on_shelf_count,
        listing_status=info.status if info is not None else None,
        description=description,
        config=config,
        remark=remark,
        missing=missing,
    )


@router.put("/pickup-address", summary="改「发送仓库位置」发出去的自提地址（管理员）", response_model=PickupAddressOut)
def put_pickup_address(
    body: PickupAddressIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    return PickupAddressOut(pickup_address=set_setting(db, PICKUP_ADDRESS, body.text.strip(), user.id))
