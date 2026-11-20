"""要冻号的任务必须留现场:截图 + 命中关键词的页面原文。

关键词匹配会扫到买家消息,只留一个词人判断不了真假(11-01 土星读聊天命中「违规」,查不出是哪句话)。
"""
from uuid import uuid4

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.flow import runner
from app.models import Account, AccountStatus, Device, RiskState, Task, TaskStatus


class FakeTransport:
    def __init__(self, nodes=(), shot_error=None):
        self.nodes = list(nodes)
        self.shot_error = shot_error
        self.shots = 0

    def screencap(self):
        self.shots += 1
        if self.shot_error:
            raise self.shot_error
        return b"png"

    def dump_nodes(self):
        return self.nodes


def _saved(monkeypatch):
    names = []

    def save(name, data):
        names.append(name)
        return f"gc/shots/{name}.png"

    monkeypatch.setattr(runner.storage, "save_shot", save)
    return names


def test_risk_gets_screenshot_and_matched_text(monkeypatch):
    names = _saved(monkeypatch)
    t = FakeTransport([{"desc": "买家:你这是违规商品吧"}, {"desc": "你好"}, {"desc": "买家:你这是违规商品吧"}])
    result = {"ok": False, "risk": "违规", "shot": None}
    runner._capture_freeze_evidence(t, result, "t1")
    assert result["shot"] == "gc/shots/t1_freeze.png" and names == ["t1_freeze"]
    assert result["risk_text"] == ["买家:你这是违规商品吧"]


def test_login_lost_gets_screenshot_without_text(monkeypatch):
    _saved(monkeypatch)
    result = {"ok": False, "login": True, "risk": None, "shot": None}
    runner._capture_freeze_evidence(FakeTransport(), result, "t2")
    assert result["shot"] and "risk_text" not in result


def test_existing_shot_is_kept(monkeypatch):
    names = _saved(monkeypatch)
    t = FakeTransport()
    result = {"risk": "违规", "shot": "gc/shots/flow.png"}
    runner._capture_freeze_evidence(t, result, "t3")
    assert result["shot"] == "gc/shots/flow.png" and t.shots == 0 and not names


def test_normal_failure_takes_no_screenshot(monkeypatch):
    _saved(monkeypatch)
    t = FakeTransport()
    runner._capture_freeze_evidence(t, {"ok": False, "risk": None, "shot": None}, "t4")
    assert t.shots == 0


def test_screenshot_failure_does_not_block(monkeypatch):
    _saved(monkeypatch)
    t = FakeTransport([{"desc": "违规"}], shot_error=RuntimeError("离线"))
    result = {"risk": "违规", "shot": None}
    runner._capture_freeze_evidence(t, result, "t5")
    assert result["shot"] is None and result["risk_text"] == ["违规"]


def test_text_is_limited():
    nodes = [{"desc": f"违规{i}" + "字" * 200} for i in range(9)]
    texts = runner._texts_with_anchor(nodes, "违规")
    assert len(texts) == runner.RISK_TEXT_LIMIT and all(len(x) == runner.RISK_TEXT_LEN for x in texts)


def test_freeze_note_and_alert_carry_evidence(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    dev = Device(id=uuid4().hex, name="d", kind="browser", hw_id="env1")
    acc = Account(id=uuid4().hex, nick="土星", device_id=dev.id, status=AccountStatus.ACTIVE)
    task = Task(id=uuid4().hex, account_id=acc.id, device_id=dev.id, task_type="chat_scan", status=TaskStatus.RUNNING)
    db.add_all([dev, acc, task])
    db.commit()
    sent = {}
    monkeypatch.setattr("app.notify.send_alert_with_shot",
                        lambda title, desp, **kw: sent.update(desp=desp, **kw) or True)
    runner._apply_result(db, task, {"ok": False, "risk": "违规", "reason": "命中风控:违规", "failed_step": "read_chats",
                                    "shot": "gc/shots/x.png", "risk_text": ["买家:违规商品"]})
    db.refresh(acc)
    assert acc.risk_state == RiskState.FROZEN and "买家:违规商品" in acc.risk_note
    assert acc.risk_note.startswith("命中风控:违规")
    assert sent["shot_key"] == "gc/shots/x.png" and "买家:违规商品" in sent["desp"]
