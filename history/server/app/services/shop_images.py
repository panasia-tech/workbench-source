"""上架前按店铺选图(2026-11-05 定):勾了几个店铺,员工就给每个店铺挑一组图,店铺之间不能用同一张。

候选 = 这件货自己的图(上架信息里的,没有就用实拍图)+ 已经挂在各店铺上的图 + 图片爬虫按型号搜到的正式图(已转存图床)。
爬虫图直接挂原图,不再让 AI 重画——挑哪张由人负责,海报、水印、价格要员工自己避开。

上架图管理(禅道 #102,2026-11-10):商品详情里按账号看、改每个号用的图。一个号的图 = 它单独挑过的那组,
没挑过就是公用那组(上架信息的图)。改了只存进店铺行,下次发布 / 链接焕新才换到闲鱼上。
各号的图一张都不能重复(11-10 用户重申 11-05 的口径),所以不做「复制 / 同步到其他账号」。

素材分池(2026-11-10,services/image_material.py):每张候选图可用 / 待复核 / 淘汰。淘汰的不再是候选
(上架挑图、加图都看不到,validate / save_for_shop 也不收),在管理页「淘汰」里看得到、能改回来。
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.enums import ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing, SpuImageSearch
from app.services import image_material, product_image, spu_image_archive
from app.services.oss_media import (
    public_url_to_object_key,
    sign_oss_publish_image_url,
    sign_oss_thumb_url,
    strip_oss_signature,
)
from app.services.spu_resolve import MATCH_MODEL, resolve_spu

MAX_PER_SHOP = 9

_CRAWL_STATUS = {
    SpuImageSearch.SEARCHING: "爬取中",
    SpuImageSearch.REVIEWING: "待审核",
    SpuImageSearch.READY: "已合格",
    SpuImageSearch.REJECTED: "需处理",
    SpuImageSearch.FAILED: "未搜到",
}


# 在闲鱼上挂着或正在挂的号:它用的图(自己那组或公用那组)别的号不能再用
_LIVE = (ShopListingStatus.LISTING, ShopListingStatus.LISTED)


def _clean(urls) -> list[str]:
    out: list[str] = []
    for url in urls or []:
        clean = strip_oss_signature(url) if isinstance(url, str) else ""
        if clean and clean not in out:
            out.append(clean)
    return out


def _own_images(db: Session, sku: Sku) -> list[str]:
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    # 待确认的 AI 图没人看过,不当候选
    raw = info.images if info and info.images and not info.ai_image_unconfirmed else sku.images
    return _clean(raw)


def _shop_rows(db: Session, sku: Sku) -> list[SkuShopListing]:
    return db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id).all()


def _all_candidates(db: Session, sku: Sku) -> list[str]:
    """自己的图 + 已经挂在各店铺上的图(管理页上传的图只存在店铺行上),含淘汰的。"""
    out = _own_images(db, sku)
    for row in _shop_rows(db, sku):
        out += [u for u in _clean(row.images) if u not in out]
    return out


def _judge_own(db: Session, sku: Sku, urls: list[str]) -> dict[str, image_material.Verdict]:
    """这件货自己的图(实拍、上架图、上传、AI 图)的状态。规则只有一条:封面不在实拍图里的淘汰。
    挂到号上的爬虫图照爬虫图的规则算(水印的还是待复核)。"""
    cover = strip_oss_signature(sku.cover_url) if sku.cover_url else ""
    photos = set(_clean(sku.images))
    marks = image_material.marks_for(db, urls)
    pool = {p["url"]: v for p, v in _crawled_all(db, sku)[0]} if urls else {}
    out = {}
    for u in urls:
        if u in pool:
            out[u] = pool[u]
            continue
        rule = (image_material.Verdict(image_material.REJECTED, "封面图，可能有买家订单截图")
                if u == cover and u not in photos else image_material.Verdict(image_material.USABLE))
        out[u] = image_material.verdict(rule, marks.get(u))
    return out


def _candidates(db: Session, sku: Sku) -> list[str]:
    """能当候选的自家图:_all_candidates 去掉淘汰的。"""
    urls = _all_candidates(db, sku)
    judged = _judge_own(db, sku, urls)
    return [u for u in urls if judged[u].status != image_material.REJECTED]


def upload_dir(sku: Sku) -> str:
    """管理页给这件货上传的上架图放这里;只认这个目录,别的货的图(含库位图)不能借道挂上去。"""
    return f"listing/shop-images/{sku.sku_code}/"


def _uploaded_here(sku: Sku, url: str) -> bool:
    key = public_url_to_object_key(url) or ""
    return key.startswith(upload_dir(sku))


def _held_by_others(db: Session, sku: Sku, shop_ids: set[str]) -> dict[str, str]:
    """别的号占着的图 → 店铺名。自己单独挑过图的号(卖掉的除外)占着自己那组;
    在架 / 上架中、用公用图的号占着公用那组。"""
    common = None
    held: dict[str, str] = {}
    for row in _shop_rows(db, sku):
        if row.sale_shop_id in shop_ids or row.publish_status == ShopListingStatus.SOLD:
            continue
        if row.images:
            urls = _clean(row.images)
        elif row.publish_status in _LIVE:
            if common is None:
                common = _own_images(db, sku)
            urls = common
        else:
            continue
        shop = db.get(SaleShop, row.sale_shop_id)
        for u in urls:
            held.setdefault(u, shop.label if shop else "别的店铺")
    return held


def _crawled_all(db: Session, sku: Sku, *, request: bool = False) -> tuple[list[tuple[dict, image_material.Verdict]], str | None]:
    """爬虫同款图和各自的状态(含淘汰的),顺序:可用在前、待复核在后,同一档照爬虫排的。

    只读 warehouse_spu_image 档案(审核通过后整池写入),没有档案再回退
    spu_image_search.pool_images(老数据/审核中的任务)。
    打开上架页(request=True)只给从没搜过的发起搜图;搜过的不补搜,免得把已合格货打回爬取中。
    """
    match = resolve_spu(db, sku)
    if not match.matched:
        return [], "未匹配"
    # 仅按型号命中、品牌不一致或同名多 SPU:不自动复用共享档案,避免错款图
    how = getattr(match, "how", None)
    ambiguous = getattr(match, "ambiguous", 0) or 0
    spu_brand = getattr(match.spu, "brand", "") or ""
    if how == MATCH_MODEL and (
        ambiguous > 1
        or (sku.brand and spu_brand and sku.brand.strip().casefold() != spu_brand.strip().casefold())
    ):
        return [], "型号匹配不确定"
    row = db.query(SpuImageSearch).filter(SpuImageSearch.spu_id == match.spu.id).first()
    if row is None and request:
        # 没搜过就顺手发起,下次打开就有图挑了
        row = product_image.request_for_spu(db, match.spu)
        db.commit()
    if row is not None and row.status == SpuImageSearch.REJECTED:
        return [], _CRAWL_STATUS.get(row.status)
    images = spu_image_archive.images_for_spu(db, match.spu)
    if not images:
        images = product_image.pool_for_spu(db, match.spu.id)
    judged = image_material.judge_crawled(db, images)
    judged.sort(key=lambda pv: pv[1].status == image_material.REVIEW)
    return judged, _CRAWL_STATUS.get(row.status) if row else None


def _crawl_meta(db: Session, sku: Sku) -> dict:
    """上架页诊断字段:SPU 匹配情况、抓取进度、档案/池子数量、爬虫是否配置。"""
    match = resolve_spu(db, sku)
    meta: dict = {
        "crawler_enabled": product_image.enabled(),
        "spu_match": {
            "matched": match.matched,
            "how": getattr(match, "how", None),
            "ambiguous": getattr(match, "ambiguous", 0) or 0,
            "spu_code": getattr(match.spu, "spu_code", None) if match.spu else None,
            "brand_model": getattr(match.spu, "brand_model", None) if match.spu else None,
        },
        "crawl_progress": None,
        "archive_count": 0,
        "pool_count": 0,
        "crawl_error": None,
    }
    if not match.matched:
        return meta
    row = db.query(SpuImageSearch).filter(SpuImageSearch.spu_id == match.spu.id).first()
    if row is not None:
        archive_count = row.archive_count or 0
        if not archive_count:
            archive_count = len(spu_image_archive.images_for_spu(db, match.spu))
        meta.update(
            {
                "crawl_progress": row.search_progress,
                "archive_count": archive_count,
                "pool_count": len(row.pool_images or []),
                "crawl_error": row.error,
            }
        )
    else:
        meta["archive_count"] = len(spu_image_archive.images_for_spu(db, match.spu))
    return meta


def _crawled(db: Session, sku: Sku) -> tuple[list[dict], str | None]:
    """能当候选的爬虫同款图(淘汰的不要)。"""
    judged, status = _crawled_all(db, sku)
    return [p for p, v in judged if v.status != image_material.REJECTED], status


def _crawled_item(p: dict, v: image_material.Verdict) -> dict:
    return {"source_url": p.get("source_url"), "grade": p.get("quality_grade") or "",
            "flags": p.get("quality_flags") or [], "width": p.get("width"),
            "height": p.get("height"), "cover": bool(p.get("is_cover")),
            **v.as_dict()}


def options(db: Session, sku: Sku) -> dict:
    """上架挑图的候选。淘汰的不给;待复核的照给(角标写毛病),自动分配跳过它们。"""
    all_own = _all_candidates(db, sku)
    judged_own = _judge_own(db, sku, all_own)
    own = [u for u in all_own if judged_own[u].status != image_material.REJECTED]
    judged, status = _crawled_all(db, sku, request=True)
    seen = set(all_own)
    crawled = []
    rejected = len(all_own) - len(own)
    photo_set = set(_clean(sku.images))
    for p, v in judged:
        if p["url"] in seen:
            continue
        seen.add(p["url"])
        if v.status == image_material.REJECTED:
            rejected += 1
            continue
        crawled.append(
            {
                "url": p["url"],
                "thumb": sign_oss_thumb_url(p["url"]),
                # 看大图用:长边压到 1600(同发布图),不用 120x120 缩略图,也不给几 MB 的手机原图
                "preview": sign_oss_publish_image_url(p["url"]),
                "kind": "同款",
                "approved": status == "已合格",
                **_crawled_item(p, v),
            }
        )
    photos = []
    for u in own:
        photos.append(
            {
                "url": u,
                "thumb": sign_oss_thumb_url(u),
                "preview": sign_oss_publish_image_url(u),
                "kind": _kind(sku, u, photo_set),
                **judged_own[u].as_dict(),
            }
        )
    payload = {
        "photos": photos,
        "crawled": crawled,
        "crawl_status": status,
        # 已经挂在别的号上的图 → 店铺名;上架页把它们标成「已给某号用了」
        "held": _held_by_others(db, sku, set()),
        "rejected_count": rejected,
        "reject_reasons": list(image_material.REASONS),
    }
    payload.update(_crawl_meta(db, sku))
    return payload


def validate(db: Session, sku: Sku, shop_images: dict[str, list[str]], shop_ids: list[str]) -> dict[str, list[str]]:
    """员工挑的图核一遍:每个要上的店铺都要有图,只能用候选里的图,同一张图不能给两个店铺。"""
    allowed = set(_candidates(db, sku)) | {p["url"] for p in _crawled(db, sku)[0]}
    labels = {s.id: s.label for s in db.query(SaleShop).filter(SaleShop.id.in_(shop_ids)).all()}
    # 这次没勾、但在闲鱼上挂着的号,它的图也不能拿来用
    used: dict[str, str] = _held_by_others(db, sku, set(shop_ids))
    out: dict[str, list[str]] = {}
    for shop_id in shop_ids:
        name = labels.get(shop_id, shop_id)
        urls = list(dict.fromkeys(strip_oss_signature(u) for u in (shop_images.get(shop_id) or []) if u))
        if not urls:
            raise ValueError(f"店铺「{name}」还没选图")
        if len(urls) > MAX_PER_SHOP:
            raise ValueError(f"店铺「{name}」最多选 {MAX_PER_SHOP} 张图")
        for url in urls:
            if url not in allowed:
                raise ValueError(f"店铺「{name}」选的图不在这件货的候选里,请刷新后重选")
            if url in used:
                raise ValueError(f"店铺「{name}」和「{used[url]}」用了同一张图,每个店铺的图不能重复")
            used[url] = name
        out[shop_id] = urls
    # 换个文件名、重新上传的同一张图上面比不出来:按长相再比一遍(首图、整组、同一张),判不了的要人确认一次
    from app.services.image_similarity import check_shop_images
    check_shop_images(db, sku, out, labels)
    return out


# ---------------------------------------------------------------- 上架图管理(#102)

def _img(url: str) -> dict:
    return {"url": url, "thumb": sign_oss_thumb_url(url), "preview": sign_oss_publish_image_url(url)}


def readonly_reason(db: Session, sku: Sku) -> str | None:
    from app.services.listing_approval import approval_required

    if sku.status != SkuStatus.IN_STOCK or sku.reserve_source:
        return "货不在库或已锁定,上架图只能看"
    if approval_required(db):
        return "开了上架审批,各号的图在审批里改"
    return None


def _kind(sku: Sku, url: str, photos: set[str]) -> str:
    if url in photos:
        return "实拍"
    if _uploaded_here(sku, url):
        return "上传"
    return "AI图" if "/ai-redraw/" in url else "上架"


def overview(db: Session, sku: Sku) -> dict:
    """上架图管理页:各号用的图、这件货所有图、爬虫同款图、淘汰的图。只读,不发起搜图。"""
    common = _own_images(db, sku)
    rows = _shop_rows(db, sku)
    shops = {s.id: s for s in db.query(SaleShop).filter(SaleShop.id.in_([r.sale_shop_id for r in rows])).all()}
    rows = sorted((r for r in rows if r.sale_shop_id in shops),
                  key=lambda r: (shops[r.sale_shop_id].sort_order or 0, shops[r.sale_shop_id].label or ""))

    all_own = _all_candidates(db, sku)
    judged_own = _judge_own(db, sku, all_own)
    judged_crawled, status = _crawled_all(db, sku)
    state = dict(judged_own)
    for p, v in judged_crawled:
        state.setdefault(p["url"], v)

    used_by: dict[str, list[str]] = {}
    accounts = []
    for row in rows:
        shop = shops[row.sale_shop_id]
        own = bool(row.images)
        urls = _clean(row.images) if own else common
        if row.publish_status != ShopListingStatus.SOLD:
            for u in urls:
                used_by.setdefault(u, []).append(shop.label)
        accounts.append({
            "shop_id": shop.id,
            "shop_label": shop.label,
            "publish_status": row.publish_status,
            "gc_pending": bool(row.gc_job_id),
            "own": own,
            # rejected:这个号还挂着已淘汰的图,写原因,页面上标红让人换掉
            "images": [{**_img(u), "rejected": state[u].reason if u in state and state[u].status == image_material.REJECTED else ""}
                       for u in urls],
        })
    # 用公用图的在架号不止一个:它们在闲鱼上是同一组图
    sharing = [a["shop_label"] for a in accounts if not a["own"] and a["publish_status"] in _LIVE]
    for a in accounts:
        a["shares_with"] = [x for x in sharing if x != a["shop_label"]] if a["shop_label"] in sharing else []

    photos = set(_clean(sku.images))
    library, rejected = [], []
    for u in all_own:
        item = {**_img(u), "kind": _kind(sku, u, photos), "used_by": used_by.get(u, []), **judged_own[u].as_dict()}
        (rejected if judged_own[u].status == image_material.REJECTED else library).append(item)
    seen = set(all_own)
    crawled = []
    for p, v in judged_crawled:
        if p["url"] in seen:
            continue
        seen.add(p["url"])
        item = {**_img(p["url"]), "kind": "同款", "used_by": used_by.get(p["url"], []), **_crawled_item(p, v)}
        (rejected if v.status == image_material.REJECTED else crawled).append(item)

    live = [a for a in accounts if a["publish_status"] in _LIVE]
    shown = {i["url"] for a in live for i in a["images"]} or set(common)
    return {
        "sku_code": sku.sku_code,
        "product_name": sku.product_name,
        "location_code": sku.location_code,
        "readonly_reason": readonly_reason(db, sku),
        "upload_dir": upload_dir(sku),
        "max_per_shop": MAX_PER_SHOP,
        "common": [_img(u) for u in common],
        "accounts": accounts,
        "library": library,
        "crawled": crawled,
        "rejected": rejected,
        "reject_reasons": list(image_material.REASONS),
        "crawl_status": status,
        "image_count": len(shown),
        "live_count": len(live),
    }


def save_for_shop(db: Session, sku: Sku, shop_id: str, images: list[str]) -> SkuShopListing:
    """改一个号用的图。空列表 = 回到公用那组。只存店铺行,不动闲鱼上的链接。"""
    why = readonly_reason(db, sku)
    if why:
        raise ValueError(why)
    row = (
        db.query(SkuShopListing)
        .filter(SkuShopListing.sku_id == sku.id, SkuShopListing.sale_shop_id == shop_id)
        .first()
    )
    if row is None:
        raise LookupError("这个号还没上过这件货,先去店铺上架")
    if row.publish_status == ShopListingStatus.SOLD:
        raise ValueError("这个号上的已经卖掉了")
    urls = _clean(images)
    if len(urls) > MAX_PER_SHOP:
        raise ValueError(f"一个号最多 {MAX_PER_SHOP} 张图")
    gone = _rejected_reasons(db, sku, urls)
    if gone:
        raise ValueError(f"有一张图已经淘汰了({next(iter(gone.values()))}),先把它拿掉")
    allowed = set(_candidates(db, sku)) | {p["url"] for p in _crawled(db, sku)[0]}
    for u in urls:
        if u not in allowed and not _uploaded_here(sku, u):
            raise ValueError("有图不在这件货的图里,请刷新后重选")
    held = _held_by_others(db, sku, {shop_id})
    mine = urls or _own_images(db, sku)
    for u in mine:
        if u in held:
            what = "公用图里有一张" if not urls else "有一张图"
            raise ValueError(f"{what}已经给「{held[u]}」用了,每个号的图不能重复")
    row.images = urls or None
    db.commit()
    return row


# ---------------------------------------------------------------- 素材分池:标淘汰 / 改回可用

def _states(db: Session, sku: Sku) -> dict[str, image_material.Verdict]:
    """这件货所有候选图(自家的 + 爬虫同款,含淘汰的)→ 状态。"""
    state = dict(_judge_own(db, sku, _all_candidates(db, sku)))
    for p, v in _crawled_all(db, sku)[0]:
        state.setdefault(p["url"], v)
    return state


def _rejected_reasons(db: Session, sku: Sku, urls: list[str]) -> dict[str, str]:
    """这些图里已淘汰的 → 原因。刚上传、还没进任何候选的图没有结论,当可用。"""
    if not urls:
        return {}
    state = _states(db, sku)
    return {u: state[u].reason or "" for u in urls if u in state and state[u].status == image_material.REJECTED}


def mark_image(db: Session, sku: Sku, url: str, status: str, reason: str | None, staff_name: str | None) -> dict:
    """员工把一张候选图标成淘汰(要写原因)或改回可用。爬虫同款图按地址记,同型号的货一起生效。"""
    url = strip_oss_signature(url or "")
    own = _all_candidates(db, sku)
    spu_id = None
    if url not in own:
        match = resolve_spu(db, sku)
        pool: set[str] = set()
        if match.matched:
            pool = {p["url"] for p in product_image.pool_for_spu(db, match.spu.id)}
            pool |= {p["url"] for p in spu_image_archive.images_for_spu(db, match.spu)}
        if url not in pool:
            raise LookupError("这张图不在这件货的图里,请刷新")
        spu_id = match.spu.id
    image_material.set_mark(db, url, status, reason=reason, sku_id=sku.id, spu_id=spu_id, staff_name=staff_name)
    db.commit()
    used_by = []
    if status == image_material.REJECTED:
        common = None
        for row in _shop_rows(db, sku):
            if row.publish_status == ShopListingStatus.SOLD:
                continue
            if row.images:
                urls = _clean(row.images)
            else:
                if row.publish_status not in _LIVE:
                    continue
                common = _own_images(db, sku) if common is None else common
                urls = common
            if url in urls:
                shop = db.get(SaleShop, row.sale_shop_id)
                used_by.append(shop.label if shop else "别的店铺")
    v = _states(db, sku).get(url) or image_material.Verdict(image_material.USABLE)
    return {"url": url, **v.as_dict(), "used_by": used_by}
