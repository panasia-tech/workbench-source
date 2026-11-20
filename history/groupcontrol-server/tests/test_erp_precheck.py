"""发布前回 ERP 再核一次(E05-10,app/erp_precheck.py)。

钉住:
- 只问 ERP 来的发布、ERP 开的焕新(删和重发两段);手动的、焕新撤回、别的任务类型不问;开关关了不问;
- ERP 明确说不能发 → 任务 CANCELLED、原因进 error、failed_step=erp_precheck、设备释放、作业聚合,
  流程一步都不跑;焕新重发被拦 → 账本停在 PENDING_REPUBLISH(和重发没成一样);
- ERP 连不上/超时/回的看不懂 → 照常发。
"""
import urllib.error
from uuid import uuid4

import pytest
from sqlalchemy.orm import sessionmaker

from app import erp_precheck, jobs, notify
from app.config import settings
from app.flow import runner
from app.models import (
    REFRESH_TASK_SOURCE,
    REFRESH_UNDO_SOURCE,
    Account,
    Device,
    DeviceStatus,
    Job,
    JobStatus,
    JobType,
    Listing,
    ListingStatus,
    Task,
    TaskStatus,
)

SPEC = {"images": ["https://oss.example.com/sku/product/a.jpg?Expires=1"], "price": 520,
        "description": "【AOC 27寸显示器】成色如图", "shipping": {"mode": "free"},
        "confirm_publish": True}


@pytest.fixture
def bound(db_session, monkeypatch):
    """runner / erp_precheck / jobs 各自开 SessionLocal:都指到同一内存库。"""
    Session = sessionmaker(bind=db_session.get_bind(), autoflush=False, autocommit=False)
    for mod in (runner, erp_precheck, jobs):
        monkeypatch.setattr(mod, "SessionLocal", Session)
    monkeypatch.setattr(settings, "gc_trace_actions", False)
    monkeypatch.setattr(settings, "erp_publish_precheck_enabled", True)
    return db_session


@pytest.fixture
def flow_calls(monkeypatch):
    calls = []

    def fake_flow(transport, spec, shot_sink=None):
        calls.append(spec)
        return {"ok": True, "done": ["publish"], "failed_step": None, "reason": None, "shot": None,
                "risk": None, "result": {"title": "【AOC 27寸显示器】成色如图"}}

    monkeypatch.setattr(runner, "_pick_flow", lambda task_type, kind: fake_flow)
    return calls


def _erp_says(monkeypatch, answer):
    asked = []

    def post(payload):
        asked.append(payload)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(erp_precheck, "_post", post)
    return asked


def _running(db, *, source="ERP", task_type="goods_publish", job_type=JobType.PUBLISH_BATCH,
             job_source="ERP", spec=None, sku="SK1"):
    dev = Device(name=f"d-{uuid4().hex[:6]}", kind="browser", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.flush()
    acc = Account(nick=f"a-{uuid4().hex[:8]}", device_id=dev.id)
    db.add(acc)
    db.flush()
    job = Job(job_type=job_type, source=job_source, ref_type="sku", ref_id=sku, spec=spec or SPEC, total=1)
    db.add(job)
    db.flush()
    task = Task(job_id=job.id, account_id=acc.id, device_id=dev.id, task_type=task_type, source=source,
                status=TaskStatus.RUNNING, spec=spec or SPEC, ref_type="sku", ref_id=sku)
    db.add(task)
    db.flush()
    dev.busy_task_id = task.id
    db.commit()
    return task, job, dev, acc


# ---------------------------------------------------------------- 问不问
def test_only_erp_publish_and_erp_refresh_are_checked(bound):
    db = bound
    task, job, _, acc = _running(db)
    assert erp_precheck.request_for(db, task) == {
        "sku_code": "SK1", "account_id": acc.id, "job_id": job.id, "refresh": False}

    manual = Task(task_type="goods_publish", source="MANUAL", account_id=acc.id, ref_id="SK1")
    delist = Task(task_type="goods_delist", source="ERP", account_id=acc.id, ref_id="SK1")
    no_account = Task(task_type="goods_publish", source="ERP", ref_id="SK1")
    for t in (manual, delist, no_account):
        assert erp_precheck.request_for(db, t) is None


@pytest.mark.parametrize("task_type", ["goods_delete", "goods_publish"])
def test_erp_refresh_is_checked_with_refresh_flag(bound, task_type):
    db = bound
    task, job, _, _ = _running(db, source=REFRESH_TASK_SOURCE, task_type=task_type,
                               job_type=JobType.REFRESH_LISTING)
    assert erp_precheck.request_for(db, task)["refresh"] is True


def test_refresh_undo_and_manual_refresh_are_not_checked(bound):
    db = bound
    undo, _, _, _ = _running(db, source=REFRESH_UNDO_SOURCE, task_type="goods_delete",
                             job_type=JobType.REFRESH_LISTING)
    assert erp_precheck.request_for(db, undo) is None
    manual, _, _, _ = _running(db, source=REFRESH_TASK_SOURCE, job_type=JobType.REFRESH_LISTING,
                               job_source="MANUAL")
    assert erp_precheck.request_for(db, manual) is None


def test_switch_off_does_not_ask(bound, monkeypatch):
    db = bound
    task, _, _, _ = _running(db)
    monkeypatch.setattr(settings, "erp_publish_precheck_enabled", False)
    assert erp_precheck.request_for(db, task) is None


# ---------------------------------------------------------------- 问到了说不能发
def test_blocked_publish_is_cancelled_before_the_flow_runs(bound, monkeypatch, flow_calls):
    db = bound
    task, job, dev, acc = _running(db)
    asked = _erp_says(monkeypatch, {"allow": False, "reason": "货不在库（已预留）"})
    runner.run_task(task.id, bridge=None, loop=None)
    db.expire_all()

    assert flow_calls == []
    assert asked == [{"sku_code": "SK1", "account_id": acc.id, "job_id": job.id, "refresh": False}]
    t = db.get(Task, task.id)
    assert t.status == TaskStatus.CANCELLED
    assert t.error == "发布前回 ERP 再核不通过:货不在库（已预留）"
    assert t.failed_step == "erp_precheck" and t.finished_at
    assert db.get(Device, dev.id).busy_task_id is None
    j = db.get(Job, job.id)
    assert j.status == JobStatus.FAILED and j.failed == 1
    assert db.query(Listing).count() == 0


def test_blocked_refresh_republish_waits_like_a_failed_republish(bound, monkeypatch, flow_calls):
    db = bound
    monkeypatch.setattr(notify, "_send", lambda *a, **k: True)
    task, job, _, acc = _running(db, source=REFRESH_TASK_SOURCE, job_type=JobType.REFRESH_LISTING)
    lst = Listing(sku="SK1", account_id=acc.id, item_id="1001", status=ListingStatus.PENDING_REPUBLISH)
    db.add(lst)
    db.flush()
    task.spec = {**SPEC, "refresh_listing_id": lst.id}
    db.commit()
    asked = _erp_says(monkeypatch, {"allow": False, "reason": "货不在库（已出库）"})
    runner.run_task(task.id, bridge=None, loop=None)
    db.expire_all()

    assert flow_calls == [] and asked[0]["refresh"] is True
    assert db.get(Task, task.id).status == TaskStatus.CANCELLED
    assert db.get(Listing, lst.id).status == ListingStatus.PENDING_REPUBLISH


def test_blocked_refresh_delete_leaves_the_old_link_alone(bound, monkeypatch, flow_calls):
    db = bound
    task, job, _, acc = _running(db, source=REFRESH_TASK_SOURCE, task_type="goods_delete",
                                 job_type=JobType.REFRESH_LISTING)
    lst = Listing(sku="SK1", account_id=acc.id, item_id="1001", status=ListingStatus.LIVE)
    db.add(lst)
    db.flush()
    task.spec = {"item_id": "1001", "listing_id": lst.id}
    db.commit()
    _erp_says(monkeypatch, {"allow": False, "reason": "这家店还有上下架在途"})
    runner.run_task(task.id, bridge=None, loop=None)
    db.expire_all()

    assert flow_calls == []
    assert db.get(Listing, lst.id).status == ListingStatus.LIVE
    assert db.query(Task).filter(Task.job_id == job.id).count() == 1   # 没建重发


# ---------------------------------------------------------------- 能发 / 问不到
@pytest.mark.parametrize("answer", [
    {"allow": True, "reason": None},
    urllib.error.URLError("Connection refused"),
    TimeoutError("timed out"),
    {"detail": "只允许本机调用"},
    ["怪东西"],
])
def test_allowed_or_unreachable_publishes_as_usual(bound, monkeypatch, flow_calls, answer):
    db = bound
    task, job, _, _ = _running(db)
    _erp_says(monkeypatch, answer)
    runner.run_task(task.id, bridge=None, loop=None)
    db.expire_all()

    assert len(flow_calls) == 1
    assert db.get(Task, task.id).status == TaskStatus.SUCCESS
    assert db.query(Listing).filter(Listing.sku == "SK1").one().status == ListingStatus.LIVE


def test_not_asked_tasks_never_touch_erp(bound, monkeypatch, flow_calls):
    db = bound
    task, _, _, _ = _running(db, source="MANUAL")
    asked = _erp_says(monkeypatch, {"allow": False, "reason": "不该问"})
    runner.run_task(task.id, bridge=None, loop=None)
    db.expire_all()
    assert asked == [] and len(flow_calls) == 1
    assert db.get(Task, task.id).status == TaskStatus.SUCCESS


def test_real_post_hits_the_erp_internal_endpoint(monkeypatch):
    seen = {}

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"allow": false, "reason": "x"}'

    def urlopen(req, timeout):
        seen["url"], seen["timeout"], seen["body"] = req.full_url, timeout, req.data
        return Resp()

    monkeypatch.setattr(erp_precheck.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(settings, "erp_internal_base", "http://127.0.0.1:8000/")
    assert erp_precheck.ask({"sku_code": "SK1", "account_id": "a"}) == "x"
    assert seen["url"] == "http://127.0.0.1:8000/api/internal/publish-check"
    assert seen["timeout"] == settings.erp_publish_precheck_timeout_sec
