"""开场登录检查(ensure_logged_in)+ 掉登录冻结通知(runner._apply_result login 分支)。"""
import pytest

from app.flow.engine import LoginRequired
from app.flow.ready import ensure_logged_in


class _T:
    def __init__(self, node_descs=()):
        self._nodes = [{"desc": d} for d in node_descs]

    def dump_nodes(self):
        return self._nodes


class _E:
    def __init__(self, node_descs=(), ocr_texts=()):
        self.t = _T(node_descs)
        self._ocr = [{"text": t} for t in ocr_texts]

    def read(self):
        return self._ocr

    def save_shot(self, name):
        return "shot-key"


def test_ensure_logged_in_raises_on_node_anchor():
    with pytest.raises(LoginRequired):
        ensure_logged_in(_E(node_descs=["立即登录", "其它"]), "publish")


def test_ensure_logged_in_raises_on_ocr_anchor():
    # 节点没读到登录锚点 → OCR 兜底命中
    with pytest.raises(LoginRequired):
        ensure_logged_in(_E(node_descs=["随便"], ocr_texts=["一键登录 注册"]), "delist")


def test_ensure_logged_in_noop_when_logged_in():
    # 已登录:首页/消息锚点在,无登录页锚点 → 不抛
    ensure_logged_in(_E(node_descs=["卖闲置", "消息", "我的"], ocr_texts=["首页"]), "read_chats")


def test_apply_result_login_freezes_and_notifies(db, monkeypatch):
    from app.flow import runner
    from app.models import Account, AccountStatus, Task, TaskStatus

    monkeypatch.setattr("app.jobs.on_task_result", lambda *a, **k: None)
    sent = {}

    def fake_wecom(*a, **k):
        sent["ok"] = True
        return True

    monkeypatch.setattr("app.notify.notify_wecom", fake_wecom)

    acc = Account(nick="账号A", status=AccountStatus.ACTIVE)
    db.add(acc); db.flush()
    running = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.RUNNING)
    pending = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.PENDING)
    db.add(running); db.add(pending); db.commit()

    runner._apply_result(db, running, {"ok": False, "login": True,
                                       "reason": "掉登录", "failed_step": "read_chats"})

    db.refresh(acc); db.refresh(pending)
    assert acc.status == AccountStatus.FROZEN
    assert acc.risk_note and "掉登录" in acc.risk_note
    assert pending.status == TaskStatus.CANCELLED   # 待办任务被取消
    assert sent.get("ok")                            # 已通知人工
