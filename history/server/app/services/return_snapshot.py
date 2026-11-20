"""退货单：快照发货前上架信息并在入库时恢复。"""

from decimal import Decimal

from sqlalchemy.orm import Session

from app.enums import ListingInfoStatus, ShopListingStatus
from app.models import Sku, SkuListingInfo, SkuShopListing


def build_listing_snapshot(db: Session, sku: Sku) -> dict:
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    shops = db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id).all()
    info_data = None
    if info:
        info_data = {
            "title": info.title,
            "desc": info.desc,
            "price": str(info.price) if info.price is not None else None,
            "original_price": str(info.original_price) if info.original_price is not None else None,
            "express_fee": str(info.express_fee) if info.express_fee is not None else None,
            "images": info.images or [],
            "stuff_status": info.stuff_status,
            "status": info.status,
        }
    shop_rows = [
        {
            "sale_shop_id": row.sale_shop_id,
            "publish_status": row.publish_status,
        }
        for row in shops
    ]
    return {
        "sku": {
            "suggest_price": str(sku.suggest_price) if sku.suggest_price is not None else None,
            "negotiation_remark": sku.negotiation_remark,
        },
        "listing_info": info_data,
        "shop_listings": shop_rows,
    }


def _decimal_or_none(value) -> Decimal | None:
    if value is None or value == "":
        return None
    return Decimal(str(value))


def restore_listing_snapshot(db: Session, sku: Sku, snapshot: dict | None) -> None:
    if not snapshot:
        return
    sku_part = snapshot.get("sku") or {}
    if sku_part.get("suggest_price"):
        sku.suggest_price = _decimal_or_none(sku_part["suggest_price"])
    sku.negotiation_remark = sku_part.get("negotiation_remark")

    info_data = snapshot.get("listing_info")
    if not info_data:
        return

    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    if not info:
        info = SkuListingInfo(sku_id=sku.id)
        db.add(info)

    info.title = info_data.get("title")
    info.desc = info_data.get("desc")
    info.price = _decimal_or_none(info_data.get("price"))
    info.original_price = _decimal_or_none(info_data.get("original_price"))
    info.express_fee = _decimal_or_none(info_data.get("express_fee"))
    info.images = info_data.get("images") or []
    info.stuff_status = info_data.get("stuff_status")

    if info.title and info.price:
        info.status = ListingInfoStatus.READY
    else:
        info.status = ListingInfoStatus.DRAFT

    shop_rows = snapshot.get("shop_listings") or []
    if not shop_rows:
        return

    existing = {
        row.sale_shop_id: row
        for row in db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id).all()
    }
    for row in shop_rows:
        shop_id = row.get("sale_shop_id")
        if not shop_id:
            continue
        listing = existing.get(shop_id)
        if not listing:
            listing = SkuShopListing(sku_id=sku.id, sale_shop_id=shop_id)
            db.add(listing)
        status = row.get("publish_status") or ShopListingStatus.PENDING
        if status == ShopListingStatus.SOLD:
            status = ShopListingStatus.PENDING
        listing.publish_status = status
