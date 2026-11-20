"""OA 推送发件箱「生产者」：在业务事务内登记待推送行，业务 commit 后自动投递 worker。

关键保证（推送绝不阻塞/破坏业务）：
- 登记与业务写入**同一事务**（随业务一起 commit / 一起回滚），保证不会「业务回滚了却把消息推出去」。
- dedup_key 冲突用 **SAVEPOINT(begin_nested) 隔离**：唯一约束异常只回滚保存点，业务事务不受影响。
- 任何异常都只记日志、返回 None，绝不上抛。
- 投递解耦：登记时把 outbox id 暂存到 session.info，业务 commit 成功后由 after_commit 监听器投递到
  worker（回滚则丢弃）。这样 6 个出库入口等调用方**无需改动 commit 流程**。
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models import OaPushOutbox
from app.models.staff import new_uuid

logger = logging.getLogger(__name__)

_PENDING_KEY = "oa_push_pending_ids"

# after_commit 是否自动投递到线程池 worker。存量补推脚本会关掉它（只入库、交由定时扫描器推）。
_autosubmit = True


def set_autosubmit(enabled: bool) -> None:
    global _autosubmit
    _autosubmit = enabled


def enqueue_push(
    db: Session,
    tool: str,
    arguments: dict[str, Any],
    *,
    dedup_key: Optional[str] = None,
    source_type: Optional[str] = None,
    source_id: Optional[str] = None,
) -> Optional[str]:
    """在当前(业务)事务内登记一条待推送。返回 outbox id；被去重/未启用/异常则 None。

    注意：本函数不 commit —— 由调用方随业务一起 commit。
    """
    if not settings.oa_push_enabled:
        return None
    try:
        if dedup_key:
            exists = (
                db.query(OaPushOutbox.id)
                .filter(OaPushOutbox.dedup_key == dedup_key)
                .first()
            )
            if exists:
                return None

        row = OaPushOutbox(
            id=new_uuid(),
            tool=tool,
            arguments=arguments,
            dedup_key=dedup_key,
            status="PENDING",
            attempts=0,
            next_due_at=datetime.utcnow(),
            source_type=source_type,
            source_id=source_id,
        )
        try:
            with db.begin_nested():  # SAVEPOINT：唯一约束冲突只回滚到此，业务事务不受损
                db.add(row)
                db.flush()
        except IntegrityError:
            # dedup_key 并发冲突：已被登记过，跳过
            return None

        db.info.setdefault(_PENDING_KEY, []).append(row.id)
        return row.id
    except Exception:  # noqa: BLE001 生产者绝不把异常抛回业务
        logger.exception("oa_push enqueue 失败 tool=%s dedup=%s", tool, dedup_key)
        return None


@event.listens_for(Session, "after_commit")
def _submit_after_commit(session: Session):
    ids = session.info.pop(_PENDING_KEY, None)
    if not ids or not _autosubmit:
        return
    # 延迟导入避免循环依赖
    from app.services.oa_push import worker

    for oid in ids:
        try:
            worker.enqueue(oid)
        except Exception:  # noqa: BLE001
            logger.exception("oa_push 投递 worker 失败 outbox=%s（定时扫描器会兜底）", oid)


@event.listens_for(Session, "after_rollback")
def _clear_after_rollback(session: Session):
    session.info.pop(_PENDING_KEY, None)
