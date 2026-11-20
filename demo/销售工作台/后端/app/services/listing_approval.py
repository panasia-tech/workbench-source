"""上架审批：每件货每个店铺（= 一个闲鱼号）的价和图，员工清洗提交、管理员批过才发。

老板 2026-11-03 定（D5、D6）：
  - 价格和这个号专用的一组图都确认过才能上架，原图、AI 图都不能自动兜底；
  - 在库的货全部要清洗，已经在架的旧链接也要整改，不能把历史当成已审批。

开关（app_setting listing_approval_required）关着的时候一切照旧，审批可以先做起来；
打开以后，所有发布入口（手动、自动、AI 补图后、链接焕新、立即重新上架）都只发批过的内容。

批准时记下成本、比例、行情，发布前拿现在的情况再核（problem_for_publish）。
成本变了、比例调高了、货不在库了，旧的批准就不能接着用，要重新清洗。
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.enums import ShopListingStatus, SkuStatus
from app.models import CrawlPrice, CrawlProduct, ListingApproval, SaleShop, Sku, SkuShopListing
from app.services.app_settings import get_setting
from app.services.auto_listing.pricing import floor_price, to_int_yuan
from urllib.parse import urlsplit, urlunsplit

REQUIRED_KEY = "listing_approval_required"
RATIO_KEY = "listing_min_cost_ratio"
DEFAULT_RATIO = Decimal("1.00")
MAX_IMAGES = 9

STATUSES = ("DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "STALE")


def approval_required(db: Session) -> bool:
    return get_setting(db, REQUIRED_KEY, "") == "1"


def min_cost_ratio(db: Session) -> Decimal:
    try:
        value = Decimal(get_setting(db, RATIO_KEY, "") or DEFAULT_RATIO)
    except InvalidOperation:
        return DEFAULT_RATIO
    return value if value > 0 else DEFAULT_RATIO


def clean_images(images: list[str] | None) -> list[str]:
    out: list[str] = []
    for u in images or []:
        if isinstance(u, str) and u.strip():
            url = urlunsplit(urlsplit(u.strip())._replace(query="", fragment=""))
            if url not in out:
                out.append(url)
    return out[:MAX_IMAGES]


def current(db: Session, sku_id: str, shop_id: str) -> ListingApproval | None:
    return (
        db.query(ListingApproval)
        .filter(ListingApproval.sku_id == sku_id, ListingApproval.sale_shop_id == shop_id)
        .order_by(ListingApproval.version.desc())
        .first()
    )


def current_by_shop(db: Session, sku_id: str) -> dict[str, ListingApproval]:
    rows = (
        db.query(ListingApproval)
        .filter(ListingApproval.sku_id == sku_id)
        .order_by(ListingApproval.version)
        .all()
    )
    return {r.sale_shop_id: r for r in rows}  # 版本升序，后面的覆盖前面的


def market_of(db: Session, sku: Sku) -> dict:
    """这件货现在的行情：价格、口径、日期。取不到给空。"""
    query = (sku.model or "").strip()
    product = (
        db.query(CrawlProduct).filter((CrawlProduct.name == query) | (CrawlProduct.keyword == query)).first()
        if query
        else None
    )
    if product is None or product.last_price is None:
        return {"price": None, "basis": None, "date": None, "query": query or None}
    latest = (
        db.query(CrawlPrice)
        .filter(CrawlPrice.product_id == product.id)
        .order_by(CrawlPrice.crawl_date.desc())
        .first()
    )
    source = ((latest.raw or {}).get("source") if latest else None) or None
    return {
        "price": product.last_price,
        "basis": "演示清洗均价" if source == "cleaned_average" else None,
        "date": product.last_price_date,
        "query": query,
    }


def _same_images(a: list[str], b: list[str]) -> bool:
    return bool(a) and bool(b) and set(a) == set(b)


def _lock_sku(db: Session, sku_id: str) -> None:
    """同一件货的提交、批准排队做：两个人同时给不同的号挑了同一张（或很像的）图，后到的要看得见先到的。

    MySQL 行锁（SELECT ... FOR UPDATE）到事务结束才放。可重复读下普通读还是事务开始时的快照，
    所以拿到锁以后比图用的读也要加锁（_others_images 里），才读得到别人刚提交的。
    """
    db.flush()
    db.query(Sku.id).filter(Sku.id == sku_id).with_for_update().first()


def _others_images(db: Session, row: ListingApproval) -> list[tuple[str, list[str]]]:
    """这件货别的号要挂 / 挂着的图：(店铺名, 图)。

    有已提交、已批审批的号看审批里那组（批完就按它发）；
    没有的、在架或上架中的号看它现在挂着的：按审批发的看当时那份，按店铺单独挑过图的看那组，
    都没有就是公用那组（上架信息的图，口径同 shop_images._held_by_others）。
    几个号共用公用图不会卡死整改：先清洗的号换别的图，它有了审批就不再占公用图，后面的号就能用。
    """
    common = None
    approvals: dict[str, ListingApproval] = {}
    for r in (
        db.query(ListingApproval)
        .filter(ListingApproval.sku_id == row.sku_id)
        .order_by(ListingApproval.version)
        .populate_existing()
        .with_for_update(read=True)
        .all()
    ):
        approvals[r.sale_shop_id] = r  # 版本升序，后面的覆盖前面的
    picked: dict[str, list[str]] = {
        sid: r.images for sid, r in approvals.items()
        if sid != row.sale_shop_id and r.status in ("SUBMITTED", "APPROVED") and r.images
    }
    live = (
        db.query(SkuShopListing)
        .filter(SkuShopListing.sku_id == row.sku_id,
                SkuShopListing.publish_status.in_((ShopListingStatus.LISTING, ShopListingStatus.LISTED)))
        .all()
    )
    for listing in live:
        sid = listing.sale_shop_id
        if sid == row.sale_shop_id or sid in picked:
            continue
        used = db.get(ListingApproval, listing.listing_approval_id) if listing.listing_approval_id else None
        images = (used.images if used else None) or listing.images
        if not images:
            if common is None:
                sku = db.get(Sku, row.sku_id)
                common = [url for url in (sku.images or []) if "/sku/product/" in url] if sku else []
            images = common
        if images:
            picked[sid] = images
    out = []
    for sid, images in picked.items():
        shop = db.get(SaleShop, sid)
        out.append((shop.label if shop else "别的店铺", images))
    return out


def _clash(db: Session, row: ListingApproval, *, approving: bool = False, user_id: str | None = None) -> str | None:
    """跟这件货别的号撞图。各号的图一张都不能重复（11-10 用户重申，和 shop_images.validate 一个口径）：
    同一个文件（去掉签名后一样）不行，看起来是同一张（改文件名、重新上传、轻微裁剪，E03）也不行；
    另外首图看起来一样、整组大半看起来一样也不行。

    看长相要取图（image_similarity）；取不到图判不了时，提交先放过（后面有人批），批准要人对照确认一次。
    """
    others = _others_images(db, row)
    mine = clean_images(row.images)
    for label, images in others:
        theirs = clean_images(images)
        if mine and theirs and mine[0] == theirs[0]:
            return f"首图和「{label}」一样，每个号要用不同的首图"
        if _same_images(mine, theirs):
            return f"整组图和「{label}」一样"
        for i, url in enumerate(mine, start=1):
            if url in theirs:
                return f"第 {i} 张图和「{label}」用的是同一张，每个号的图不能重复"
    # shortcut: 合成图只按 URL 查重，接入真实媒体时需要图像近似比对。
    return None


def problem_for_submit(
    db: Session, sku: Sku, row: ListingApproval, *, approving: bool = False, user_id: str | None = None,
) -> str | None:
    if sku.status != SkuStatus.IN_STOCK or sku.reserve_source:
        return "货不在库或已锁定"
    if not row.images:
        return "还没选图"
    price = to_int_yuan(row.price)
    if price is None or price <= 0:
        return "还没填价格"
    floor = floor_price(sku.cost_price, min_cost_ratio(db))
    if floor is None:
        return "这件货没有成本，先补成本"
    if price < floor:
        return f"价格低于成本线 {floor} 元"
    return _clash(db, row, approving=approving, user_id=user_id)


def problem_for_publish(db: Session, sku: Sku, row: ListingApproval | None) -> str | None:
    """发布前再核一遍。返回不能发的原因；能发返回 None。"""
    if row is None or row.status == "DRAFT":
        return "还没提交上架审批"
    if row.status == "SUBMITTED":
        return "上架审批还没批"
    if row.status == "REJECTED":
        return "上架审批被退回了"
    if row.status == "STALE":
        return f"上架审批已失效：{row.stale_reason or '要重新清洗'}"
    if sku.status != SkuStatus.IN_STOCK or sku.reserve_source:
        return "货不在库或已锁定"
    if _money(sku.cost_price) != _money(row.cost_price):
        return "批准之后成本变了，要重新审批"
    floor = floor_price(sku.cost_price, min_cost_ratio(db))
    price = to_int_yuan(row.price)
    if floor is None or price is None or price < floor:
        return f"价格低于现在的成本线 {floor} 元，要重新审批"
    if not row.images:
        return "批准的内容里没有图"
    return None


def _money(v) -> Decimal | None:
    return None if v is None else Decimal(str(v)).quantize(Decimal("0.01"))


def save_draft(db: Session, sku: Sku, shop: SaleShop, *, price, images, note, user_id: str) -> ListingApproval:
    """改价改图。已提交、已批、已退回、已失效的都另开新版本，旧版本留着能回查。"""
    if sku.status != SkuStatus.IN_STOCK or sku.reserve_source:
        raise HTTPException(status_code=400, detail="只有在库、没锁定的货能清洗")
    row = current(db, sku.id, shop.id)
    if row is None or row.status != "DRAFT":
        row = ListingApproval(sku_id=sku.id, sale_shop_id=shop.id, version=(row.version + 1) if row else 1)
        db.add(row)
    row.status = "DRAFT"
    row.price = Decimal(to_int_yuan(price)) if to_int_yuan(price) else None
    row.images = clean_images(images)
    row.note = (note or "").strip() or None
    row.edited_by = user_id
    db.flush()
    return row


def submit(db: Session, sku: Sku, row: ListingApproval, user_id: str) -> ListingApproval:
    if row.status != "DRAFT":
        raise HTTPException(status_code=400, detail="只有草稿能提交")
    _lock_sku(db, sku.id)
    why = problem_for_submit(db, sku, row)
    if why:
        raise HTTPException(status_code=400, detail=why)
    market = market_of(db, sku)
    row.cost_price = sku.cost_price
    row.min_cost_ratio = min_cost_ratio(db)
    row.market_price = market["price"]
    row.market_basis = market["basis"]
    row.market_date = datetime.combine(market["date"], datetime.min.time()) if market["date"] else None
    row.status = "SUBMITTED"
    row.submitted_by = user_id
    row.submitted_at = datetime.utcnow()
    return row


def review(
    db: Session, sku: Sku, row: ListingApproval, *, approve: bool, note: str | None, user_id: str,
    media: list[str] | None = None,
) -> ListingApproval:
    if row.status != "SUBMITTED":
        raise HTTPException(status_code=400, detail="只有待审批的能批")
    # 演示副本：去掉「自己提交的要别人批」
    note = (note or "").strip() or None
    if approve:
        # 提交之后到现在，成本、比例、库存、别的店的图可能变了
        _lock_sku(db, sku.id)
        why = problem_for_submit(db, sku, row, approving=True, user_id=user_id) or (
            "提交之后成本变了，退回去重新清洗" if _money(sku.cost_price) != _money(row.cost_price) else None
        )
        if why:
            raise HTTPException(status_code=400, detail=why)
    elif not note:
        raise HTTPException(status_code=400, detail="退回要写原因")
    row.status = "APPROVED" if approve else "REJECTED"
    row.reviewed_by = user_id
    row.reviewed_at = datetime.utcnow()
    row.review_note = note
    row.review_media = None if approve else [m for m in (media or []) if m] or None
    return row


def mark_stale(db: Session, sku_id: str, reason: str) -> int:
    """货的情况变了（比如退货回仓），这件货所有没用完的审批作废，要重新清洗。"""
    rows = (
        db.query(ListingApproval)
        .filter(ListingApproval.sku_id == sku_id, ListingApproval.status.in_(("SUBMITTED", "APPROVED")))
        .all()
    )
    for r in rows:
        r.status = "STALE"
        r.stale_reason = reason[:255]
    return len(rows)


def apply_to_spec(spec: dict, row: ListingApproval) -> dict:
    """发布内容里的价和图换成批过的这份，不回落到商品原图。"""
    from app.services.oss_media import sign_oss_publish_image_url

    images = [sign_oss_publish_image_url(u) for u in (row.images or [])]
    return {**spec, "price": to_int_yuan(row.price), "images": [u for u in images if u]}
