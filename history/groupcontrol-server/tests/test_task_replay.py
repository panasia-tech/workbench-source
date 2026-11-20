"""任务回放(GET /api/gc/tasks/{id}/trace,2026-10-06)。

用户:「我不知道它是否真的在执行,执行到哪一步了」。每单本来就逐动作截图留痕(trace.py),
只是没有地方看。这里钉死:跑完的读 actions.json,跑着的读内存(走到哪一步看到哪一步),
截图给限时 https 直链,签名参数不外泄。
"""
import json
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.storage as storage
from app.api import get_task_trace
from app.database import Base
from app.flow import runner, trace
from app.flow.trace import TraceTransport
from app.models import Device, Task, TaskStatus
from app.schemas import TaskReplayOut
from app.task_replay import build_replay

STARTED = datetime(2026, 10, 6, 7, 32, 36)
T0 = STARTED.replace(tzinfo=timezone.utc).timestamp()


class _Obj:
    def __init__(self, data): self._data = data
    def read(self): return self._data


class FakeBucket:
    """oss2.Bucket 替身:put 进来的对象按 key 存着;sign_url 出 http 链接(endpoint 没写协议时就是这样)。"""

    def __init__(self): self.objects = {}

    def put_object(self, key, data): self.objects[key] = data

    def get_object(self, key):
        if key not in self.objects:
            raise KeyError(key)
        return _Obj(self.objects[key])

    def sign_url(self, method, key, expires, params=None):
        q = "OSSAccessKeyId=AK&Expires=1&Signature=sig"
        if params:
            q += "".join(f"&{k}={v}" for k, v in params.items())
        return f"http://bkt.oss-cn-shanghai.aliyuncs.com/{key}?{q}"


@pytest.fixture
def bucket(monkeypatch):
    b = FakeBucket()
    monkeypatch.setattr(storage, "_bucket", b)
    return b


def _store_trace(bucket, label, records):
    key = f"gc/shots/1_trace/{label}/actions.json"
    bucket.put_object(key, json.dumps({"label": label, "records": records}).encode())
    return key


def test_finished_task_replays_from_stored_trace(bucket):
    key = _store_trace(bucket, "T1", [
        # 故意乱序:按 seq 排
        {"seq": 3, "ts": T0 + 20.04, "action": "tap", "args": "(520,-391)", "ms": 102,
         "error": "原语 tap 超时(15.0s)", "shot_error": "截图超时"},
        {"seq": 1, "ts": T0 + 0.4, "action": "launch_app", "args": "https://www.goofish.com/publish",
         "ms": 1183, "shot": "gc/shots/2_trace/T1/001_launch_app.png"},
        # 老数据:push_media 记的是链接末尾 60 字符,全是签名参数
        {"seq": 2, "ts": T0 + 9.75, "action": "push_media", "args": "xpires=1791358355&Signature=iPp8Fj4C",
         "ms": 644, "shot": "gc/shots/3_trace/T1/002_push_media.png"},
    ])
    task = Task(id="T1", task_type="goods_publish", status=TaskStatus.FAILED, started_at=STARTED,
                shot_key="gc/shots/9_pub_no_advance.png", result={"trace_key": key})

    r = TaskReplayOut.model_validate(build_replay(task)).model_dump()

    assert r["live"] is False and r["note"] is None
    assert [s["seq"] for s in r["steps"]] == [1, 2, 3]
    first, media, failed = r["steps"]
    assert first["at"] == 0.4 and first["action"] == "launch_app" and first["ms"] == 1183
    assert first["shot_url"].startswith("https://bkt.") and "001_launch_app.png" in first["shot_url"], \
        "后台是 https 页面,http 截图会被当混合内容拦掉"
    assert "x-oss-process=image/resize,w_360" in first["thumb_url"] and "x-oss-process" not in first["shot_url"]
    assert media["args"] == "(图片链接)", "签名参数不能原样给前端"
    assert failed["error"].startswith("原语 tap 超时") and failed["shot_url"] is None and failed["shot_error"]
    assert failed["at"] == 20.0
    assert "9_pub_no_advance.png" in r["result_shot_url"] and r["result_thumb_url"]


def test_running_task_shows_steps_so_far(bucket, monkeypatch):
    """跑着的任务读内存里的留痕:截图是每步当场传的,所以实时就能看到画面。"""
    monkeypatch.setattr(trace, "_SETTLE_BEFORE_SHOT", 0)

    class Inner:
        def tap(self, x, y): pass
        def screencap(self): return b"jpeg"
        def push_media(self, url): return "/tmp/a.jpg"

    task = Task(id="T2", task_type="goods_publish", status=TaskStatus.RUNNING, started_at=STARTED)
    tracer = TraceTransport(Inner(), storage.save_shot, label="T2")
    trace.track_live(tracer)
    try:
        tracer.push_media("https://bkt.oss-cn-shanghai.aliyuncs.com/sku%2Fproduct%2F178.jpg"
                          "?OSSAccessKeyId=AK&Expires=1791358355&Signature=abc")
        tracer.tap(520, 482)
        r = build_replay(task)
        assert r["live"] is True and [s["action"] for s in r["steps"]] == ["push_media", "tap"]
        assert r["steps"][0]["args"] == "/sku/product/178.jpg", "留痕只记对象路径,不记签名"
        assert all(s["shot_url"] for s in r["steps"]), "截图在动作后当场就传了"
    finally:
        trace.untrack_live("T2")
    # 撤了登记(结果已写回)又没有 trace_key:如实说没有
    r = build_replay(task)
    assert r["live"] is False and r["steps"] == [] and r["note"] == "这单没有留痕"


def test_notes_when_there_is_nothing_to_show(bucket):
    pending = Task(id="T3", task_type="goods_publish", status=TaskStatus.PENDING)
    assert build_replay(pending)["note"] == "还没开始跑"
    lost = Task(id="T4", task_type="goods_publish", status=TaskStatus.SUCCESS,
                result={"trace_key": "gc/shots/1_trace/T4/actions.json"})
    r = build_replay(lost)
    assert r["steps"] == [] and r["note"] == "留痕文件读不到了"
    no_trace = Task(id="T5", task_type="restart", status=TaskStatus.SUCCESS, result={"ok": True})
    assert build_replay(no_trace)["note"] == "这单没有留痕"


def test_route_404_and_shape(db, bucket):
    with pytest.raises(HTTPException) as missing:
        get_task_trace("nope", db=db)
    assert missing.value.status_code == 404
    db.add(Task(id="T6", task_type="chat_scan", status=TaskStatus.SUCCESS, result={}))
    db.commit()
    r = get_task_trace("T6", db=db)
    assert r["task_id"] == "T6" and r["steps"] == []


def test_runner_registers_live_trace_until_result_is_written(monkeypatch):
    """runner 从开跑到结果写回库都挂着登记;写回之后撤掉(中间不留「库里还在跑、内存里没了」的空档)。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(runner, "SessionLocal", Session)
    monkeypatch.setattr("app.jobs.on_task_result", lambda *a, **k: None)
    with Session() as s:
        s.add(Device(id="dev-1", name="浏览器", token="t", kind="browser"))
        s.add(Task(id="T7", device_id="dev-1", task_type="goods_publish", status=TaskStatus.RUNNING))
        s.commit()

    seen = {}

    def fake_flow(transport, spec, shot_sink=None):
        seen["during"] = trace.live_records("T7")
        return {"ok": True, "done": ["publish"], "failed_step": None, "reason": None, "shot": None, "risk": None}

    monkeypatch.setattr(runner, "_pick_flow", lambda task_type, kind: fake_flow)
    runner.run_task("T7", bridge=None, loop=None)

    assert seen["during"] == [], "流程跑着的时候就登记了(还没动作,所以是空列表而不是 None)"
    assert trace.live_records("T7") is None, "写回之后撤掉登记"
    with Session() as s:
        assert s.get(Task, "T7").status == TaskStatus.SUCCESS
    engine.dispose()
