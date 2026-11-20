"""图片爬虫对接:按 SPU 搜同款图,员工审过后转存一张当 AI 重绘的参考图(2026-11-04)。

爬虫是另一套服务(product-image-service,京东云,公网 http://127.0.0.1:8000):给它「品牌 型号」,
它去官网/Bing 等公开来源找图、按型号校验分成正式池和模糊池,员工在它的 /employee 页点「图片合格」或
「需处理」。ERP 这边只做三件事:
- 发起:手动上架缺图、又没有同款实拍图时,顺手给这个 SPU 发起一次搜图(没配爬虫就什么都不做);
- 跟进:后台每分钟问一轮在搜/在等审核的任务;员工审过「合格」→ 取正式池里最像的一张,下载转存到
  我们图床 spu-ref/,记成这个 SPU 的参考图;「需处理」或爬虫失败就记下原因,不用;
- 提供:ai_image_publish 找不到同款实拍图时拿这张当参考重绘。

为什么要审过才用:11-04 京东云实测 5 个型号,正式池里混着促销海报、保护壳广告、相近变体(4 Lite 当 4),
型号对上不等于图能用。即使审过,用它重绘的主图也要人确认才上架(ai_image_publish 里按 spu-ref/ 认)。
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import SpuImageSearch, WarehouseSpu
from app.services import spu_image_archive
from app.services.oss import upload_filename, upload_object
from app.services.oss_media import is_placeholder_oss

logger = logging.getLogger("product_image")

LOCK_KEY = "erp:product_image:poll"
POLL_SECONDS = 60
# 爬虫没搜到/出错的 SPU,过这么久才允许再发起(Bing 结果会变,但别每次上架都去撞一遍)
RETRY_FAILED_AFTER = timedelta(days=3)
# 参考图目录:ai_image_publish 靠这个前缀认出「照爬虫图重绘的」,要人确认才上架
REF_PREFIX = "spu-ref"
REF_MARKER = f"/{REF_PREFIX}/"
# 发起搜图是在人点上架的请求里同步做的:爬虫挂了最多耽误几秒
_TIMEOUT = httpx.Timeout(10.0, connect=3.0)
_MAX_IMAGE_BYTES = 15 * 1024 * 1024
# 上架选图:10 个店铺每店至少 1 张且不能重复,所以请求 40 张、目标 20-30 张可用。
SEARCH_LIMIT = 40
SEARCH_MIN_RESULTS = 20
RECALL_VERSION = 2
# 爬虫正式池转存上限(比请求值宽一点,给审核/淘汰留余量)
POOL_MAX = 60
# 爬虫 11-10 起给每张图打上架用图质量分(水印、海报字、拼图、人像、小图、白底),正式池按它排好序。
# grade:good 能直接用 / ok 凑合 / bad 别自动用;空 = 老任务没评过,当 ok。
# quality_text_ratio(文字占画面比例)爬虫还没给,给了就用来认纯文字图
QUALITY_FIELDS = ("quality_grade", "quality_flags", "quality_score", "quality_text_ratio")
# 尺寸、水印也存进图池:素材分池的规则(image_material)靠它们认头像、表情包、截图
META_FIELDS = ("width", "height", "watermark", "product_confidence", "score")


def enabled() -> bool:
    return bool(settings.product_image_base_url.strip() and settings.product_image_token.strip())


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=settings.product_image_base_url.rstrip("/"),
        cookies={"employee_access": settings.product_image_token},
        timeout=_TIMEOUT,
        follow_redirects=False,
    )


def spu_query(spu: WarehouseSpu) -> str:
    """搜图用的名字:对照表里的「品牌 型号」(和 resolve_spu 的 query、行情搜索词同一口径)。"""
    return " ".join((spu.brand_model or "").split())


def reference_for_spu(db: Session, spu_id: str | None) -> str | None:
    if not spu_id:
        return None
    row = db.query(SpuImageSearch).filter(SpuImageSearch.spu_id == spu_id).first()
    if row and row.status == SpuImageSearch.READY and row.reference_url:
        return row.reference_url
    # 老数据/回填档案没有 reference_url 时,用档案主图兜底
    spu = db.get(WarehouseSpu, spu_id)
    if spu is None:
        return None
    images = spu_image_archive.images_for_spu(db, spu, limit=1)
    return images[0]["url"] if images else None


def request_for_spu(db: Session, spu: WarehouseSpu, *, force: bool = False) -> SpuImageSearch | None:
    """给这个 SPU 发起搜图。已在搜/在审/已有参考图的不重复发;失败的过了冷却期才重发。
    没配爬虫或型号名太短返回 None。调用方自己 commit。"""
    if not enabled():
        return None
    query = spu_query(spu)
    if len(query) < 2:
        return None
    row = db.query(SpuImageSearch).filter(SpuImageSearch.spu_id == spu.id).first()
    if row and not force:
        if row.status in SpuImageSearch.OPEN or row.status == SpuImageSearch.READY:
            return row
        if row.updated_at and datetime.utcnow() - row.updated_at < RETRY_FAILED_AFTER:
            return row
    try:
        with _client() as c:
            # 不带 refresh 爬虫会把同名查询直接还成旧任务,重搜就成了空操作。
            # profile=listing 让爬虫对 limit<50 也开翻页/变体/扩展;min_results 防止薄缓存复用。
            resp = c.post(
                "/v1/images/search",
                json={
                    "query": query,
                    "limit": SEARCH_LIMIT,
                    "profile": "listing",
                    "min_results": SEARCH_MIN_RESULTS,
                    "recall_version": RECALL_VERSION,
                    "refresh": force,
                    "search_tier": "balanced",
                },
            )
            resp.raise_for_status()
            task_id = resp.json()["task_id"]
    except Exception as exc:  # noqa: BLE001 - 爬虫挂了不能拖累上架
        logger.warning("图片爬虫发起失败 spu=%s %s: %s", spu.spu_code, query, exc)
        return row
    if row is None:
        row = SpuImageSearch(spu_id=spu.id, query=query)
        db.add(row)
    row.query = query
    row.task_id = task_id
    row.status = SpuImageSearch.SEARCHING
    row.formal_count = 0
    row.reference_url = row.source_url = row.reviewer = row.error = None
    row.search_progress = None
    row.last_requested_at = datetime.utcnow()
    row.checked_at = None
    db.flush()
    logger.info("图片爬虫已发起 spu=%s %s task=%s", spu.spu_code, query, task_id)
    return row


def _pick(images: list[dict]) -> dict | None:
    """正式池里挑一张当参考:质量好的优先,再看无水印、型号置信度、综合分。"""
    if not images:
        return None
    from app.services.image_material import irrelevant_reason

    rank = {"good": 2, "ok": 1, "": 1, "bad": 0}

    def key(im: dict):
        clean = (im.get("watermark") or "none") in ("none", "unknown", "")
        # 像头像、表情包、截图的排最后
        grade = -1 if irrelevant_reason(im) else rank.get(im.get("quality_grade") or "", 1)
        return (grade, clean, float(im.get("product_confidence") or 0), float(im.get("score") or 0))

    return max(images, key=key)


def _sniff_image_type(content: bytes) -> str | None:
    if content.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if content.startswith(b"\x89PNG"):
        return "image/png"
    if content.startswith(b"GIF8"):
        return "image/gif"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return None


def _store(c: httpx.Client, spu: WarehouseSpu | None, image: dict, *, sub: str = "") -> str:
    """把爬虫上的图下载下来转存到图床,返回干净的公开地址。"""
    url = image["url"]
    if is_placeholder_oss():
        # 本机开发用假图床：不下载/转存，直接用爬虫返回的公开原图 URL。
        # 这样审核通过后档案能正常写入；生产 OSS 正常时行为不变。
        return url
    resp = c.get(url)
    resp.raise_for_status()
    content = resp.content
    if not content or len(content) > _MAX_IMAGE_BYTES:
        raise ValueError(f"参考图大小不对:{len(content)} 字节")
    ctype = (resp.headers.get("content-type") or "image/jpeg").split(";")[0].strip()
    if not ctype.startswith("image/"):
        # 爬虫容器不认 .webp,发的是 text/plain,看文件头认
        ctype = _sniff_image_type(content) or ctype
    if not ctype.startswith("image/"):
        raise ValueError(f"参考图不是图片:{ctype}")
    ext = os.path.splitext(url.split("?", 1)[0])[1] or ".jpg"
    folder = f"{REF_PREFIX}/{spu.spu_code if spu else 'unknown'}" + (f"/{sub}" if sub else "")
    return upload_object(folder, upload_filename(f"ref{ext}", content), content, ctype)["public_url"]


def usable_for_listing(pool: list[dict]) -> list[dict]:
    """只按规则看能自动拿去上架的爬虫图:质量评成 bad 的(水印、海报字、拼图、人像、长图)、像头像截图的不要。
    有数据库时用 image_material.usable_crawled,它还认员工标的淘汰 / 可用。"""
    from app.services.image_material import USABLE, rule_verdict

    return [p for p in pool if p.get("url") and rule_verdict(p).status == USABLE]


def pool_for_spu(db: Session, spu_id: str | None) -> list[dict]:
    """上架页给员工挑的爬虫图(已转存图床)。员工标了「需处理」、没搜到的不给。"""
    if not spu_id:
        return []
    row = db.query(SpuImageSearch).filter(SpuImageSearch.spu_id == spu_id).first()
    if not row or row.status not in (SpuImageSearch.REVIEWING, SpuImageSearch.READY):
        return []
    return list(row.pool_images or [])


def _sync_pool(c: httpx.Client, spu: WarehouseSpu | None, row: SpuImageSearch, images: list[dict]) -> None:
    """正式池按爬虫现在的样子转存进图床:员工在爬虫那边挪进挪出,下一轮跟着变;转存过的不重复下载。"""
    have = {p["crawler_url"]: p for p in (row.pool_images or []) if p.get("crawler_url")}
    pool: list[dict] = []
    for image in images[:POOL_MAX]:
        url = image.get("url")
        if not url:
            continue
        item = have.get(url)
        if item is None:
            try:
                item = {"url": _store(c, spu, image, sub="pool"), "crawler_url": url,
                        "source_url": (image.get("source_url") or "")[:1024] or None}
            except Exception as exc:  # noqa: BLE001 - 一张下不下来不挡其他
                logger.warning("爬虫图转存失败 %s: %s", url, exc)
                continue
        extra = {k: image.get(k) for k in META_FIELDS if image.get(k)}
        if image.get("quality_grade"):
            extra.update({k: image.get(k) for k in QUALITY_FIELDS if image.get(k) is not None})
        if extra:
            item = {**item, **extra}
        pool.append(item)
    if pool != (row.pool_images or []):
        row.pool_images = pool


def _advance(db: Session, c: httpx.Client, row: SpuImageSearch) -> None:
    row.checked_at = datetime.utcnow()
    resp = c.get(f"/v1/images/tasks/{row.task_id}")
    if resp.status_code == 404:
        row.status, row.error = SpuImageSearch.FAILED, "爬虫上找不到这个任务了(服务重装过?),到时会重发"
        return
    resp.raise_for_status()
    task = resp.json()
    status = task.get("status")
    images = task.get("images") or []
    row.formal_count = len(images)
    row.search_progress = task.get("progress") or None
    if status in ("queued", "processing"):
        row.status = SpuImageSearch.SEARCHING
        return
    if status in ("failed", "cancelled"):
        row.status, row.error = SpuImageSearch.FAILED, (task.get("error") or status)[:500]
        return
    # completed:等员工在爬虫审核页给结论
    review = task.get("review_status") or "pending"
    row.reviewer = (task.get("reviewer") or None) and str(task["reviewer"])[:64]
    spu = db.get(WarehouseSpu, row.spu_id)
    if review != "needs_changes":
        _sync_pool(c, spu, row, images)
    if review == "needs_changes":
        spu_image_archive.mark_task_rejected(db, row.task_id)
        row.archive_count = 0
        row.status = SpuImageSearch.REJECTED
        row.error = (task.get("review_note") or "员工标了需处理")[:500]
        return
    if review != "approved":
        row.status = SpuImageSearch.REVIEWING
        return
    image = _pick(images)
    if image is None:
        row.status, row.error = SpuImageSearch.REJECTED, "审核通过但正式池里没有图"
        return
    row.reference_url = _store(c, spu, image)
    row.source_url = (image.get("source_url") or "")[:1024] or None
    if spu is not None:
        # 审核通过:整池写进 SPU 共享档案,不再只留一张参考图。
        spu_image_archive.upsert_from_pool(
            db,
            spu,
            row,
            approved=True,
            approved_by=row.reviewer,
            cover_crawler_url=image.get("url"),
        )
    row.status, row.error = SpuImageSearch.READY, None
    logger.info(
        "图片爬虫参考图已转存 spu=%s %s,档案 %s 张",
        spu.spu_code if spu else row.spu_id,
        row.reference_url,
        row.archive_count,
    )


def refresh_pools(db: Session) -> int:
    """已结束跟进的(在审、已合格)也按爬虫现在的正式池重同步一遍:顺序和质量分跟着爬虫走。
    不改状态、不换参考图。爬虫补评老任务之后跑一次(scripts/refresh_crawler_pools.py)。"""
    if not enabled():
        return 0
    rows = (db.query(SpuImageSearch)
            .filter(SpuImageSearch.status.in_((SpuImageSearch.REVIEWING, SpuImageSearch.READY)),
                    SpuImageSearch.task_id.isnot(None)).all())
    changed = 0
    with _client() as c:
        for row in rows:
            try:
                resp = c.get(f"/v1/images/tasks/{row.task_id}")
                resp.raise_for_status()
                task = resp.json()
                review = task.get("review_status") or "pending"
                if task.get("status") != "completed" or review == "needs_changes":
                    continue
                before = list(row.pool_images or [])
                spu = db.get(WarehouseSpu, row.spu_id)
                _sync_pool(c, spu, row, task.get("images") or [])
                # 只有审核通过才写商品档案；待审核行只同步任务态图池。
                if review == "approved" and spu is not None and row.pool_images:
                    spu_image_archive.upsert_from_pool(
                        db, spu, row, approved=True, approved_by=row.reviewer
                    )
                if row.pool_images != before:
                    changed += 1
                db.commit()
            except Exception as exc:  # noqa: BLE001 - 一个出错不挡别的
                db.rollback()
                logger.warning("爬虫图池重同步失败 task=%s: %s", row.task_id, exc)
    return changed


def reconcile_archives(db: Session, limit: int = 50) -> int:
    """轻量对账:READY 但档案不足的,只读 pool_images 重建,不联网。"""
    rows = (
        db.query(SpuImageSearch)
        .filter(
            SpuImageSearch.status == SpuImageSearch.READY,
            SpuImageSearch.pool_images.isnot(None),
        )
        .order_by(SpuImageSearch.checked_at)
        .limit(limit)
        .all()
    )
    changed = 0
    for row in rows:
        if (row.archive_count or 0) >= (row.formal_count or 0):
            continue
        spu = db.get(WarehouseSpu, row.spu_id)
        if spu is None or not row.pool_images:
            continue
        spu_image_archive.upsert_from_pool(
            db, spu, row, approved=True, approved_by=row.reviewer
        )
        changed += 1
    if changed:
        db.commit()
    return changed


def advance_open(db: Session) -> int:
    """问一轮在搜/在等审核的任务,返回这一轮了结(变成 READY/REJECTED/FAILED)的行数。"""
    if not enabled():
        return 0
    rows = (db.query(SpuImageSearch).filter(SpuImageSearch.status.in_(SpuImageSearch.OPEN))
            .order_by(SpuImageSearch.checked_at.is_(None).desc(), SpuImageSearch.checked_at).limit(100).all())
    settled = 0
    with _client() as c:
        for row in rows:
            try:
                _advance(db, c, row)
            except Exception as exc:  # noqa: BLE001 - 一个任务出错别挡住其他的,下一轮再问
                row.checked_at = datetime.utcnow()
                logger.warning("图片爬虫任务跟进失败 task=%s: %s", row.task_id, exc)
            db.commit()
            if row.status not in SpuImageSearch.OPEN:
                settled += 1
    return settled


def _tick() -> int:
    from app.database import SessionLocal
    from app.services.auto_listing.worker import _batch_lock

    db = SessionLocal()
    try:
        with _batch_lock(db, LOCK_KEY) as got:
            if not got:
                return 0
            settled = advance_open(db)
            if datetime.utcnow().minute % 5 == 0:
                try:
                    reconcile_archives(db)
                except Exception as exc:  # noqa: BLE001 - 对账失败不挡主轮询
                    db.rollback()
                    logger.warning("图片档案对账失败: %s", exc)
            return settled
    finally:
        db.close()


async def run_loop() -> None:
    """常驻协程,ERP 启动时拉起。没配爬虫就每轮空转。"""
    logger.info("图片爬虫对接已启动:%s", "每 %ss 跟进一轮" % POLL_SECONDS if enabled() else "未配置,空转")
    while True:
        try:
            n = await asyncio.to_thread(_tick)
            if n:
                logger.info("图片爬虫:了结 %d 个任务", n)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("图片爬虫跟进一轮异常,下一轮继续: %s", exc)
        await asyncio.sleep(POLL_SECONDS)
