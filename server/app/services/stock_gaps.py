"""库存缺口总览：在库、没在卖的货，还缺什么才能上架。

11-09 技术对接会定的第二步。员工打开就看到今天要补什么：认不出型号、缺行情价、缺图、
行情低于成本、备好了还没上架。哪几种算缺口由管理员在页面上开关（app_setting）。

不另算一套：每件货卡在哪，直接读自动上架流水线那一行（存量货由每天 08:30 的存量补价补图
登记进来，新入库的由入库登记），口径与后台「自动上架流水线」一致，见 auto_listing/backfill.outcome。
系统自己在等的（爬虫在爬价、在搜图）也列出来，但标「不用管」。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.enums import ShopListingStatus, SkuStatus
from app.models import Sku, SkuAutoListing, SkuListingInfo, SkuShopListing
from app.services.app_settings import get_setting, set_setting
from app.services.auto_listing.backfill import outcome
from app.services.oss_media import sign_oss_url

SETTING_KEY = "stock_gap_kinds"

# 顺序即页面上的顺序：先认型号，再有价、有图，再看能不能卖，最后去上架
KINDS = {
    "unresolved": "认不出型号",
    "no_price": "缺行情价",
    "no_image": "缺图",
    "below_cost": "低于成本",
    "unlisted": "待上架",
    "other": "其他",
}
DEFAULT_KINDS = ("unresolved", "no_price", "no_image", "below_cost", "unlisted")

# 去哪补：小程序页面（H5 同一份）。改货、商品匹配只有仓管和管理员能做，销售只给看
_FIXERS = {"ADMIN", "WAREHOUSE"}
ACTION_ROLES = {"spu_match": _FIXERS, "edit": _FIXERS, "publish": {"ADMIN", "WAREHOUSE", "SALES"}}
ACTIONS = {
    "spu_match": ("去匹配", "/pages/warehouse/spu-match/detail/index?code={code}"),
    "edit": ("去补拍", "/pages/warehouse/edit/index?code={code}"),
    "publish": ("去上架", "/pages/listing/publish/index?code={code}"),
    "detail": ("看详情", "/pages/warehouse/detail/index?code={code}"),
}


def enabled_kinds(db: Session) -> list[str]:
    raw = get_setting(db, SETTING_KEY, "")
    if not raw.strip():
        return list(DEFAULT_KINDS)
    picked = {k.strip() for k in raw.split(",")}
    return [k for k in KINDS if k in picked]


def save_kinds(db: Session, kinds: list[str], staff_id: str) -> list[str]:
    clean = [k for k in KINDS if k in set(kinds)]
    # 一个都不勾等于把页面关了，存个占位，免得读回来又变成默认
    set_setting(db, SETTING_KEY, ",".join(clean) or "-", staff_id)
    return clean


def _classify(row: SkuAutoListing) -> tuple[str, bool, str, str] | None:
    """(缺口种类, 系统在等不用管, 说明, 去哪补)。不算缺口返回 None。"""
    key = outcome(row)
    err = (row.last_error or "").strip()
    if key == "unresolved":
        return "unresolved", False, "系统认不出这是哪一款，去商品匹配里选", "spu_match"
    if key == "waiting_price":
        return "no_price", True, "爬虫在爬这个型号的价", "detail"
    if key == "needs_human" and "行情价" in err:
        return "no_price", False, "爬虫一直没爬到这个型号的价，看看型号对不对", "spu_match"
    if key == "waiting_image":
        return "no_image", True, "没有实拍图，爬虫在按型号搜图", "detail"
    if key == "missing_photo":
        why = err.split("：", 1)[1] if "：" in err else err
        return "no_image", False, why, "edit"
    if key == "below_cost":
        return "below_cost", False, "按行情价卖会亏，定个价再上架", "detail"
    if key == "ready":
        return "unlisted", False, "价和图都齐了", "publish"
    if key == "ready_crawled":
        return "unlisted", False, "图是爬虫按型号搜的，上架前看一眼", "publish"
    if key == "needs_human":
        return "other", False, err or "流水线停下来了", "detail"
    return None  # 流水线还在走、或已上架


def _stock_days(sku: Sku) -> int | None:
    since = sku.inbound_at or sku.created_at
    return (datetime.utcnow() - since).days if since else None


def _thumb(sku: Sku, info: SkuListingInfo | None) -> str | None:
    # 只用实拍图或上架图，绝不用封面：封面里抽查到过带买家姓名电话的闲鱼订单截图
    for urls in ((sku.images or []), (info.images if info else []) or []):
        for u in urls:
            if isinstance(u, str) and u.strip():
                return sign_oss_url(u.strip())
    return None


def _money(v) -> str | None:
    return None if v is None else str(Decimal(str(v)).quantize(Decimal("1")))


def collect(db: Session, *, role: str) -> list[dict]:
    """全部缺口，按种类顺序、库龄从老到新排。在库几百件，Python 里算足够。"""
    busy = db.query(SkuShopListing.sku_id).filter(
        SkuShopListing.publish_status.in_((ShopListingStatus.LISTED, ShopListingStatus.LISTING))
    )
    rows = (
        db.query(Sku, SkuAutoListing, SkuListingInfo)
        .join(SkuAutoListing, SkuAutoListing.sku_id == Sku.id)
        .outerjoin(SkuListingInfo, SkuListingInfo.sku_id == Sku.id)
        .filter(
            Sku.status == SkuStatus.IN_STOCK,
            or_(Sku.reserve_source.is_(None), Sku.reserve_source == ""),
            Sku.id.notin_(busy),
        )
        .all()
    )
    order = list(KINDS)
    out = []
    for sku, row, info in rows:
        hit = _classify(row)
        if hit is None:
            continue
        kind, waiting, note, action = hit
        if role not in ACTION_ROLES.get(action, {role}):
            action = "detail"
        label, url = ACTIONS[action]
        out.append({
            "sku_code": sku.sku_code,
            "product_name": sku.product_name,
            "brand": sku.brand,
            "model": sku.model,
            "location_code": sku.location_code,
            "kind": kind,
            "kind_label": KINDS[kind],
            "waiting": waiting,
            "note": note,
            "action_label": label,
            "action_url": url.format(code=sku.sku_code),
            "image": _thumb(sku, info),
            "market_price": _money(row.market_price),
            # 销售看不到成本（仓库页的库存成本也不给销售看）
            "cost_price": _money(sku.cost_price) if role != "SALES" else None,
            "stock_days": _stock_days(sku),
        })
    out.sort(key=lambda x: (order.index(x["kind"]), x["waiting"], -(x["stock_days"] or 0), x["sku_code"]))
    return out


def overview(db: Session, *, kind: str | None, q: str | None, page: int, size: int, role: str) -> dict:
    kinds = enabled_kinds(db)
    items = [x for x in collect(db, role=role) if x["kind"] in kinds]
    counts = {k: {"label": KINDS[k], "total": 0, "todo": 0} for k in kinds}
    for x in items:
        c = counts[x["kind"]]
        c["total"] += 1
        c["todo"] += 0 if x["waiting"] else 1
    if kind:
        items = [x for x in items if x["kind"] == kind]
    kw = (q or "").strip().lower()
    if kw:
        items = [
            x for x in items
            if any(kw in (x[f] or "").lower() for f in ("sku_code", "product_name", "brand", "model", "location_code"))
        ]
    start = (page - 1) * size
    return {
        "kinds": [{"key": k, **counts[k]} for k in kinds],
        "total": len(items),
        "items": items[start:start + size],
    }
