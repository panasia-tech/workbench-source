"""没实拍图时，按解析出的 SPU 文生图补一张上架图。

二期只认验货实拍图，没图就退避重试到转人工。但仓库确实有一批货没拍照，
老板 2026-09-08 定：**没图的走「SPU + 生图」**——拿解析出的「品牌 型号」
当提示词文生图，出一张能挂的图。

复用现成的 AI 重绘流水线（ai_redraw_job + redraw_worker），不另起一套：
建一行 PENDING 的 job 丢进它的线程池，出图后由它回传 OSS，这边只认 result_url。
所以生图的供应商、尺寸、OSS 目录全都跟人工重绘走同一套配置。

只有 apinebula 支持文生图（alapi 的异步任务必须给参考图），供应商不对就明说，
不静默换路子。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.models import AiRedrawJob, Sku, SkuAutoListing
from app.services import redraw_worker
from app.services.oss_media import strip_oss_signature

logger = logging.getLogger(__name__)

# 出图一般一两分钟；超过这个还没结果就当它废了，重提一次
JOB_TIMEOUT = timedelta(minutes=30)
# 等出图的轮询间隔（等机器干活，不算失败，不计重试次数）
POLL_INTERVAL = timedelta(minutes=1)

NO_REAL_PHOTO = "没有可用的商品实拍图"


def _text_to_image_supported() -> bool:
    """只有 apinebula 能只给提示词出图；alapi 的异步任务必须带参考图。"""
    return (settings.redraw_provider or "").strip().lower() == "apinebula"


def build_prompt(sku: Sku, spu_query: str | None) -> str:
    """提示词 = 模板 + 解析出的「品牌 型号」。

    优先用 spu_query（RESOLVING 阶段对着仓库 SPU 对照表解析出来的规范名），
    它比 SKU 上人工填的品牌/型号干净；再退回品牌+型号，最后退回商品名。
    """
    subject = (spu_query or "").strip()
    if not subject:
        subject = " ".join(x for x in (sku.brand, sku.model) if x and x.strip()).strip()
    if not subject:
        subject = (sku.product_name or "").strip()
    if not subject:
        return ""
    # 用 replace 不用 format：模板是 .env 里人手填的，出现别的花括号不该炸
    return settings.auto_listing_image_prompt.replace("{spu}", subject)


def ensure_images(db: Session, row: SkuAutoListing, sku: Sku) -> tuple[list[str], str | None]:
    """返回 (上架图, 出错原因)。

    - 有图 → (["https://..."], None)
    - 机器还在生图 → ([], None)：等下一轮，**不算失败**，别计进重试次数
    - 生不出来 → ([], 原因)：交给调用方决定退避还是转人工
    """
    if not settings.auto_listing_generate_images:
        return [], NO_REAL_PHOTO

    if row.image_task_id:
        return _check_job(db, row)

    if not _text_to_image_supported():
        return [], f"{NO_REAL_PHOTO}，且当前重绘供应商不支持文生图（需 REDRAW_PROVIDER=apinebula）"
    prompt = build_prompt(sku, row.spu_query)
    if not prompt:
        return [], f"{NO_REAL_PHOTO}，也拼不出生图提示词（品牌/型号/商品名都是空的）"
    return _submit(db, row, sku, prompt)


def _check_job(db: Session, row: SkuAutoListing) -> tuple[list[str], str | None]:
    job = db.get(AiRedrawJob, row.image_task_id)
    if job is None:
        row.image_task_id = None
        return [], "生图任务不见了，下轮重提"

    if job.status == "SUCCEEDED" and job.result_url:
        row.image_count = 1
        # 存干净原始 URL，不存短效签名（与 listing.save_listing 同一口径）
        return [strip_oss_signature(job.result_url)], None

    if job.status == "FAILED":
        row.image_task_id = None
        return [], f"生图失败：{job.error_message or '未知原因'}"

    # PENDING / RUNNING：等着。但别无限等——供应商卡死时 job 会一直挂在 RUNNING
    created = job.created_at or datetime.utcnow()
    if datetime.utcnow() - created > JOB_TIMEOUT:
        row.image_task_id = None
        return [], "生图超时（任务一直没出结果）"
    return [], None


def _submit(db: Session, row: SkuAutoListing, sku: Sku, prompt: str) -> tuple[list[str], str | None]:
    """建一行重绘 job 并投递。source_image_url 留空 = 文生图。"""
    job = AiRedrawJob(sku_code=sku.sku_code, source_image_url="", prompt=prompt, status="PENDING")
    db.add(job)
    # 必须先落库再投递：redraw_worker 在另一个线程里按 id 查库，
    # 没提交它就查不到，job 会被静默丢掉，这边则永远等一张不会来的图。
    db.commit()
    row.image_task_id = job.id
    redraw_worker.enqueue(job.id)
    logger.info("自动上架生图: sku=%s job=%s", sku.sku_code, job.id)
    return [], None
