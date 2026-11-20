"""SKU×店铺 上架状态快照:REST(GET /skus/{code}/shops)与 WS(/ws/sku-shops/{code})共用。

gc 模式下店铺 = 群控账号的镜像(gc_bridge.shop_sync.sync_gc_shops 自动同步:新账号建店、
改名跟随、账号删除则停用、未绑老店按名认领),上架页直接列群控账号、显示闲鱼昵称,
无需人工维护店铺↔账号对应。

顺手做 gc 回写(把「处理中」收敛到 LISTED/DELISTED)——回写失败不挡查询。
"""

from sqlalchemy.orm import Session

import asyncio
import time

from app.config import settings
from app.enums import ShopListingStatus
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing
from app.schemas.listing import ShopListingOut
from app.services.gc_bridge import client as gc
from app.services.gc_bridge.listing_ops import _resolve_worry_free, sync_gc_publish_status
from app.services.gc_bridge.shop_sync import sync_gc_shops

# gc 账号 → 激活设备类型(android/browser)缓存:本快照被 REST 与 WS 代轮询高频复用,
# 不能每次都打两次 gc HTTP,缓存 60s;gc 不可达时用旧缓存(首次为空表,字段回退 None,不挡主流程)。
_KIND_CACHE_TTL_SEC = 60.0
_kind_cache: dict = {"at": 0.0, "map": {}}


async def _gc_device_kind_map() -> dict:
    if time.monotonic() - _kind_cache["at"] < _KIND_CACHE_TTL_SEC:
        return _kind_cache["map"]
    try:
        accounts, devices = await asyncio.gather(gc.list_accounts(), gc.list_devices())
    except Exception:
        return _kind_cache["map"]
    kind_by_dev = {d.get("id"): (d.get("kind") or "android") for d in devices}
    _kind_cache["map"] = {
        a.get("id"): kind_by_dev.get(a.get("device_id")) for a in accounts if a.get("id")
    }
    _kind_cache["at"] = time.monotonic()
    return _kind_cache["map"]


async def build_shops_payload(db: Session, sku: Sku) -> list[ShopListingOut]:
    """上架页店铺 × 该 SKU 的上架状态(含 gc_pending 在途标记)。调用前 sku 须已确认存在。

    gc 模式:店铺列表 = 群控账号镜像(仅 gc_account_id 非空的启用店铺);非 gc 模式:全部启用店铺。
    """
    if settings.gc_publish_enabled:
        try:
            await sync_gc_shops(db)
        except Exception:
            pass
        # 新群控异步:每次取快照时顺带回写(把「处理中」收敛到 LISTED/DELISTED)。
        try:
            await sync_gc_publish_status(db, sku)
        except Exception:
            pass
    listing_by_shop: dict[str, SkuShopListing] = {
        row.sale_shop_id: row
        for row in db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id).all()
    }
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    image_unconfirmed = bool(info and info.ai_image_unconfirmed)
    q = db.query(SaleShop).filter(SaleShop.enabled.is_(True))
    kind_map: dict = {}
    if settings.gc_publish_enabled:
        q = q.filter(SaleShop.gc_account_id.isnot(None))
        kind_map = await _gc_device_kind_map()
    enabled = q.order_by(SaleShop.sort_order, SaleShop.code).all()
    out: list[ShopListingOut] = []
    for shop in enabled:
        device_kind = kind_map.get(shop.gc_account_id) if shop.gc_account_id else None
        listing = listing_by_shop.get(shop.id)
        if listing:
            out.append(
                ShopListingOut(
                    shop_id=shop.id,
                    shop_code=shop.code,
                    shop_label=shop.label,
                    publish_status=listing.publish_status,
                    sold_at=listing.sold_at,
                    delisted_at=listing.delisted_at,
                    last_error=listing.last_error,
                    gc_pending=bool(listing.gc_job_id),
                    ai_image_pending=bool(listing.ai_image_job_id),
                    ai_image_awaiting_confirm=bool(listing.ai_image_job_id) and image_unconfirmed,
                    worry_free_sell=_resolve_worry_free(listing, shop),
                    device_kind=device_kind,
                )
            )
        else:
            out.append(
                ShopListingOut(
                    shop_id=shop.id,
                    shop_code=shop.code,
                    shop_label=shop.label,
                    publish_status=ShopListingStatus.PENDING,
                    sold_at=None,
                    delisted_at=None,
                    last_error=None,
                    worry_free_sell=_resolve_worry_free(None, shop),
                    device_kind=device_kind,
                )
            )
    return out
