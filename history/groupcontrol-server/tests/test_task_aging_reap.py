"""aging 定时清理超时未执行任务(_reap_stale_queued_tasks):

- PENDING 超过 task_pending_max_age_sec(默认 12 小时)→ CANCELLED
- DISPATCHED 超过 task_dispatched_max_age_sec(默认 1 小时)→ CANCELLED
- DISPATCHED 且 dispatched_at 为 NULL 时按 created_at 算龄
- 新鲜的 PENDING/DISPATCHED 与 RUNNING(归 watchdog 管)不受影响

走 _aging_pass 全量入口;SessionLocal monkeypatch 到同一内存库(同 test_dispatch_binds_device)。
"""
from datetime import datetime, timedelta

from sqlalchemy.orm import sessionmaker

import app.scheduler as scheduler_module
from app.models import Task, TaskStatus
from app.scheduler import Scheduler

NOW = datetime.utcnow()


def _mk(db, status, *, created_at, dispatched_at=None):
    t = Task(task_type="goods_publish", status=status, spec={},
             created_at=created_at, dispatched_at=dispatched_at)
    db.add(t)
    return t


def _run_aging(db, monkeypatch):
    monkeypatch.setattr(scheduler_module, "SessionLocal",
                        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False))
    Scheduler(bridge=None)._aging_pass()


def test_stale_pending_cancelled(db_session, monkeypatch):
    old = _mk(db_session, TaskStatus.PENDING, created_at=NOW - timedelta(hours=13))
    fresh = _mk(db_session, TaskStatus.PENDING, created_at=NOW - timedelta(hours=1))
    db_session.commit()

    _run_aging(db_session, monkeypatch)

    db_session.refresh(old)
    db_session.refresh(fresh)
    assert old.status == TaskStatus.CANCELLED
    assert old.error == "超时未执行,定时清理"
    assert old.finished_at is not None
    assert fresh.status == TaskStatus.PENDING


def test_stale_dispatched_cancelled(db_session, monkeypatch):
    old = _mk(db_session, TaskStatus.DISPATCHED, created_at=NOW - timedelta(days=20),
              dispatched_at=NOW - timedelta(hours=2))
    fresh = _mk(db_session, TaskStatus.DISPATCHED, created_at=NOW,
                dispatched_at=NOW - timedelta(minutes=30))
    db_session.commit()

    _run_aging(db_session, monkeypatch)

    db_session.refresh(old)
    db_session.refresh(fresh)
    assert old.status == TaskStatus.CANCELLED
    assert fresh.status == TaskStatus.DISPATCHED


def test_dispatched_null_dispatched_at_falls_back_to_created_at(db_session, monkeypatch):
    t = _mk(db_session, TaskStatus.DISPATCHED, created_at=NOW - timedelta(days=5),
            dispatched_at=None)
    db_session.commit()

    _run_aging(db_session, monkeypatch)

    db_session.refresh(t)
    assert t.status == TaskStatus.CANCELLED


def test_running_not_touched_by_aging(db_session, monkeypatch):
    # RUNNING 超时是 watchdog 的职责(task_timeout_sec),aging 不动
    t = _mk(db_session, TaskStatus.RUNNING, created_at=NOW - timedelta(days=10))
    db_session.commit()

    _run_aging(db_session, monkeypatch)

    db_session.refresh(t)
    assert t.status == TaskStatus.RUNNING
