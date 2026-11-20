"""上架审批：在库商品逐件、逐个店铺清洗价和图，管理员批过才发。规则见 services/listing_approval。"""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import ShopListingStatus, SkuStatus, StaffRole
from app.models import InspectionEvidence, ListingApproval, SaleShop, Sku, SkuListingInfo, SkuShopListing, Staff
from app.schemas._tz import utc_to_cn_iso
from app.services import listing_approval as la
from app.services import shop_images
from app.services.app_settings import set_setting
from app.services.auto_listing.pricing import floor_price, to_int_yuan
from app.services.oss_media import public_url_to_object_key, sign_oss_thumb_url, sign_oss_url
from app.services.staff_lookup import map_staff_names
from app.services import practice

router = APIRouter(prefix="/api/listing-approvals", tags=["上架审批"])

# 11-10 用户定：任何员工都能清洗、都能审批（自己提交的仍要别人批）；设备账号不行
_EDITORS = (
    StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.NEGOTIATOR, StaffRole.BUSINESS,
    StaffRole.SALES, StaffRole.FINANCE, StaffRole.ADMIN,
)

# 店铺格子的状态：在后台列表上显示的就是这几个字
CELL_LABELS = {
    "NONE": "未清洗",
    "DRAFT": "草稿",
    "SUBMITTED": "待审批",
    "APPROVED": "已通过",
    "REJECTED": "已退回",
    "STALE": "失效",
}


class SettingsIn(BaseModel):
    required: bool | None = Field(default=None, description="打开后只发批过的价和图")
    min_cost_ratio: Decimal | None = Field(default=None, gt=0, le=10, description="售价下限 = 成本 × 这个比例")
    auto_publish: bool | None = Field(default=None, description="提交即发布：提交时直接通过并发布，不用再点通过")


@router.get("/settings", summary="上架审批开关和成本比例")
def read_settings(db: Session = Depends(get_db), _: Staff = Depends(require_roles(*_EDITORS))):
    ready = la.readiness(db)
    return {
        "required": ready["required"],
        "min_cost_ratio": str(la.min_cost_ratio(db)),
        "auto_publish": la.auto_publish_setting(db),
        "readiness": ready,
    }


class DraftIn(BaseModel):
    price: Decimal | None = Field(default=None, description="整数元")
    images: list[str] = Field(default_factory=list)
    note: str | None = None


class ShopIdsIn(BaseModel):
    shop_ids: list[str] = Field(default_factory=list)


class ReviewIn(BaseModel):
    shop_ids: list[str] = Field(default_factory=list)
    approve: bool
    note: str | None = None
    # 退回时可附标注截图、对照说明（OSS 地址），员工按项补正
    media: list[str] = Field(default_factory=list, max_length=9)



def _shops(db: Session) -> list[SaleShop]:
    """能发的店铺：启用、绑了群控账号。跟发布时选目标同一个口径。"""
    return (
        db.query(SaleShop)
        .filter(SaleShop.enabled.is_(True), SaleShop.gc_account_id.isnot(None))
        .order_by(SaleShop.sort_order, SaleShop.code)
        .all()
    )


def _sku(db: Session, sku_code: str) -> Sku:
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    return sku


def _cell(db: Session, sku: Sku, approval: ListingApproval | None, listed: bool) -> dict:
    state = approval.status if approval else "NONE"
    problem = la.problem_for_publish(db, sku, approval) if state == "APPROVED" else None
    if problem:
        state = "STALE"
    return {
        "state": state,
        "label": CELL_LABELS[state],
        "problem": problem or (approval.stale_reason if approval and approval.status == "STALE" else None),
        # 已经在架、但没有一份现在还能用的批准：旧链接要整改
        "needs_fix": listed and state != "APPROVED",
        "listed": listed,
    }


def _listed_shop_ids(db: Session, sku_ids: list[str]) -> set[tuple[str, str]]:
    rows = (
        db.query(SkuShopListing.sku_id, SkuShopListing.sale_shop_id)
        .filter(SkuShopListing.sku_id.in_(sku_ids), SkuShopListing.publish_status == ShopListingStatus.LISTED)
        .all()
    )
    return {(r[0], r[1]) for r in rows}


@router.get("/readiness", summary="打开审批前的存量盘点（在架待整改等）")
def readiness(db: Session = Depends(get_db), _: Staff = Depends(require_roles(*_EDITORS))):
    return la.readiness(db)


@router.put("/settings", summary="修改上架审批开关和成本比例")
def write_settings(body: SettingsIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.ADMIN))):
    if body.required is not None:
        set_setting(db, la.REQUIRED_KEY, "1" if body.required else "0", user.id)
    if body.min_cost_ratio is not None:
        set_setting(db, la.RATIO_KEY, str(body.min_cost_ratio.quantize(Decimal("0.01"))), user.id)
    if body.auto_publish is not None:
        set_setting(db, la.AUTO_PUBLISH_KEY, "1" if body.auto_publish else "0", user.id)
    db.commit()
    return read_settings(db, user)


@router.get("/tasks", summary="清洗任务：在库商品逐件、逐店铺的审批进度")
def list_tasks(
    state: str = Query("todo", description="todo 待清洗 / review 待审批 / fix 在架待整改 / done 全部通过 / all"),
    keyword: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_EDITORS)),
):
    shops = _shops(db)
    query = db.query(Sku).filter(Sku.status == SkuStatus.IN_STOCK, Sku.reserve_source.is_(None))
    if keyword and keyword.strip():
        like = f"%{keyword.strip()}%"
        query = query.filter((Sku.sku_code.like(like)) | (Sku.product_name.like(like)))
    skus = query.order_by(Sku.inbound_at.desc()).all()
    listed = _listed_shop_ids(db, [s.id for s in skus]) if skus else set()
    approvals: dict[str, dict[str, ListingApproval]] = {}
    for r in (
        db.query(ListingApproval)
        .filter(ListingApproval.sku_id.in_([s.id for s in skus]))
        .order_by(ListingApproval.version)
        .all()
        if skus
        else []
    ):
        approvals.setdefault(r.sku_id, {})[r.sale_shop_id] = r

    items, counts = [], {"todo": 0, "review": 0, "fix": 0, "done": 0, "all": len(skus)}
    for sku in skus:
        cells = {
            shop.id: _cell(db, sku, approvals.get(sku.id, {}).get(shop.id), (sku.id, shop.id) in listed)
            for shop in shops
        }
        states = [c["state"] for c in cells.values()]
        tags = set()
        if any(st in ("NONE", "DRAFT", "REJECTED", "STALE") for st in states):
            tags.add("todo")
        if "SUBMITTED" in states:
            tags.add("review")
        if any(c["needs_fix"] for c in cells.values()):
            tags.add("fix")
        if states and all(st == "APPROVED" for st in states):
            tags.add("done")
        for t in tags:
            counts[t] += 1
        if state != "all" and state not in tags:
            continue
        items.append({
            "sku_code": sku.sku_code,
            "product_name": sku.product_name,
            "cost_price": None if sku.cost_price is None else str(sku.cost_price),
            # 实拍图第一张；绝不用封面（Sku.cover_url 里有过买家订单截图）
            "cover": sign_oss_url((sku.images or [None])[0]) if sku.images else None,
            "thumb": sign_oss_thumb_url(sku.images[0]) if sku.images else None,
            "inbound_at": utc_to_cn_iso(sku.inbound_at),
            "cells": cells,
        })
    start = (page - 1) * size
    return {
        "shops": [{"id": s.id, "label": s.label} for s in shops],
        "items": items[start:start + size],
        "total": len(items),
        "counts": counts,
        "cost_hidden": False,
    }


def _img_out(u: str) -> dict:
    return {"raw": u, "url": sign_oss_url(u) or u, "thumb": sign_oss_thumb_url(u) or u}


def _approval_out(
    row: ListingApproval | None, names: dict[str, str], user: Staff, sku: Sku, floor: int | None,
) -> dict | None:
    if row is None:
        return None
    return {
        # 低于成本线（只有管理员能批）、高于成本 5 倍（标黄提醒）
        **la.price_flags(sku, row.price, floor),
        "id": row.id,
        "version": row.version,
        "status": row.status,
        "price": to_int_yuan(row.price),
        "images": [_img_out(u) for u in row.images or []],
        "note": row.note,
        "cost_price": None if row.cost_price is None else str(row.cost_price),
        "min_cost_ratio": str(row.min_cost_ratio) if row.min_cost_ratio is not None else None,
        "market_price": str(row.market_price) if row.market_price is not None else None,
        "market_basis": row.market_basis,
        "submitted_by_name": names.get(row.submitted_by),
        # 自己提交的要别人批，手机端据此不给自己点「通过」
        "submitted_by_me": bool(row.submitted_by and row.submitted_by == user.id),
        "submitted_at": utc_to_cn_iso(row.submitted_at),
        "reviewed_by_name": names.get(row.reviewed_by),
        "reviewed_at": utc_to_cn_iso(row.reviewed_at),
        "review_note": row.review_note,
        "review_media": [_img_out(u) for u in row.review_media or []],
        "stale_reason": row.stale_reason,
    }


def _candidates(db: Session, sku: Sku, current: dict[str, ListingApproval], options: dict) -> list[dict]:
    """可选的图：验货实拍、开箱验货时拍的商品照和瑕疵照、上架信息里已有的图、各号挂着的图（这件货自己的），
    再加图片爬虫按型号搜到的同款图（跟上架页按店铺选图同一份，shop_images.options）。
    各号审批里已经选上的图（含新上传的）也列进来，不然拿掉以后就找不回了。"""
    seen: dict[str, dict] = {}

    def add(url: str | None, source: str, **extra) -> None:
        clean = la.clean_images([url] if url else [])
        if clean and clean[0] not in seen:
            seen[clean[0]] = {"raw": clean[0], "url": sign_oss_url(clean[0]) or clean[0],
                              "thumb": extra.pop("thumb", None) or sign_oss_thumb_url(clean[0]) or clean[0],
                              "source": source, **extra}

    for u in sku.images or []:
        add(u, "验货实拍")
    for ev in (
        db.query(InspectionEvidence)
        .filter(
            (InspectionEvidence.sku_id == sku.id) | (InspectionEvidence.inspection_id == sku.inspection_id),
            InspectionEvidence.kind.in_(("PRODUCT_PHOTO", "DEFECT_PHOTO")),
        )
        .order_by(InspectionEvidence.created_at)
        .all()
    ):
        add(ev.url, "瑕疵照" if ev.kind == "DEFECT_PHOTO" else "开箱商品照")
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    for u in (info.images if info else None) or []:
        add(u, "AI 图（未确认）" if info.ai_image_unconfirmed else "上架信息里的图")
    for p in options.get("photos") or []:
        add(p.get("url"), "上架图", thumb=p.get("thumb"))
    for p in options.get("crawled") or []:
        add(p.get("url"), "同款", thumb=p.get("thumb"), crawled=True,
            grade=p.get("grade") or "", flags=p.get("flags") or [])
    for row in current.values():
        for u in row.images or []:
            uploaded = (public_url_to_object_key(u) or "").startswith(shop_images.upload_dir(sku))
            add(u, "新上传" if uploaded else "已选的图")
    return list(seen.values())


@router.get("/skus/{sku_code}", summary="一件货的清洗页：成本线、行情、可选图、各店铺的审批")
def read_sku(sku_code: str, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_EDITORS))):
    sku = _sku(db, sku_code)
    shops = _shops(db)
    options = shop_images.options(db, sku)  # 没搜过同款图的顺手让爬虫去搜
    current = la.current_by_shop(db, sku.id)
    listed = _listed_shop_ids(db, [sku.id])
    names = map_staff_names(db, {x for r in current.values() for x in (r.submitted_by, r.reviewed_by) if x})
    market = la.market_of(db, sku)
    ratio = la.min_cost_ratio(db)
    floor = floor_price(sku.cost_price, ratio)
    return {
        "sku": {
            "sku_code": sku.sku_code,
            "product_name": sku.product_name,
            "status": sku.status,
            "reserved": bool(sku.reserve_source),
            "cost_price": None if sku.cost_price is None else str(sku.cost_price),
            "has_cost": bool(sku.cost_price),
            "condition_grade": sku.condition_grade,
        },
        "cost_hidden": False,
        "can_review": True,
        # 提交即发布：页面按钮显示「提交并发布」，提交后不用再点通过
        "auto_publish": la.auto_publish(db),
        # 低于成本线的只有管理员能批
        "can_review_low_price": user.role == StaffRole.ADMIN,
        "high_price_multiple": int(la.HIGH_PRICE_MULTIPLE),
        "max_images": la.MAX_IMAGES,
        "upload_dir": shop_images.upload_dir(sku),
        "crawl_status": options.get("crawl_status"),
        # 已经在闲鱼上挂着的图 → 哪个号；只是提醒，在架的旧链接整改后会换成批过的图
        "held": options.get("held") or {},
        # 别的号占着的图（含已提交/已批审批、在架常用图）→ [{id,label}]；选图页用它和后端同一个口径禁用
        "occupied": la.occupied_urls(db, sku.id),
        "min_cost_ratio": str(ratio),
        "floor_price": floor,
        # 价格清洗出的、管理员生效且没过期的价，只做参考
        "clean_price": _clean_price(db, sku),
        "market": {
            "price": str(market["price"]) if market["price"] is not None else None,
            "basis": market["basis"],
            "date": market["date"].isoformat() if market["date"] else None,
        },
        "candidates": _candidates(db, sku, current, options),
        "shops": [
            {
                "id": shop.id,
                "label": shop.label,
                "cell": _cell(db, sku, current.get(shop.id), (sku.id, shop.id) in listed),
                "approval": _approval_out(current.get(shop.id), names, user, sku, floor),
            }
            for shop in shops
        ],
    }


def _clean_price(db: Session, sku: Sku) -> dict | None:
    from app.services import price_clean as pc

    v = pc.version_out(pc.current(db, sku.id))
    return {"price": v["price"], "version": v["version"]} if v and v["usable"] else None


def _shop(db: Session, shop_id: str) -> SaleShop:
    shop = db.get(SaleShop, shop_id)
    if not shop or not shop.enabled or not shop.gc_account_id:
        raise HTTPException(status_code=404, detail="店铺不存在或不能发布")
    return shop


@router.put("/skus/{sku_code}/shops/{shop_id}", summary="保存这个店铺的价和图（草稿）")
def save_draft(
    sku_code: str,
    shop_id: str,
    body: DraftIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_EDITORS)),
):
    practice.gate(db, user)
    sku = _sku(db, sku_code)
    la.save_draft(db, sku, _shop(db, shop_id), price=body.price, images=body.images, note=body.note, user_id=user.id)
    db.commit()
    return read_sku(sku_code, db, user)


@router.post("/skus/{sku_code}/submit", summary="把草稿提交（开了提交即发布时同时发布）")
def submit(
    sku_code: str,
    body: ShopIdsIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_EDITORS)),
    background: BackgroundTasks = None,
):
    practice.gate(db, user)
    sku = _sku(db, sku_code)
    if not body.shop_ids:
        raise HTTPException(status_code=400, detail="请选店铺")
    floor = floor_price(sku.cost_price, la.min_cost_ratio(db))
    auto = la.auto_publish(db)
    low: list[tuple[str, ListingApproval]] = []
    approved: list[str] = []
    for shop_id in body.shop_ids:
        shop = _shop(db, shop_id)
        row = la.current(db, sku.id, shop.id)
        if row is None:
            raise HTTPException(status_code=400, detail=f"「{shop.label}」还没填价和图")
        try:
            la.submit(db, sku, row, user.id, auto_approve=auto,
                      reviewer_is_admin=user.role == StaffRole.ADMIN)
        except HTTPException as exc:
            db.rollback()
            raise HTTPException(status_code=400, detail=f"「{shop.label}」：{exc.detail}") from exc
        if row.status == "APPROVED":
            approved.append(shop.id)
        elif la.price_flags(sku, row.price, floor)["below_floor"]:
            low.append((shop.label, row))
        db.flush()  # 下一家比撞图时要看得到这一家刚提交的
    db.commit()
    if low:
        _notify_low_price(db, sku, user, floor, low)
    if auto and approved and background is not None:
        # 提交已经成功；发布异步做，失败原因写到店铺行，页面能看到、可以手动重试
        background.add_task(_auto_publish_submitted, sku.id, approved)
    return read_sku(sku_code, db, user)


async def _auto_publish_submitted(sku_id: str, shop_ids: list[str]) -> None:
    """提交即发布：后台按审批内容把选中的号发出去。失败不丢审批，只记原因。"""
    from app.database import SessionLocal
    from app.services.gc_bridge.listing_ops import gc_publish_shops

    db = SessionLocal()
    try:
        sku = db.get(Sku, sku_id)
        if sku is None:
            return
        info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku_id).first()
        await gc_publish_shops(db, sku, info, sale_shop_ids=shop_ids)
    except Exception as exc:  # noqa: BLE001
        for sid in shop_ids:
            row = (
                db.query(SkuShopListing)
                .filter(SkuShopListing.sku_id == sku_id, SkuShopListing.sale_shop_id == sid)
                .first()
            )
            if row is not None:
                row.last_error = f"自动发布失败：{str(exc)[:240]}"
        db.commit()
    finally:
        db.close()


def _notify_low_price(
    db: Session, sku: Sku, user: Staff, floor: int | None, rows: list[tuple[str, ListingApproval]],
) -> None:
    """低于成本线的提交只有管理员能批：告诉管理员。发不出去不影响提交。"""
    from app.services import staff_notify

    lines = "\n".join(f"{label}：{to_int_yuan(r.price)} 元（{(r.note or '').strip()}）" for label, r in rows)
    body = f"{sku.sku_code} {sku.product_name}\n成本线 {floor} 元，{user.name or user.username} 提交了低价：\n{lines}"
    url = f"http://127.0.0.1:8000"
    admins = db.query(Staff).filter(
        Staff.role == StaffRole.ADMIN, Staff.status == "ACTIVE", Staff.deleted_at.is_(None),
    )
    for admin in admins:
        try:
            staff_notify.send(admin, "低于成本线的上架价待你批", body, url=url)
        except Exception:  # noqa: BLE001
            pass


@router.post("/skus/{sku_code}/review", summary="管理员通过或退回")
def review(sku_code: str, body: ReviewIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_EDITORS))):
    practice.gate(db, user)
    sku = _sku(db, sku_code)
    if not body.shop_ids:
        raise HTTPException(status_code=400, detail="请选店铺")
    for shop_id in body.shop_ids:
        shop = _shop(db, shop_id)
        row = la.current(db, sku.id, shop.id)
        if row is None:
            raise HTTPException(status_code=400, detail=f"「{shop.label}」没有待审批的内容")
        try:
            la.review(
                db, sku, row, approve=body.approve, note=body.note, user_id=user.id, media=body.media,
                reviewer_is_admin=user.role == StaffRole.ADMIN,
            )
        except HTTPException as exc:
            db.rollback()
            raise HTTPException(status_code=400, detail=f"「{shop.label}」：{exc.detail}") from exc
    db.commit()
    return read_sku(sku_code, db, user)
