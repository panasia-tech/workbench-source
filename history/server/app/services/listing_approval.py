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
from app.services import image_similarity
from app.schemas.market import PRICE_BASIS
from app.services.app_settings import get_setting
from app.services.auto_listing.pricing import floor_price, to_int_yuan
from app.services.oss_media import strip_oss_signature

REQUIRED_KEY = "listing_approval_required"
RATIO_KEY = "listing_min_cost_ratio"
# 提交即发布：员工提交清洗结果时直接通过并发布，不用再等别人点「通过」。默认开，可在后台关掉
AUTO_PUBLISH_KEY = "listing_approval_auto_publish"
DEFAULT_RATIO = Decimal("1.00")
MAX_IMAGES = 9

STATUSES = ("DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "STALE")

# 用户 11-13 定（对齐销售工作台交付包）：低于成本线不直接拦，写理由提交、只有管理员能批；
# 高于成本 5 倍只标黄提醒，不拦
HIGH_PRICE_MULTIPLE = Decimal("5")
BELOW_FLOOR_REASON_MIN = 4


def approval_required(db: Session) -> bool:
    return get_setting(db, REQUIRED_KEY, "") == "1"


def auto_publish_setting(db: Session) -> bool:
    """后台开关本身；没设置的默认开（用户 11-17 定：提交时直接发布，别再多点一次通过）。"""
    return get_setting(db, AUTO_PUBLISH_KEY, "1") == "1"


def auto_publish(db: Session) -> bool:
    """实际生效：审批开着，且「提交即发布」开着。"""
    return approval_required(db) and auto_publish_setting(db)


def readiness(db: Session) -> dict:
    """打开审批前的存量盘点：在库可发货、在架待整改、待清洗、待审批各多少。

    打开开关不会自动改旧链接；在架但没有可用批准的店会进「在架待整改」队列等人清洗。
    链接焕新不等审批（用户 11-10 定、11-12 重申），这些店照旧焕新。
    """
    from app.enums import ShopListingStatus, SkuStatus
    from app.models import SaleShop, Sku, SkuShopListing

    shops = (
        db.query(SaleShop)
        .filter(SaleShop.enabled.is_(True), SaleShop.gc_account_id.isnot(None))
        .all()
    )
    skus = (
        db.query(Sku)
        .filter(Sku.status == SkuStatus.IN_STOCK, Sku.reserve_source.is_(None))
        .all()
    )
    listed_pairs: set[tuple[str, str]] = set()
    by_shop: dict[str, dict[str, ListingApproval]] = {}
    if skus:
        sku_ids = [s.id for s in skus]
        listed_pairs = {
            (r.sku_id, r.sale_shop_id)
            for r in db.query(SkuShopListing.sku_id, SkuShopListing.sale_shop_id)
            .filter(
                SkuShopListing.sku_id.in_(sku_ids),
                SkuShopListing.publish_status == ShopListingStatus.LISTED,
            )
            .all()
        }
        for r in (
            db.query(ListingApproval)
            .filter(ListingApproval.sku_id.in_(sku_ids))
            .order_by(ListingApproval.version)
            .all()
        ):
            by_shop.setdefault(r.sku_id, {})[r.sale_shop_id] = r

    fix_skus, todo_skus, review_skus, done_skus = [], [], [], []
    for sku in skus:
        cells = []
        needs_fix = False
        has_todo = False
        has_review = False
        all_ok = bool(shops)
        for shop in shops:
            approval = by_shop.get(sku.id, {}).get(shop.id)
            listed = (sku.id, shop.id) in listed_pairs
            state = approval.status if approval else "NONE"
            if state == "APPROVED" and problem_for_publish(db, sku, approval):
                state = "STALE"
            if listed and state != "APPROVED":
                needs_fix = True
            if state in ("NONE", "DRAFT", "REJECTED", "STALE"):
                has_todo = True
            if state == "SUBMITTED":
                has_review = True
            if state != "APPROVED":
                all_ok = False
            cells.append(state)
        if needs_fix:
            fix_skus.append(sku.sku_code)
        if has_todo:
            todo_skus.append(sku.sku_code)
        if has_review:
            review_skus.append(sku.sku_code)
        if all_ok:
            done_skus.append(sku.sku_code)

    return {
        "required": approval_required(db),
        "shop_count": len(shops),
        "in_stock": len(skus),
        "fix": len(fix_skus),
        "todo": len(todo_skus),
        "review": len(review_skus),
        "done": len(done_skus),
        # 打开前看这几个样例就够；完整列表走 tasks?state=fix
        "fix_samples": fix_skus[:20],
        "safe_hint": (
            "在架待整改已清零，打开后新发都只走批准内容"
            if not fix_skus
            else f"还有 {len(fix_skus)} 件在架待整改：已在架的链接照旧焕新，请清「在架待整改」队列"
        ),
    }


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
            url = strip_oss_signature(u.strip()) or u.strip()
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
    from app.services.spu_resolve import resolve_spu

    match = resolve_spu(db, sku)
    query = (match.query or "").strip() if match.matched else ""
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
        "basis": PRICE_BASIS.get(source) if source else None,
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


def occupied_by_shop(db: Session, sku_id: str, *, for_update: bool = False) -> dict[str, list[str]]:
    """这件货每个号会占用的图：店铺 ID → 图。

    提交/批准时和选图页必须用同一套口径，否则页面能点、提交才报重复：
    有已提交、已批审批的号看审批里那组（批完就按它发）；
    没有的、在架或上架中的号看它现在挂着的：按审批发的看当时那份，按店铺单独挑过图的看那组，
    都没有就是公用那组（上架信息的图，口径同 shop_images._held_by_others）。
    几个号共用公用图不会卡死整改：先清洗的号换别的图，它有了审批就不再占公用图，后面的号就能用。
    """
    from app.services.shop_images import _own_images

    common = None
    approvals: dict[str, ListingApproval] = {}
    query = (
        db.query(ListingApproval)
        .filter(ListingApproval.sku_id == sku_id)
        .order_by(ListingApproval.version)
    )
    if for_update:
        # 可重复读下普通读是事务开始时的快照；提交/批准比图必须加锁读，才看得见别人刚提交的
        query = query.populate_existing().with_for_update(read=True)
    for r in query.all():
        approvals[r.sale_shop_id] = r  # 版本升序，后面的覆盖前面的
    out: dict[str, list[str]] = {}
    for sid, r in approvals.items():
        if r.status in ("SUBMITTED", "APPROVED") and r.images:
            out[sid] = clean_images(r.images)
    live = (
        db.query(SkuShopListing)
        .filter(SkuShopListing.sku_id == sku_id,
                SkuShopListing.publish_status.in_((ShopListingStatus.LISTING, ShopListingStatus.LISTED)))
        .all()
    )
    for listing in live:
        sid = listing.sale_shop_id
        if sid in out:
            continue
        used = db.get(ListingApproval, listing.listing_approval_id) if listing.listing_approval_id else None
        images = (used.images if used else None) or listing.images
        if not images:
            if common is None:
                sku = db.get(Sku, sku_id)
                common = _own_images(db, sku) if sku else []
            images = common
        if images:
            out[sid] = clean_images(images)
    return out


def occupied_urls(db: Session, sku_id: str) -> dict[str, list[dict]]:
    """选图页用：图 → 占着它的店铺 [{id,label}]。含停用/不在列表里的号，页面也要标出来。"""
    by_shop = occupied_by_shop(db, sku_id)
    shops = {
        s.id: s
        for s in db.query(SaleShop).filter(SaleShop.id.in_(by_shop.keys())).all()
    } if by_shop else {}
    out: dict[str, list[dict]] = {}
    for sid, urls in by_shop.items():
        shop = shops.get(sid)
        label = shop.label if shop else "别的店铺"
        for url in urls:
            out.setdefault(url, []).append({"id": sid, "label": label})
    return out


def _others_images(db: Session, row: ListingApproval) -> list[tuple[str, list[str]]]:
    """这件货别的号要挂 / 挂着的图：(店铺名, 图)。口径同 occupied_by_shop。"""
    out = []
    for sid, images in occupied_by_shop(db, row.sku_id, for_update=True).items():
        if sid == row.sale_shop_id:
            continue
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
    return image_similarity.find_problem(
        db, sku_id=row.sku_id, mine=[(None, mine)], others=others, same_picture=True,
        confirm_scope=f"approve:{row.id}:{user_id}" if approving else None, action="通过", user_id=user_id,
    )


def price_flags(sku: Sku, price, floor: int | None) -> dict:
    """低于成本线（要管理员批）、高于成本 5 倍（标黄）。"""
    p = to_int_yuan(price)
    cost = _money(sku.cost_price)
    return {
        "below_floor": bool(p and floor is not None and p < floor),
        "high": bool(p and cost and cost > 0 and Decimal(p) > cost * HIGH_PRICE_MULTIPLE),
    }


def problem_for_submit(
    db: Session, sku: Sku, row: ListingApproval, *, approving: bool = False, user_id: str | None = None,
    reviewer_is_admin: bool = False,
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
        if approving and not reviewer_is_admin:
            return f"价格低于成本线 {floor} 元，只有管理员能批"
        if len((row.note or "").strip()) < BELOW_FLOOR_REASON_MIN:
            return f"价格低于成本线 {floor} 元：在备注里写清为什么要低价（至少 {BELOW_FLOOR_REASON_MIN} 个字），提交后只有管理员能批"
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
    ratio = min_cost_ratio(db)
    floor = floor_price(sku.cost_price, ratio)
    price = to_int_yuan(row.price)
    # 低于成本线的只有管理员批得了；成本（上面核过）和比例都没变，就是管理员当时批的那个低价，照发
    admin_low_price = _money(row.min_cost_ratio) == _money(ratio)
    if floor is None or price is None or (price < floor and not admin_low_price):
        return f"价格低于现在的成本线 {floor} 元，要重新审批"
    if not row.images:
        return "批准的内容里没有图"
    # 4318de7 合入时带进来过「行情偏差 ≥15% 批准作废」，11-14 用户定去掉：行情涨跌只在库存商品卡上提醒销售核价，不拦发布
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


def submit(
    db: Session, sku: Sku, row: ListingApproval, user_id: str, *,
    auto_approve: bool = False, reviewer_is_admin: bool = False,
) -> ListingApproval:
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
    if auto_approve:
        # 提交即发布：跳过「自己提交的要别人批」，但低价仍守原来的规则——非管理员不自动批
        approve_why = problem_for_submit(
            db, sku, row, approving=True, user_id=user_id, reviewer_is_admin=reviewer_is_admin,
        )
        if approve_why is None:
            row.status = "APPROVED"
            row.reviewed_by = user_id
            row.reviewed_at = datetime.utcnow()
            row.review_note = "提交即发布"
    return row


def review(
    db: Session, sku: Sku, row: ListingApproval, *, approve: bool, note: str | None, user_id: str,
    media: list[str] | None = None, reviewer_is_admin: bool = False,
) -> ListingApproval:
    if row.status != "SUBMITTED":
        raise HTTPException(status_code=400, detail="只有待审批的能批")
    if row.submitted_by == user_id:
        raise HTTPException(status_code=400, detail="自己提交的要别人来批")
    note = (note or "").strip() or None
    if approve:
        # 提交之后到现在，成本、比例、库存、别的店的图可能变了
        _lock_sku(db, sku.id)
        why = problem_for_submit(
            db, sku, row, approving=True, user_id=user_id, reviewer_is_admin=reviewer_is_admin,
        ) or (
            "提交之后成本变了，退回去重新清洗" if _money(sku.cost_price) != _money(row.cost_price) else None
        )
        if why:
            raise HTTPException(status_code=400, detail=why)
        # 记批的那一刻的比例：发布时「比例没变」才放行低价。原来记的是提交时的，管理员把比例临时调低，
        # 这期间仓管 / 销售就批得了（不算低价），调回去以后比例又「没变」，低价不经管理员照发
        row.min_cost_ratio = min_cost_ratio(db)
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
