"""OA 推送后台 worker（镜像 services/redraw_worker 的约束）。

- 受控线程池，避免线程暴增；DB 会话只在状态切换时短开短关，绝不跨网络请求持有。
- 乐观「认领」：条件 UPDATE status=RUNNING WHERE status IN(PENDING,RETRY)，rowcount==1 才处理，
  避免实时 worker 与定时扫描器重复投递同一行。
- 失败链路统一落库，对外不抛异常。
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import update

from app.config import settings
from app.database import SessionLocal
from app.models import OaPushOutbox
from app.services.oa_push import client
from app.services.oa_push.client import OaMappingMissingError, OaPushError

logger = logging.getLogger(__name__)

MAX_WORKERS = 4
RETRY_BASE_SECONDS = 30
RETRY_CAP_SECONDS = 3600
STALE_RUNNING_MINUTES = 15  # RUNNING 超过此时长视为卡死，reclaim 回 RETRY

_executor: Optional[ThreadPoolExecutor] = None


def get_executor() -> ThreadPoolExecutor:
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="oa-push")
    return _executor


def shutdown_executor():
    global _executor
    if _executor is not None:
        _executor.shutdown(wait=False, cancel_futures=True)
        _executor = None


@contextmanager
def _short_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _claim(outbox_id: str) -> Optional[tuple[str, dict]]:
    """乐观认领：置 RUNNING 成功则返回 (tool, arguments)，否则 None（已被处理/认领）。"""
    with _short_session() as db:
        res = db.execute(
            update(OaPushOutbox)
            .where(OaPushOutbox.id == outbox_id, OaPushOutbox.status.in_(("PENDING", "RETRY")))
            .values(status="RUNNING", updated_at=datetime.utcnow())
        )
        db.commit()
        if res.rowcount != 1:
            return None
        row = db.get(OaPushOutbox, outbox_id)
        if not row:
            return None
        return row.tool, dict(row.arguments or {})


def _mark_succeeded(outbox_id: str, remote_id: Optional[str]):
    with _short_session() as db:
        row = db.get(OaPushOutbox, outbox_id)
        if not row:
            return
        row.status = "SUCCEEDED"
        row.remote_id = (remote_id or None)
        row.last_error = None
        row.sent_at = datetime.utcnow()
        db.commit()


def _mark_blocked(outbox_id: str, reason: str):
    with _short_session() as db:
        row = db.get(OaPushOutbox, outbox_id)
        if not row:
            return
        row.status = "BLOCKED_NO_MAPPING"
        row.last_error = reason[:1000]
        db.commit()


def _mark_retry_or_failed(outbox_id: str, reason: str, *, retriable: bool):
    with _short_session() as db:
        row = db.get(OaPushOutbox, outbox_id)
        if not row:
            return
        row.attempts = (row.attempts or 0) + 1
        row.last_error = reason[:1000]
        if (not retriable) or row.attempts >= settings.oa_push_max_attempts:
            row.status = "FAILED"
        else:
            row.status = "RETRY"
            delay = min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * (2 ** (row.attempts - 1)))
            row.next_due_at = datetime.utcnow() + timedelta(seconds=delay)
        db.commit()


def _run(outbox_id: str):
    """核心处理：认领→调用 OA→落库。实时线程池与定时脚本共用。"""
    try:
        claimed = _claim(outbox_id)
        if not claimed:
            return
        tool, arguments = claimed
        try:
            remote_id = client.call_tool(tool, arguments)
        except OaMappingMissingError as exc:
            _mark_blocked(outbox_id, exc.message)
            return
        except OaPushError as exc:
            _mark_retry_or_failed(outbox_id, exc.message, retriable=exc.retriable)
            return
        _mark_succeeded(outbox_id, remote_id)
    except Exception as exc:  # noqa: BLE001 兜底：绝不把异常抛回业务/线程池
        logger.exception("oa_push worker 异常 outbox=%s", outbox_id)
        _mark_retry_or_failed(outbox_id, f"worker 异常: {exc}", retriable=True)


def enqueue(outbox_id: str):
    """实时投递：提交到线程池（满则排队）。总开关关闭时不投。"""
    if not settings.oa_push_enabled:
        return
    get_executor().submit(_run, outbox_id)


def reclaim_stale():
    """启动时调用：把卡在 RUNNING 太久的行复位为 RETRY（立即可再投）。"""
    threshold = datetime.utcnow() - timedelta(minutes=STALE_RUNNING_MINUTES)
    try:
        with _short_session() as db:
            res = db.execute(
                update(OaPushOutbox)
                .where(OaPushOutbox.status == "RUNNING", OaPushOutbox.updated_at < threshold)
                .values(status="RETRY", next_due_at=datetime.utcnow())
            )
            db.commit()
            if res.rowcount:
                logger.info("reclaimed %d stale oa_push rows", res.rowcount)
    except Exception:
        logger.exception("oa_push reclaim_stale 失败")


def run_due_batch(db, limit: int = 200) -> int:
    """定时扫描器用（scripts/run_oa_push.py）：处理到期的 PENDING/RETRY，同步逐条执行。

    返回处理条数。调用方负责跨进程互斥（GET_LOCK）。这里同步执行 _run（内部自带认领）。
    """
    now = datetime.utcnow()
    rows = (
        db.query(OaPushOutbox.id)
        .filter(
            OaPushOutbox.status.in_(("PENDING", "RETRY")),
            OaPushOutbox.next_due_at <= now,
            OaPushOutbox.attempts < settings.oa_push_max_attempts,
        )
        .order_by(OaPushOutbox.next_due_at.asc())
        .limit(limit)
        .all()
    )
    ids = [r[0] for r in rows]
    for oid in ids:
        _run(oid)
    return len(ids)
