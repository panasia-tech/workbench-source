"""AI 重绘后台 worker。

约束:
- 受控线程池，避免线程暴增。
- DB 会话只在状态切换时短期开启、立即关闭；不跨 HTTP 等待持有连接。
- 失败链路统一落库，对外不抛异常。
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Optional

from app.config import settings
from app.database import SessionLocal
from app.models import AiRedrawJob
from app.services import alapi, apinebula

logger = logging.getLogger(__name__)

# gpt-image-2 单任务 ~30-90 秒；4 个并发足以应付日常入库场景。
# 即使被刷接口，新任务会排队等待，不会再起线程占用 DB 连接。
MAX_WORKERS = 4
POLL_INTERVAL = 5
POLL_MAX_SECONDS = 300
STALE_AFTER_MINUTES = 10

_executor: Optional[ThreadPoolExecutor] = None


def get_executor() -> ThreadPoolExecutor:
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(
            max_workers=MAX_WORKERS,
            thread_name_prefix="ai-redraw",
        )
    return _executor


def shutdown_executor():
    global _executor
    if _executor is not None:
        _executor.shutdown(wait=False, cancel_futures=True)
        _executor = None


@contextmanager
def _short_session():
    """短期 DB 会话：仅供状态切换。绝不跨 HTTP 等待持有。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _mark_failed(job_id: str, reason: str):
    try:
        with _short_session() as db:
            job = db.get(AiRedrawJob, job_id)
            if not job:
                return
            if job.status in ("SUCCEEDED", "FAILED"):
                return
            job.status = "FAILED"
            job.error_message = reason[:500]
            job.completed_at = datetime.utcnow()
            db.commit()
    except Exception:
        logger.exception("mark_failed %s 失败", job_id)


def _load_job_context(job_id: str) -> Optional[dict]:
    with _short_session() as db:
        job = db.get(AiRedrawJob, job_id)
        if not job:
            return None
        return {
            "id": job.id,
            "prompt": job.prompt,
            "source_image_url": job.source_image_url,
            "ai_size": job.ai_size,
            "ai_resolution": job.ai_resolution,
            "status": job.status,
        }


def _set_task_id(job_id: str, task_id: str):
    with _short_session() as db:
        job = db.get(AiRedrawJob, job_id)
        if not job:
            return
        job.alapi_task_id = task_id
        job.status = "RUNNING"
        db.commit()


def _set_running(job_id: str):
    """同步供应商（apinebula）无 task_id，仅置 RUNNING。"""
    with _short_session() as db:
        job = db.get(AiRedrawJob, job_id)
        if not job:
            return
        job.status = "RUNNING"
        db.commit()


def _bump_poll(job_id: str):
    with _short_session() as db:
        job = db.get(AiRedrawJob, job_id)
        if not job:
            return
        job.poll_count = (job.poll_count or 0) + 1
        db.commit()


def _mark_succeeded(job_id: str, public_url: str, object_key: str):
    with _short_session() as db:
        job = db.get(AiRedrawJob, job_id)
        if not job:
            return
        job.status = "SUCCEEDED"
        job.result_url = public_url
        job.result_object_key = object_key
        job.completed_at = datetime.utcnow()
        db.commit()


def _run(job_id: str):
    """worker 入口：全程不持有 DB 连接超过几十毫秒。按配置分发到具体供应商。"""
    try:
        ctx = _load_job_context(job_id)
        if not ctx:
            return
        # 异常重启场景：worker 启动后再读，避免重复处理已被推进的 job
        if ctx["status"] not in ("PENDING", "RUNNING"):
            return

        provider = (settings.redraw_provider or "alapi").strip().lower()
        if provider == "apinebula":
            _run_apinebula(job_id, ctx)
        else:
            _run_alapi(job_id, ctx)
    except Exception:
        logger.exception("worker 异常 job=%s", job_id)
        _mark_failed(job_id, "服务端异常")


def _run_alapi(job_id: str, ctx: dict):
    """ALAPI 异步流水线：提交 → 轮询 → 下载回传 OSS。"""
    # 1) 提交到 ALAPI（HTTP, 可能 30s）
    try:
        task_id = alapi.submit_redraw(
            prompt=ctx["prompt"],
            image_url=ctx["source_image_url"],
            size=ctx["ai_size"],
            resolution=ctx["ai_resolution"],
        )
    except Exception as exc:
        _mark_failed(job_id, f"提交失败: {exc}")
        return

    _set_task_id(job_id, task_id)

    # 2) 轮询（每 5s 一次 HTTP, 最多 5 分钟）
    deadline = time.monotonic() + POLL_MAX_SECONDS
    result_data = None
    while True:
        try:
            data = alapi.query_task(task_id)
        except alapi.AlapiError as exc:
            # 临时网络错误：继续重试，不直接判失败
            logger.warning("query_task transient: %s", exc)
            data = {}

        status = (data.get("status") or "").lower()
        _bump_poll(job_id)

        if status in alapi.TERMINAL_STATUSES:
            result_data = data
            break
        if time.monotonic() >= deadline:
            _mark_failed(job_id, f"任务超时（>{POLL_MAX_SECONDS}s）")
            return
        time.sleep(POLL_INTERVAL)

    status = (result_data.get("status") or "").lower()
    if status != "completed":
        err = (result_data.get("result") or {}).get("error") or result_data.get("error") or f"状态: {status}"
        _mark_failed(job_id, str(err))
        return

    remote_url = alapi._extract_result_url(result_data)  # noqa: SLF001
    if not remote_url:
        _mark_failed(job_id, "ALAPI 未返回图片 URL")
        return

    # 3) 下载 + 重传 OSS
    try:
        uploaded = alapi.fetch_and_upload(remote_url)
    except alapi.AlapiError as exc:
        _mark_failed(job_id, f"OSS 回传失败: {exc}")
        return

    _mark_succeeded(job_id, uploaded["public_url"], uploaded["object_key"])


def _run_apinebula(job_id: str, ctx: dict):
    """apinebula 同步流水线：一次调用出图（有参考图→图生图，无→文生图）+ 回传 OSS。"""
    _set_running(job_id)
    try:
        uploaded = apinebula.generate_and_upload(
            prompt=ctx["prompt"],
            image_url=(ctx["source_image_url"] or None),
            size=ctx["ai_size"],
        )
    except Exception as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        _mark_failed(job_id, f"apinebula 失败: {detail}")
        return
    _mark_succeeded(job_id, uploaded["public_url"], uploaded["object_key"])


def enqueue(job_id: str):
    """对外入口：把 job 投递到线程池。线程池满时自动排队。"""
    get_executor().submit(_run, job_id)


def reclaim_stale_jobs():
    """启动时调用：把进程崩溃留下的悬挂任务标失败。"""
    threshold = datetime.utcnow() - timedelta(minutes=STALE_AFTER_MINUTES)
    try:
        with _short_session() as db:
            stale = (
                db.query(AiRedrawJob)
                .filter(
                    AiRedrawJob.status.in_(("PENDING", "RUNNING")),
                    AiRedrawJob.created_at < threshold,
                )
                .all()
            )
            for job in stale:
                job.status = "FAILED"
                job.error_message = "服务重启或异常中断"
                job.completed_at = datetime.utcnow()
            if stale:
                db.commit()
                logger.info("reclaimed %d stale redraw jobs", len(stale))
    except Exception:
        logger.exception("reclaim_stale_jobs 失败")
