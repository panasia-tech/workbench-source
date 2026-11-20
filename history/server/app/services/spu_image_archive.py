"""SPU 共享同款图库:把爬虫审核通过的整池图写进 ERP 商品档案(2026-11-11)。

背景:spu_image_search.pool_images 是任务态 JSON——每次重搜覆盖、最多几十张、
没有单图状态/排序/唯一约束;审核通过后也只留一张 reference_url 给 AI 重绘。
上架页要按型号给几十个店铺分图,需要一份可跨重搜保留、按「品牌+型号」共享的档案。

本模块只读写 warehouse_spu_image,不碰 Sku.images / SkuListingInfo.images:
同款图是候选,不是这一件的实拍;上架页仍按“实拍/同款”分开显示。
"""
from __future__ import annotations

import hashlib
from datetime import datetime

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import SpuImageSearch, WarehouseSpu, WarehouseSpuImage
from app.services.oss_media import strip_oss_signature

MAX_ARCHIVE_IMAGES = 60


def model_key(spu: WarehouseSpu) -> str:
    """同款查找键:品牌+型号,去空白、casefold。型号为空时退回 spu_code。"""
    brand = " ".join((spu.brand or "").split())
    model = " ".join((spu.model or "").split())
    key = f"{brand} {model}".strip().casefold()
    return key or spu.spu_code.casefold()


def clean_url(url: str | None) -> str:
    return strip_oss_signature(url) or ""


def url_hash(url: str) -> str:
    return hashlib.md5(clean_url(url).encode("utf-8")).hexdigest()


def _row_for(db: Session, spu_id: str, hashed: str) -> WarehouseSpuImage | None:
    return (
        db.query(WarehouseSpuImage)
        .filter(WarehouseSpuImage.spu_id == spu_id, WarehouseSpuImage.url_hash == hashed)
        .first()
    )


def _apply_metadata(row: WarehouseSpuImage, image: dict, order: int, task_id: str | None) -> None:
    row.crawler_url = (image.get("crawler_url") or "")[:1024] or None
    row.source_url = (image.get("source_url") or "")[:1024] or None
    row.width = image.get("width") or None
    row.height = image.get("height") or None
    row.watermark = (image.get("watermark") or "")[:16] or None
    row.quality_grade = (image.get("quality_grade") or "")[:8] or None
    row.quality_score = image.get("quality_score")
    row.quality_flags = image.get("quality_flags") or None
    row.product_confidence = image.get("product_confidence")
    row.score = image.get("score")
    row.sort_order = order
    row.crawler_task_id = task_id


def upsert_from_pool(
    db: Session,
    spu: WarehouseSpu,
    row: SpuImageSearch,
    *,
    approved: bool = False,
    approved_by: str | None = None,
    cover_crawler_url: str | None = None,
    source: str = WarehouseSpuImage.SOURCE_CRAWLER,
) -> int:
    """把审核通过的整池图幂等写进档案,返回本次写入/更新的条数。

    只有爬虫员工点过「图片合格」(approved=True)才允许写入;待审核任务调用返回 0。
    不删除本次池里没有的旧图:重搜结果可能只是换了一个查询来源,
    旧图仍可能有用;员工标“需处理”走 mark_task_rejected 整批置 rejected。
    """
    if not approved:
        return 0
    now = datetime.utcnow()
    key = model_key(spu)
    count = 0
    cover_set = cover_crawler_url is None
    seen_hashes: set[str] = set()
    for order, image in enumerate(list(row.pool_images or [])[:MAX_ARCHIVE_IMAGES]):
        url = clean_url(image.get("url"))
        if not url:
            continue
        hashed = url_hash(url)
        if hashed in seen_hashes:
            continue
        seen_hashes.add(hashed)
        item = _row_for(db, spu.id, hashed)
        if item is None:
            item = WarehouseSpuImage(
                spu_id=spu.id,
                model_key=key,
                url=url,
                url_hash=hashed,
                source=source,
                status=WarehouseSpuImage.APPROVED,
            )
            db.add(item)
        item.model_key = key
        item.url = url
        item.source = source
        item.status = WarehouseSpuImage.APPROVED
        item.is_cover = False
        _apply_metadata(item, image, order, row.task_id)
        if not cover_set and image.get("crawler_url") == cover_crawler_url:
            item.is_cover = True
            cover_set = True
        item.approved_by = (approved_by or row.reviewer or "")[:64] or None
        item.approved_at = now
        count += 1
    if not cover_set:
        first = (
            db.query(WarehouseSpuImage)
            .filter(
                WarehouseSpuImage.spu_id == spu.id,
                WarehouseSpuImage.status == WarehouseSpuImage.APPROVED,
            )
            .order_by(WarehouseSpuImage.sort_order, WarehouseSpuImage.id)
            .first()
        )
        if first is not None:
            first.is_cover = True
    db.flush()
    row.archive_count = (
        db.query(WarehouseSpuImage)
        .filter(
            WarehouseSpuImage.spu_id == spu.id,
            WarehouseSpuImage.status == WarehouseSpuImage.APPROVED,
        )
        .count()
    )
    row.archived_at = now
    db.flush()
    return count


def images_for_spu(
    db: Session, spu: WarehouseSpu, *, limit: int = MAX_ARCHIVE_IMAGES
) -> list[dict]:
    """上架页可用的同款图:本 SPU 优先,再补同「品牌+型号」的其他 SPU;按主图/爬虫顺序。"""
    key = model_key(spu)
    rows = (
        db.query(WarehouseSpuImage)
        .filter(
            WarehouseSpuImage.status == WarehouseSpuImage.APPROVED,
            or_(WarehouseSpuImage.spu_id == spu.id, WarehouseSpuImage.model_key == key),
        )
        .all()
    )
    # 本 SPU 的行优先;同 url 只留一条
    rows.sort(
        key=lambda item: (
            0 if item.spu_id == spu.id else 1,
            0 if item.is_cover else 1,
            item.sort_order or 0,
            item.id,
        )
    )
    seen: set[str] = set()
    out: list[dict] = []
    for item in rows:
        if item.url_hash in seen:
            continue
        seen.add(item.url_hash)
        out.append(
            {
                "url": item.url,
                "crawler_url": item.crawler_url,
                "source_url": item.source_url,
                "width": item.width,
                "height": item.height,
                "watermark": item.watermark,
                "quality_grade": item.quality_grade,
                "quality_score": item.quality_score,
                "quality_flags": item.quality_flags,
                "product_confidence": item.product_confidence,
                "score": item.score,
                "is_cover": item.is_cover,
                "source": item.source,
            }
        )
        if len(out) >= limit:
            break
    return out


def mark_task_rejected(db: Session, task_id: str | None) -> int:
    """审核“需处理”:这个任务写进档案的图整批标 rejected,上架页不再给。"""
    if not task_id:
        return 0
    db.flush()
    rows = (
        db.query(WarehouseSpuImage)
        .filter(WarehouseSpuImage.crawler_task_id == task_id)
        .all()
    )
    for item in rows:
        item.status = WarehouseSpuImage.REJECTED
    db.flush()
    return len(rows)


def rebuild_from_pool(db: Session) -> dict:
    """只读已审核通过(READY)的 pool_images 重建档案,不联网。迁移/补数据脚本用,幂等。"""
    query = db.query(SpuImageSearch).filter(
        SpuImageSearch.status == SpuImageSearch.READY,
        SpuImageSearch.pool_images.isnot(None),
    )
    spus = 0
    images = 0
    skipped = 0
    for row in query.all():
        spu = db.get(WarehouseSpu, row.spu_id)
        if spu is None or not row.pool_images:
            skipped += 1
            continue
        images += upsert_from_pool(db, spu, row, approved=True)
        spus += 1
    db.commit()
    return {"spus": spus, "images": images, "skipped": skipped}
