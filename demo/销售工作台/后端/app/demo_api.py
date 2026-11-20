"""销售页面原来借用 ERP 的少量接口，在这里读取本地合成业务表。"""
from datetime import date
from html import escape
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, make_token
from app.enums import SkuStatus
from app.models import CrawlPrice, CrawlProduct, SaleShop, Sku, SkuShopListing, Staff
from app.services import listing_approval
from app.services.password import verify_password

router = APIRouter(prefix="/api")
DB = Annotated[Session, Depends(get_db)]
User = Annotated[Staff, Depends(get_current_user)]
LABELS = {
    "NONE": "待选图上架", "DRAFT": "已暂存待发", "SUBMITTED": "待确认上架",
    "APPROVED": "已清洗就绪", "REJECTED": "待重选", "STALE": "成本变动待重核",
}


def record(row):
    return {column.name: getattr(row, column.name) for column in row.__table__.columns}


def staff_public(staff):
    return {field: getattr(staff, field) for field in ("id", "username", "name", "staff_no", "role", "status")}


def sku_by_code(db, sku_code):
    sku = db.scalar(select(Sku).where(Sku.sku_code == sku_code))
    if sku is None:
        raise HTTPException(404, "演示库存中找不到该货号")
    return sku


def shops(db):
    return list(db.scalars(select(SaleShop).order_by(SaleShop.sort_order)))


def live_listings(db, sku):
    return {listing.sale_shop_id: listing for listing in db.scalars(
        select(SkuShopListing).where(SkuShopListing.sku_id == sku.id)
    )}


def listing_view(db, sku):
    current = listing_approval.current_by_shop(db, sku.id)
    live = live_listings(db, sku)
    result = []
    for shop in shops(db):
        approval = current.get(shop.id)
        listed = shop.id in live and live[shop.id].publish_status == "LISTED"
        state = approval.status if approval else "NONE"
        why = listing_approval.problem_for_publish(db, sku, approval) if listed else None
        result.append({
            "id": shop.id, "label": shop.label,
            "cell": {"shop_id": shop.id, "state": state, "label": LABELS[state],
                     "listed": listed, "needs_fix": bool(why), "problem": why},
            "approval": record(approval) if approval else None,
        })
    return result


def sku_view(db, sku):
    listing_count = sum(l.publish_status == "LISTED" for l in live_listings(db, sku).values())
    phase = {
        SkuStatus.SHIPPED: "shipped", SkuStatus.RESERVED: "locked",
        SkuStatus.IN_STOCK: "on_sale" if listing_count else "pending_publish",
    }.get(sku.status, "pending_inbound")
    return {
        **record(sku), "warehouse_phase": phase, "on_shelf_count": listing_count,
        "stock_events": [record(e) for e in sku.stock_events],
    }


@router.post("/auth/h5-login")
def login(body: dict, db: DB):
    staff = db.scalar(select(Staff).where(Staff.username == body.get("username")))
    if not staff or not verify_password(str(body.get("password") or ""), staff.password_hash):
        raise HTTPException(401, "演示账号或演示口令有误")
    return {"token": make_token(staff.id), "staff": staff_public(staff)}


@router.get("/staff")
def list_staff(db: DB, _user: User):
    items = [staff_public(staff) for staff in db.scalars(select(Staff))]
    return {"items": items, "total": len(items)}


@router.get("/inventory/skus")
def list_inventory(db: DB, _user: User, page: int = 1, size: int = 100, in_warehouse: bool = False):
    query = select(Sku).order_by(Sku.sku_code)
    if in_warehouse:
        query = query.where(Sku.status.in_([SkuStatus.IN_STOCK, SkuStatus.RESERVED]))
    items = list(db.scalars(query))
    start = max(0, page - 1) * size
    return {"total": len(items), "items": [sku_view(db, sku) for sku in items[start:start + size]]}


@router.get("/inventory/skus/{sku_code}")
def inventory_detail(sku_code: str, db: DB, _user: User):
    return sku_view(db, sku_by_code(db, sku_code))


@router.get("/inventory/skus/{sku_code}/price-history")
def price_history(sku_code: str, db: DB, _user: User):
    sku = sku_by_code(db, sku_code)
    market = db.scalar(select(CrawlProduct).where(CrawlProduct.keyword == sku.model))
    series = [
        {"date": row.crawl_date, "price": row.price}
        for row in db.scalars(select(CrawlPrice).where(CrawlPrice.product_id == market.id).order_by(CrawlPrice.crawl_date))
    ] if market else []
    return {"series": series, "stats": {"latest": series[-1] if series else None}}


@router.get("/stock-gaps")
def gaps(_user: User):
    return {"items": [], "total": 0}


@router.get("/listing-approvals/tasks")
def listing_tasks(db: DB, _user: User, page: int = 1, size: int = 100):
    all_skus = list(db.scalars(select(Sku).where(Sku.status == SkuStatus.IN_STOCK)))
    start = max(0, page - 1) * size
    items = [{
        "sku_code": sku.sku_code,
        "cells": [shop["cell"] for shop in listing_view(db, sku)],
    } for sku in all_skus[start:start + size]]
    return {"items": items, "total": len(all_skus), "shops": [{"id": s.id, "label": s.label} for s in shops(db)]}


@router.get("/listing-approvals/skus/{sku_code}")
def listing_detail(sku_code: str, db: DB, _user: User):
    sku = sku_by_code(db, sku_code)
    ratio = listing_approval.min_cost_ratio(db)
    return {"shops": listing_view(db, sku), "min_cost_ratio": ratio,
            "floor_price": listing_approval.floor_price(sku.cost_price, ratio), "market": listing_approval.market_of(db, sku)}


@router.post("/listing-approvals/skus/{sku_code}/review")
def review_listing(sku_code: str, body: dict, db: DB, user: User):
    sku = sku_by_code(db, sku_code)
    for shop_id in body.get("shop_ids", []):
        approval = listing_approval.current(db, sku.id, shop_id)
        if not approval:
            raise HTTPException(404, "未找到该上架记录")
        listing_approval.review(db, sku, approval, approve=bool(body.get("approve")), note=body.get("note"), user_id=user.id)
    db.commit()
    return {"ok": True}


@router.get("/listing/skus/{sku_code}/shops")
def listing_shops(sku_code: str, db: DB, _user: User):
    sku = sku_by_code(db, sku_code)
    return [{"shop_id": shop_id, **record(item)} for shop_id, item in live_listings(db, sku).items()]


@router.get("/listing/skus/{sku_code}/stock-age")
def listing_age(sku_code: str, db: DB, _user: User):
    sku = sku_by_code(db, sku_code)
    return {"days": (date.today() - sku.inbound_at.date()).days if sku.inbound_at else 0}


@router.get("/listing/skus/{sku_code}/listing-images")
def listing_images(sku_code: str, db: DB, _user: User):
    sku = sku_by_code(db, sku_code)
    return {"crawled": [url for url in sku.images or [] if "/sku/product/" in url], "rejected": [], "max_per_shop": 9}


def demo_image(asset):
    asset = asset[:190]
    title = escape(asset.rsplit("/", 1)[-1].rsplit(".", 1)[0])
    palette = ["#2b4f80", "#8b4c44", "#376453", "#66547d", "#4b5c6f"]
    fill = palette[sum(map(ord, asset)) % len(palette)]
    media = "库存定位示意" if "/location/" in "/" + asset else "验货细节示意" if "/defect/" in "/" + asset else "商品素材演示" if "product" in asset or "library" in asset else "工作台样图"
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
    <rect width="640" height="400" fill="#edf1f9"/>
    <rect x="63" y="40" width="514" height="238" rx="18" fill="{fill}"/>
    <rect x="263" y="278" width="114" height="13" rx="6" fill="{fill}"/>
    <text x="320" y="138" font-family="sans-serif" font-size="30" text-anchor="middle" fill="white">{media}</text>
    <text x="320" y="188" font-family="monospace" font-size="17" text-anchor="middle" fill="white">{title}</text>
    <text x="320" y="338" font-family="sans-serif" font-size="19" text-anchor="middle" fill="#293754">仅本地演示 · 合成插图</text>
    </svg>"""
    return Response(content=svg, media_type="image/svg+xml")


@router.get("/demo-img/{asset:path}")
def media(asset: str):
    return demo_image(asset)


@router.get("/demo-files/{asset:path}")
def files(asset: str):
    return demo_image(asset)
