"""销售工作台「订单」：闲鱼卖出的货，四类问题都跳红（11-13 对齐销售工作台交付包）。

我们的闲鱼订单不走单独的订单表，靠群控售出同步：哪个号上的哪件货卖出了（SkuShopListing.SOLD + sold_at），
卖出就锁货（Sku RESERVED / PLATFORM_SOLD），发货走手动成交出库。四类问题照这份数据判：
- 漏抓：闲鱼显示卖出了，ERP 里这件货没锁（还在库、没占用）——可能会被别人再卖一次；
- 对不上货：同一件货在两个以上的号都卖出了（最近 30 天），只能发一单，别的要跟买家协商退款；
- 卡住没走：卖出了还没发，过了 17:00 时限就红（和「今天」同一个口径）；
- 状态不同步：ERP 已出库，闲鱼上还有号挂着，要下架。
正常走完的（卖出、已出库、没别的号挂着）列在「最近卖出」里，不着色。图只用实拍，绝不用封面。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.enums import ReserveSource, ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuShopListing
from app.services.oss_media import thumb_url_for_cover

KINDS = {
    "missed": "漏抓",
    "mismatch": "对不上货",
    "stuck": "卡住没走",
    "unsync": "状态不同步",
}
RECENT_DAYS = 30
CN = timedelta(hours=8)

ITEM_URL = "/pages/sales-goods/item/index?code={code}"
MANUAL_SALE_URL = "/pages/sales/manual-sale/index?code={code}"
SHOP_OFF_URL = "/pages/warehouse/shop-off/index?code={code}"


def _cn(dt: datetime | None) -> str:
    return (dt + CN).strftime("%m-%d %H:%M") if dt else "时间不明"


def build(db: Session, shop_ids: set[str] | None = None, now: datetime | None = None) -> dict:
    """shop_ids 给了只看这些号卖的（销售看分给自己的号）；None 看全部。"""
    from app.services.sales_workbench import _ship_level

    now = now or datetime.utcnow()
    shops = {s.id: s.label for s in db.query(SaleShop)}
    rows = db.query(SkuShopListing).filter(SkuShopListing.publish_status == ShopListingStatus.SOLD).all()
    sold_by_sku: dict[str, list[SkuShopListing]] = {}
    for r in rows:
        sold_by_sku.setdefault(r.sku_id, []).append(r)
    unsync_ids = {
        r.sku_id
        for r in db.query(SkuShopListing.sku_id)
        .join(Sku, Sku.id == SkuShopListing.sku_id)
        .filter(
            SkuShopListing.publish_status.in_((ShopListingStatus.LISTED, ShopListingStatus.LISTING)),
            Sku.status.in_((SkuStatus.SHIPPED, SkuStatus.LOSS)),
        )
    }
    ids = set(sold_by_sku) | unsync_ids
    skus = {s.id: s for s in db.query(Sku).filter(Sku.id.in_(ids))} if ids else {}
    live = {}
    live_shops: dict[str, set[str]] = {}
    if unsync_ids:
        for r in db.query(SkuShopListing).filter(
            SkuShopListing.sku_id.in_(unsync_ids),
            SkuShopListing.publish_status.in_((ShopListingStatus.LISTED, ShopListingStatus.LISTING)),
        ):
            live.setdefault(r.sku_id, []).append(shops.get(r.sale_shop_id, "?"))
            live_shops.setdefault(r.sku_id, set()).add(r.sale_shop_id)

    problems: list[dict] = []
    recent: list[dict] = []
    for sku_id in ids:
        sku = skus.get(sku_id)
        if sku is None:
            continue
        sold = sorted(sold_by_sku.get(sku_id, []), key=lambda r: r.sold_at or datetime.min)
        # 按号分人：在我的号上卖出的，或者出库了还挂在我的号上的（线下卖掉的货没有已售行，
        # 原来只看卖出的号，那个号的负责人看不到「还挂着」，可能被再卖一次）
        if shop_ids is not None and not (({r.sale_shop_id for r in sold} | live_shops.get(sku_id, set())) & shop_ids):
            continue
        last = sold[-1] if sold else None
        base = {
            "sku_code": sku.sku_code,
            "product_name": sku.product_name,
            # 实拍图第一张；绝不用封面
            "thumb": thumb_url_for_cover(sku.images[0]) if sku.images else None,
            "shops": [shops.get(r.sale_shop_id, "?") for r in sold],
            "sold_at": _cn(last.sold_at) if last else None,
            "at": (last.sold_at or datetime.min).isoformat() if last else "",
            "item_url": ITEM_URL.format(code=sku.sku_code),
        }

        def add(kind: str, level: str, text: str, url: str, button: str):
            problems.append({**base, "kind": kind, "kind_label": KINDS[kind], "level": level,
                             "text": text, "url": url, "button": button})

        hit = False
        in_stock = sku.status == SkuStatus.IN_STOCK and not sku.reserve_source
        recent_sale = bool(last and last.sold_at and now - last.sold_at <= timedelta(days=RECENT_DAYS))
        # 漏抓也只看最近 30 天：退货回仓（快照里没有各号挂牌）、盘点盘回、切单解除占用，货回到在库，
        # 旧的 SOLD 行还留着，原来不看时间就永久红、页面上又没有能清掉它的操作
        if sold and in_stock and recent_sale:
            hit = True
            add("missed", "red", f"{base['shops'][-1]} {base['sold_at']} 卖出，ERP 里还在库没锁，别的号可能再卖一次",
                ITEM_URL.format(code=sku.sku_code), "去看")
        # 重复卖出只提醒最近 30 天的：处理完（退款）的单 SOLD 行还留着，不能一直红
        if len({r.sale_shop_id for r in sold}) > 1 and recent_sale:
            hit = True
            add("mismatch", "red", f"同一件货在 {len(sold)} 个号都卖出了（{'、'.join(base['shops'])}），只能发一单，别的要跟买家协商退款",
                ITEM_URL.format(code=sku.sku_code), "去看")
        if sku.status == SkuStatus.RESERVED and sku.reserve_source == ReserveSource.PLATFORM_SOLD:
            hit = True
            level, sub = _ship_level(last.sold_at if last else None, now)
            add("stuck", level, f"{base['shops'][-1] if base['shops'] else ''} 卖出，还没发：{sub}",
                MANUAL_SALE_URL.format(code=sku.sku_code), "去发货")
        if sku_id in unsync_ids:
            hit = True
            add("unsync", "red", f"ERP 已出库，闲鱼上还挂着：{'、'.join(live.get(sku_id, []))}",
                SHOP_OFF_URL.format(code=sku.sku_code), "去下架")
        if not hit and recent_sale:
            recent.append({**base, "state": "已出库" if sku.status == SkuStatus.SHIPPED else sku.status})

    order = {"red": 0, "yellow": 1}
    problems.sort(key=lambda p: (order.get(p["level"], 2), list(KINDS).index(p["kind"]), p["at"]))
    recent.sort(key=lambda r: r["at"], reverse=True)
    counts = {k: sum(p["kind"] == k for p in problems) for k in KINDS}
    return {
        "kinds": [{"key": k, "label": v, "count": counts[k]} for k, v in KINDS.items()],
        "problems": problems,
        "recent": recent,
        "recent_days": RECENT_DAYS,
    }
