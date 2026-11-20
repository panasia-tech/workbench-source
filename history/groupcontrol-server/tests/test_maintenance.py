"""执行端维护报备(2026-10-14):更新执行端前报备、更新完收尾重排。

起因:行情台「更新执行端」直接重启进程,正赶上发布的两单在发布后校验那步被掐断,
记成 FAILED;其中一单其实已经挂上去了。这里钉死:
  1. 报备期间调度器不派新活;过期自动失效;
  2. 报备返回在跑的任务(行情台据此等它跑完再重启);
  3. 收尾只重排窗口内因重启失败的任务,原地放回 PENDING(作业计数不多出一单);
  4. 已点过「发布」的、风控/掉登录的、后台巡检/保活的,一概不重排。
"""
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

import app.api as api
from app.models import (
    Account, AccountStatus, Device, DeviceStatus, Job, JobStatus, RiskState, Task, TaskStatus,
)
from app.schemas import MaintenanceIn
from app.scheduler import Scheduler


def _seed(db):
    db.add(Device(id="dev-m", name="浏览器号", token="t", hw_id="k1m", kind="browser",
                  status=DeviceStatus.ONLINE))
    db.add(Account(id="acc-m", nick="号M", device_id="dev-m", status=AccountStatus.ACTIVE,
                   risk_state=RiskState.NORMAL, active_window="00:00-23:59"))
    # total 对上下面 test_end_requeues_only_restart_failures 塞进这个作业的 6 个任务
    db.add(Job(id="job-m", job_type="publish_batch", status=JobStatus.FAILED, total=6,
               succeeded=0, failed=6, finished_at=datetime.utcnow()))
    db.commit()


def _failed(db, tid, *, task_type="goods_publish", result=None, finished=None):
    db.add(Task(id=tid, job_id="job-m", device_id="dev-m", account_id="acc-m",
                task_type=task_type, status=TaskStatus.FAILED, error="原语 swipe 超时(15.0s)",
                failed_step="publish", result=result or {"ok": False},
                started_at=datetime.utcnow(), finished_at=finished or datetime.utcnow()))


def _scheduler():
    return Scheduler.__new__(Scheduler)   # 只用 _eligibility,不起循环


def test_maintenance_blocks_dispatch_and_expires(db_session):
    _seed(db_session)
    task = Task(id="t-new", device_id="dev-m", account_id="acc-m", task_type="goods_publish",
                status=TaskStatus.PENDING)
    db_session.add(task)
    db_session.commit()
    sched = _scheduler()
    assert sched._eligibility(db_session, task, set())[2] is None

    api.begin_maintenance("dev-m", MaintenanceIn(), db_session)
    assert sched._eligibility(db_session, task, set())[2] == "执行端在更新(已报备)"

    # 行情台半路没了、没收尾:过期后照常派,不把号永久挂起
    dev = db_session.get(Device, "dev-m")
    dev.maintenance_until = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()
    assert sched._eligibility(db_session, task, set())[2] is None


def test_begin_returns_running_tasks(db_session):
    _seed(db_session)
    db_session.add(Task(id="t-run", device_id="dev-m", account_id="acc-m", task_type="goods_publish",
                        status=TaskStatus.RUNNING, started_at=datetime.utcnow()))
    db_session.commit()
    res = api.begin_maintenance("dev-m", MaintenanceIn(minutes=5), db_session)
    assert [r["id"] for r in res["running"]] == ["t-run"]


def test_end_requeues_only_restart_failures(db_session):
    _seed(db_session)
    before = datetime.utcnow() - timedelta(minutes=5)
    _failed(db_session, "t-old", finished=before)            # 报备之前就失败的:不归这次管
    db_session.commit()
    api.begin_maintenance("dev-m", MaintenanceIn(), db_session)
    _failed(db_session, "t-cut")                              # 重启掐断的:重排
    _failed(db_session, "t-pub", result={"ok": False, "published": True, "item_id": "1"})
    _failed(db_session, "t-risk", result={"ok": False, "risk": "验证码"})
    _failed(db_session, "t-login", result={"ok": False, "login": True})
    _failed(db_session, "t-scan", task_type="chat_scan")
    db_session.commit()

    res = api.end_maintenance("dev-m", db_session)
    assert res["requeued"] == ["t-cut"]
    cut = db_session.get(Task, "t-cut")
    assert cut.status == TaskStatus.PENDING and cut.retry == 1
    assert cut.error is None and cut.finished_at is None and cut.started_at is None
    assert "执行端更新中断" in cut.mark
    for tid in ("t-old", "t-pub", "t-risk", "t-login", "t-scan"):
        assert db_session.get(Task, tid).status == TaskStatus.FAILED, tid

    dev = db_session.get(Device, "dev-m")
    assert dev.maintenance_until is None and dev.maintenance_since is None
    # 作业从收尾态退回进行中,计数不多出一单
    job = db_session.get(Job, "job-m")
    assert job.status == JobStatus.RUNNING and job.finished_at is None


def test_end_without_begin_is_noop(db_session):
    _seed(db_session)
    _failed(db_session, "t-x")
    db_session.commit()
    assert api.end_maintenance("dev-m", db_session)["requeued"] == []
    assert db_session.get(Task, "t-x").status == TaskStatus.FAILED


def test_404(db_session):
    with pytest.raises(HTTPException) as e:
        api.begin_maintenance("nope", MaintenanceIn(), db_session)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        api.end_maintenance("nope", db_session)
    assert e.value.status_code == 404
