"""图片爬虫对接的管理接口:看各 SPU 搜图到哪一步、手动发起、给缺图的在库货批量补搜。

员工审图不在这里,在爬虫自己的审核页 http://127.0.0.1:8000。
"""
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import require_roles
from app.enums import SkuStatus, StaffRole
from app.models import Sku, SpuImageSearch, Staff, WarehouseSpu, WarehouseSpuSku
from app.services import product_image, spu_image_archive
from app.services.oss_media import sign_oss_publish_image_url, sign_oss_thumb_url

router = APIRouter(prefix="/api/product-images", tags=["product-images"])

_STATUS_CN = {
    SpuImageSearch.SEARCHING: "爬取中",
    SpuImageSearch.REVIEWING: "等员工审核",
    SpuImageSearch.READY: "参考图可用",
    SpuImageSearch.REJECTED: "审核不通过",
    SpuImageSearch.FAILED: "未搜到",
}


class SpuImageSearchOut(BaseModel):
    spu_id: str
    spu_code: str
    query: str
    missing_photo_skus: int = 0
    task_id: str | None
    status: str
    status_label: str
    formal_count: int
    archive_count: int = 0
    crawl_progress: dict | None = None
    reference_url: str | None
    reference_preview: str | None
    source_url: str | None
    reviewer: str | None
    error: str | None
    checked_at: datetime | None
    updated_at: datetime | None


class SearchListOut(BaseModel):
    enabled: bool
    review_url: str
    counts: dict[str, int]
    # 在库、一张图都没有、还没搜过的型号数:点「批量补搜」会从这里挑
    pending_backfill: int
    items: list[SpuImageSearchOut]


class BackfillOut(BaseModel):
    requested: int
    skipped: int
    enabled: bool


def _out(row: SpuImageSearch, spu: WarehouseSpu | None, missing: int = 0) -> SpuImageSearchOut:
    return SpuImageSearchOut(
        spu_id=row.spu_id, spu_code=spu.spu_code if spu else "", query=row.query, missing_photo_skus=missing,
        task_id=row.task_id, status=row.status, status_label=_STATUS_CN.get(row.status, row.status),
        formal_count=row.formal_count or 0, archive_count=row.archive_count or 0,
        crawl_progress=row.search_progress, reference_url=row.reference_url,
        reference_preview=sign_oss_thumb_url(row.reference_url) if row.reference_url else None,
        source_url=row.source_url, reviewer=row.reviewer, error=row.error,
        checked_at=row.checked_at, updated_at=row.updated_at,
    )


def _missing_photo_counts(db: Session) -> dict[str, int]:
    """每个 SPU 下在库、一张图都没有的货有几件(图片字段是 JSON,放 Python 里判)。"""
    counts: dict[str, int] = {}
    rows = (
        db.query(Sku.images, WarehouseSpuSku.spu_id)
        .join(WarehouseSpuSku, WarehouseSpuSku.sku_code == Sku.sku_code)
        .filter(Sku.status == SkuStatus.IN_STOCK)
        .all()
    )
    for images, spu_id in rows:
        if not any(isinstance(u, str) and u.strip() for u in (images or [])):
            counts[spu_id] = counts.get(spu_id, 0) + 1
    return counts


@router.get("", summary="各 SPU 的搜图状态", response_model=SearchListOut)
def list_searches(
    status: str | None = Query(None, description="SEARCHING/REVIEWING/READY/REJECTED/FAILED"),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    missing = _missing_photo_counts(db)
    counts = {k: 0 for k in _STATUS_CN}
    searched: set[str] = set()
    for spu_id, st in db.query(SpuImageSearch.spu_id, SpuImageSearch.status).all():
        searched.add(spu_id)
        counts[st] = counts.get(st, 0) + 1
    q = db.query(SpuImageSearch, WarehouseSpu).outerjoin(WarehouseSpu, WarehouseSpu.id == SpuImageSearch.spu_id)
    if status:
        q = q.filter(SpuImageSearch.status == status)
    base = settings.product_image_base_url.rstrip("/")
    return SearchListOut(
        enabled=product_image.enabled(),
        # 审核页首次要带令牌(之后它种 7 天 cookie);接口只给管理员,所以直接把带令牌的链接给后台按钮
        review_url=f"{base}/employee?access_key={quote(settings.product_image_token)}" if base else "",
        counts=counts,
        pending_backfill=sum(1 for spu_id in missing if spu_id not in searched),
        items=[_out(row, spu, missing.get(row.spu_id, 0))
               for row, spu in q.order_by(SpuImageSearch.updated_at.desc()).limit(500).all()],
    )


@router.post("/spu/{spu_id}/search", summary="给这个 SPU 发起(或重新发起)搜图", response_model=SpuImageSearchOut)
def search_spu(
    spu_id: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    if not product_image.enabled():
        raise HTTPException(503, "图片爬虫没配置(PRODUCT_IMAGE_BASE_URL / PRODUCT_IMAGE_TOKEN)")
    spu = db.get(WarehouseSpu, spu_id)
    if spu is None:
        raise HTTPException(404, "没有这个 SPU")
    row = product_image.request_for_spu(db, spu, force=True)
    if row is None or row.status != SpuImageSearch.SEARCHING:
        raise HTTPException(502, "图片爬虫没接受这次搜图,稍后再试")
    db.commit()
    return _out(row, spu)


@router.get("/spu/{spu_id}/archive", summary="看这个 SPU 的同款图档案")
def get_archive(
    spu_id: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    spu = db.get(WarehouseSpu, spu_id)
    if spu is None:
        raise HTTPException(404, "没有这个 SPU")
    items = []
    for item in spu_image_archive.images_for_spu(db, spu, limit=200):
        items.append(
            {
                **item,
                "thumb": sign_oss_thumb_url(item["url"]),
                "preview": sign_oss_publish_image_url(item["url"]),
            }
        )
    return {"spu_id": spu_id, "spu_code": spu.spu_code, "count": len(items), "items": items}


@router.post("/spu/{spu_id}/archive/rebuild", summary="从爬虫图池重建这个 SPU 的档案(不联网)")
def rebuild_archive(
    spu_id: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    spu = db.get(WarehouseSpu, spu_id)
    if spu is None:
        raise HTTPException(404, "没有这个 SPU")
    row = db.query(SpuImageSearch).filter(SpuImageSearch.spu_id == spu_id).first()
    if row is None or not row.pool_images:
        raise HTTPException(400, "这个 SPU 还没有爬虫图池,先发起搜图")
    if row.status != SpuImageSearch.READY:
        raise HTTPException(400, "这个 SPU 还没审核通过,不能写档案")
    count = spu_image_archive.upsert_from_pool(
        db, spu, row, approved=True, approved_by=row.reviewer
    )
    db.commit()
    return {"spu_id": spu_id, "archived": count, "archive_count": row.archive_count or 0}


@router.post("/archive/backfill", summary="从已审核图池批量重建档案(不联网)")
def backfill_archive(
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    result = spu_image_archive.rebuild_from_pool(db)
    return {**result, "enabled": product_image.enabled()}


@router.post("/backfill", summary="给缺图的在库货所属 SPU 批量补搜", response_model=BackfillOut)
def backfill(
    limit: int = Query(30, ge=1, le=200, description="这次最多发起几个(爬虫一个约 3 分钟,串行排队)"),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    if not product_image.enabled():
        return BackfillOut(requested=0, skipped=0, enabled=False)
    searched = {sid for (sid,) in db.query(SpuImageSearch.spu_id).all()}
    missing = _missing_photo_counts(db)
    # 缺图的货多的型号先搜:一次补搜能让更多件货有参考图
    want = sorted((sid for sid in missing if sid not in searched), key=lambda sid: -missing[sid])
    spus = {s.id: s for s in db.query(WarehouseSpu).filter(WarehouseSpu.id.in_(want),
                                                          WarehouseSpu.enabled.is_(True)).all()}
    requested = skipped = 0
    for spu in [spus[sid] for sid in want if sid in spus][:limit]:
        row = product_image.request_for_spu(db, spu)
        if row is not None and row.status == SpuImageSearch.SEARCHING:
            requested += 1
        else:
            skipped += 1
        db.commit()
    return BackfillOut(requested=requested, skipped=skipped, enabled=True)
