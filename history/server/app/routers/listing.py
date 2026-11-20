from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus, StaffRole
from app.models import CrawlProduct, Sku, SkuListingInfo, SkuShopListing, SaleShop, Staff
from app.schemas.listing import (
    AiImageRegenerateRequest,
    DelistRequest,
    ListingInfoOut,
    ListingInfoUpdate,
    ListingPendingItem,
    AutoRefreshSet,
    PublishRequest,
    RefreshNowRequest,
    ImageMaterialSet,
    ShopImagesSet,
    ShopListingOut,
    StockAgeOut,
    StockAgeThresholdsIn,
    WorryFreeSet,
)
from app.config import settings
from app.services.gc_bridge import ai_image_publish
from app.services.gc_bridge.ai_image_publish import publish_or_wait_for_image
from app.services.gc_bridge.client import GcBridgeError
from app.services.gc_bridge.listing_ops import gc_delist_shops, gc_publish_shops, sync_gc_publish_status
from app.services.listing_approval import approval_required
from app.services.listing_shops import build_shops_payload
from app.services.oss_media import sign_media_payload, strip_oss_signature
from app.services.short_code import ensure_short_code
from app.services import shop_images as shop_images_svc
from app.services import stock_age as stock_age_svc
from app.services import practice

router = APIRouter(prefix="/api/listing", tags=["listing"])


def _listing_out(sku: Sku, info: SkuListingInfo | None, crawl_price=None) -> ListingInfoOut:
    if not info:
        # 草稿(还没填过上架信息):售价预填「该型号的市场爬取价」(sku.model 精确匹配 crawl_product,
        # 见 _crawl_price),爬不到价再退回按成本算的 suggest_price。
        draft_price = crawl_price if crawl_price is not None else sku.suggest_price
        data = ListingInfoOut(
            sku_id=sku.id,
            sku_code=sku.sku_code,
            short_code=sku.short_code,
            product_name=sku.product_name,
            title=None,
            desc=None,
            price=draft_price,
            original_price=None,
            express_fee=None,
            images=sku.images or [],
            stuff_status=None,
            status=ListingInfoStatus.DRAFT,
            cover_url=sku.cover_url,
            location_images=sku.location_images or [],
            suggest_price=sku.suggest_price,
        ).model_dump()
        return ListingInfoOut(**sign_media_payload(data))
    data = ListingInfoOut(
        sku_id=sku.id,
        sku_code=sku.sku_code,
        short_code=sku.short_code,
        product_name=sku.product_name,
        title=info.title,
        desc=info.desc,
        price=info.price,
        original_price=info.original_price,
        express_fee=info.express_fee,
        images=info.images or [],
        stuff_status=info.stuff_status,
        status=info.status,
        cover_url=sku.cover_url,
        location_images=sku.location_images or [],
        suggest_price=sku.suggest_price,
        ai_image_unconfirmed=bool(info.ai_image_unconfirmed),
    ).model_dump()
    return ListingInfoOut(**sign_media_payload(data))


@router.get("/pending", summary="待上架商品列表", response_model=list[ListingPendingItem])
def pending_listings(
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    rows = (
        db.query(Sku, SkuListingInfo)
        .outerjoin(SkuListingInfo, Sku.id == SkuListingInfo.sku_id)
        .filter(Sku.status == SkuStatus.IN_STOCK, Sku.negotiated_at.isnot(None))
        .order_by(Sku.inbound_at.desc())
        .all()
    )
    items: list[ListingPendingItem] = []
    for sku, info in rows:
        status = info.status if info else ListingInfoStatus.DRAFT
        if status in (ListingInfoStatus.PUBLISHED, ListingInfoStatus.PUBLISHING):
            continue
        items.append(
            ListingPendingItem(
                **sign_media_payload(
                    ListingPendingItem(
                        sku_id=sku.id,
                        sku_code=sku.sku_code,
                        short_code=sku.short_code,
                        product_name=sku.product_name,
                        cover_url=sku.cover_url,
                        location_images=sku.location_images or [],
                        inbound_at=sku.inbound_at,
                        listing_status=status,
                    ).model_dump()
                )
            )
        )
    return items


def _crawl_price(db: Session, sku: Sku):
    """按 sku.model 精确匹配爬取商品(crawl_product.name 或 keyword),取其最近爬取价 last_price。
    model 为空 / 无匹配 / 无价 → None(调用方退回 suggest_price)。"""
    model = (sku.model or "").strip()
    if not model:
        return None
    c = (
        db.query(CrawlProduct)
        .filter((CrawlProduct.name == model) | (CrawlProduct.keyword == model))
        .first()
    )
    return c.last_price if c else None


@router.get("/skus/{sku_code}", summary="查询上架信息", response_model=ListingInfoOut)
def get_listing(sku_code: str, db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    # 草稿(还没填过上架信息)才预填爬取价;已填过的走 _listing_out 里的 info.price 分支
    crawl_price = _crawl_price(db, sku) if info is None else None
    return _listing_out(sku, info, crawl_price)


@router.put("/skus/{sku_code}", summary="保存上架信息", response_model=ListingInfoOut)
def save_listing(
    sku_code: str,
    body: ListingInfoUpdate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status not in (SkuStatus.IN_STOCK,) or sku.reserve_source:
        raise HTTPException(status_code=400, detail="仅对在库且未锁定的 SKU 填写上架信息")
    if body.price is None or body.price <= 0:
        raise HTTPException(status_code=400, detail="售价必须大于 0,请填写真实售价后再保存")
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    if not info:
        info = SkuListingInfo(sku_id=sku.id, created_by_id=user.id)
        db.add(info)
    info.title = body.title
    info.desc = body.desc
    info.price = body.price
    info.original_price = body.original_price
    info.express_fee = body.express_fee
    raw_imgs = body.images[:9] if body.images else (sku.images or [])[:9]
    # 存干净原始 URL，不存短效签名 URL（否则重发复用过期签名 → push_media 失败）
    new_imgs = [strip_oss_signature(u) for u in raw_imgs]
    # 人在填表页换了图 = 不用那张待确认的 AI 图了;原样保存不算确认(还得在上架页看一眼点确认)
    if info.ai_image_unconfirmed and new_imgs != [strip_oss_signature(u) for u in (info.images or [])]:
        info.ai_image_unconfirmed = False
    info.images = new_imgs
    info.stuff_status = body.stuff_status
    info.status = ListingInfoStatus.READY
    # 上架短编码:进入上架流程即分配(幂等),作内部标识
    ensure_short_code(db, sku)
    db.commit()
    db.refresh(info)
    return _listing_out(sku, info)


async def _publish_sku_response(
    db: Session,
    sku_code: str,
    shop_ids: list[str] | None,
    shop_images: dict[str, list[str]] | None = None,
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status not in (SkuStatus.IN_STOCK,) or sku.reserve_source:
        raise HTTPException(status_code=400, detail="仅对在库且未锁定的 SKU 上架")
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    if approval_required(db):
        # 开了上架审批：价和图以批过的为准，上架信息只提供标题描述；也不走缺图 AI 兜底
        if not settings.gc_publish_enabled:
            raise HTTPException(status_code=400, detail="群控上架未启用，请联系管理员开启 GC_PUBLISH_ENABLED")
        ensure_short_code(db, sku)
        try:
            rows = await gc_publish_shops(db, sku, info, shop_ids)
        except (GcBridgeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {"gc": True, "async": True, "job_id": rows[0].gc_job_id if rows else None, "shops": len(rows)}
    if not info or info.status not in (
        ListingInfoStatus.READY,
        ListingInfoStatus.CREATED,
        ListingInfoStatus.PUBLISHED,
        ListingInfoStatus.FAILED,
        ListingInfoStatus.PUBLISHING,
    ):
        raise HTTPException(status_code=400, detail="请先保存上架信息")
    # 防御:历史 SKU(功能上线前已建上架信息)在发布前补齐短编码
    ensure_short_code(db, sku)
    # 群控(真机)上架:异步建 publish_batch 作业,店铺置 LISTING,LISTED 由回写确认。
    if not settings.gc_publish_enabled:
        raise HTTPException(status_code=400, detail="群控上架未启用，请联系管理员开启 GC_PUBLISH_ENABLED")
    if shop_images is not None:
        # 员工给每个店铺挑了图:人看过了,不走缺图 AI 兜底
        try:
            rows = await gc_publish_shops(db, sku, info, shop_ids, shop_images=shop_images)
        except (GcBridgeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {"gc": True, "async": True, "job_id": rows[0].gc_job_id if rows else None, "shops": len(rows)}
    # 没有商品图时先 AI 生成主图、出图后自动上架(同自动上架的兜底),而不是让群控拒收「缺少商品图」
    try:
        rows, waiting_image = await publish_or_wait_for_image(db, sku, info, shop_ids)
    except GcBridgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if waiting_image:
        return {"gc": True, "async": True, "ai_image": True, "job_id": None, "shops": len(rows),
                "message": "这个货没有商品图,正在用 AI 生成主图(约 1 分钟),生成好后自动上架"}
    return {"gc": True, "async": True, "job_id": rows[0].gc_job_id if rows else None,
            "shops": len(rows)}


@router.post("/skus/{sku_code}/publish", summary="发布到所选店铺")
async def publish_selected(
    sku_code: str,
    body: PublishRequest | None = None,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    practice.gate(db, user)
    shop_ids = body.sale_shop_ids if body else None
    return await _publish_sku_response(db, sku_code, shop_ids, body.shop_images if body else None)


@router.get("/skus/{sku_code}/image-options", summary="上架前按店铺选图的候选:这件货自己的图 + 图片爬虫搜到的同款图")
def image_options(
    sku_code: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    return shop_images_svc.options(db, sku)


@router.get("/skus/{sku_code}/listing-images", summary="上架图管理:各号用的图、这件货所有的图、爬虫同款图")
def listing_images(sku_code: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    out = shop_images_svc.overview(db, sku)
    out["can_edit"] = user.role in (StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)
    return out


@router.put("/skus/{sku_code}/shops/{shop_id}/images", summary="改一个号用的上架图(下次发布 / 链接焕新才换到闲鱼上)")
def set_shop_images(
    sku_code: str,
    shop_id: str,
    body: ShopImagesSet,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    try:
        row = shop_images_svc.save_for_shop(db, sku, shop_id, body.images)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "own": bool(row.images), "live": row.publish_status == ShopListingStatus.LISTED}


@router.put("/skus/{sku_code}/image-status", summary="素材分池:把一张候选图标成淘汰(写原因)或改回可用;淘汰的不再出现在候选里")
def set_image_status(
    sku_code: str,
    body: ImageMaterialSet,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    try:
        return shop_images_svc.mark_image(db, sku, body.url, body.status, body.reason, user.name or user.username)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/skus/{sku_code}/publish-all", summary="发布到全部店铺")
async def publish_all(
    sku_code: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    practice.gate(db, user)
    return await _publish_sku_response(db, sku_code, None)


def _sku_and_info(db: Session, sku_code: str) -> tuple[Sku, SkuListingInfo]:
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    if not info:
        raise HTTPException(status_code=400, detail="请先保存上架信息")
    return sku, info


@router.post("/skus/{sku_code}/ai-image/confirm", summary="确认 AI 生成的主图(确认后在等的店铺自动上架)")
def confirm_ai_image(
    sku_code: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    _sku, info = _sku_and_info(db, sku_code)
    try:
        n = ai_image_publish.confirm(db, info)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "shops": n,
            "message": f"已确认,{n} 个店铺马上开始上架" if n else "已确认,点上架即可发布"}


@router.post("/skus/{sku_code}/ai-image/regenerate", summary="重新生成 AI 主图(可补一句品类)")
def regenerate_ai_image(
    sku_code: str,
    body: AiImageRegenerateRequest | None = None,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    sku, info = _sku_and_info(db, sku_code)
    try:
        ai_image_publish.regenerate(db, sku, info, body.hint if body else "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "message": "正在重新生成主图(约 1 分钟)"}


@router.get("/skus/{sku_code}/shops", summary="查询店铺上架状态", response_model=list[ShopListingOut])
async def shop_listings(sku_code: str, db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    # 快照构建(含 gc 回写)与 WS 推送共用,见 services/listing_shops.py
    return await build_shops_payload(db, sku)


@router.put("/skus/{sku_code}/shops/{shop_id}/worry-free", summary="设置该店铺此商品的无忧卖(覆盖账号默认)")
def set_shop_worry_free(
    sku_code: str,
    shop_id: str,
    body: WorryFreeSet,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    """按(商品×店铺=账号)设置无忧卖覆盖:worry_free_sell=None 清除覆盖(回落账号默认)。"""
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if not db.query(SaleShop).filter(SaleShop.id == shop_id).first():
        raise HTTPException(status_code=404, detail="店铺不存在")
    row = (
        db.query(SkuShopListing)
        .filter(SkuShopListing.sku_id == sku.id, SkuShopListing.sale_shop_id == shop_id)
        .first()
    )
    if not row:
        row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop_id)
        db.add(row)
    row.worry_free_sell = body.worry_free_sell
    db.commit()
    return {"ok": True, "worry_free_sell": row.worry_free_sell}


@router.get("/skus/{sku_code}/stock-age", summary="查询库龄和自动上架情况", response_model=StockAgeOut)
async def get_stock_age(sku_code: str, db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    return await stock_age_svc.build_stock_age(db, sku)


@router.put("/stock-age-thresholds", summary="修改库龄的三条线")
def set_stock_age_thresholds(
    body: StockAgeThresholdsIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    try:
        return stock_age_svc.save_thresholds(db, body.target_days, body.clearance_days, body.max_days, user.id)
    except stock_age_svc.StockAgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/skus/{sku_code}/auto-refresh", summary="暂停 / 推迟这件货的自动上架")
def set_sku_auto_refresh(
    sku_code: str,
    body: AutoRefreshSet,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    try:
        stock_age_svc.set_auto_refresh(sku, body.model_dump(exclude_unset=True))
    except stock_age_svc.StockAgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return {"ok": True}


@router.post("/skus/{sku_code}/refresh-now", summary="立即重新上架（删掉旧链接重发）")
async def refresh_sku_now(
    sku_code: str,
    body: RefreshNowRequest | None = None,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    practice.gate(db, user)
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    try:
        return await stock_age_svc.refresh_now(db, sku, body.shop_ids if body else None, user.id)
    except stock_age_svc.StockAgeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _delist_sku_response(db: Session, sku_code: str, shop_ids: list[str] | None):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status != SkuStatus.IN_STOCK:
        raise HTTPException(status_code=400, detail="仅对在库 SKU 下架")
    # 群控(真机)下架:异步建 delist_sku 作业,DELISTED 由回写确认。
    if not settings.gc_publish_enabled:
        raise HTTPException(status_code=400, detail="群控上架未启用，请联系管理员开启 GC_PUBLISH_ENABLED")
    try:
        rows = await gc_delist_shops(db, sku, shop_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not rows:
        raise HTTPException(status_code=400, detail="该商品未在任何店铺上架")
    return {"ok": True, "async": True, "requested": len(rows),
            "job_id": rows[0].gc_job_id if rows else None}


@router.post("/skus/{sku_code}/delist", summary="下架所选店铺")
async def delist_selected(
    sku_code: str,
    body: DelistRequest | None = None,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    shop_ids = body.sale_shop_ids if body else None
    return await _delist_sku_response(db, sku_code, shop_ids)


@router.post("/skus/{sku_code}/delist-all", summary="下架全部店铺")
async def delist_all(
    sku_code: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)),
):
    return await _delist_sku_response(db, sku_code, None)
