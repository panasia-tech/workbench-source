"""人工回复(1b):建单 / 记账 / 流程入口 / API。"""

import pytest

import app.flow.publish_flow as publish_flow
import app.flow.reply_chat as reply_chat
from app import jobs
from app.api import reply_conversation
from app.flow.engine import Engine, RiskHit
from app.models import Account, ChatMessage, Conversation, JobType, Task, TaskStatus
from app.schemas import ChatReplyIn


def _conv(db):
    a = Account(nick="a")
    db.add(a)
    db.flush()
    c = Conversation(account_id=a.id, peer_key="t***7", peer_nick="t***7")
    db.add(c)
    db.commit()
    return c


# ---------- 建单 ----------

def test_create_chat_reply_builds_task(db):
    c = _conv(db)
    job = jobs.create_chat_reply(db, c.id, " 好的亲,今天发货 ")
    assert job.job_type == JobType.CHAT_REPLY
    ts = db.query(Task).filter(Task.job_id == job.id).all()
    assert len(ts) == 1
    t = ts[0]
    assert t.task_type == "chat_reply" and t.status == TaskStatus.PENDING
    assert t.account_id == c.account_id
    assert t.spec == {"conversation_id": c.id, "peer_key": "t***7", "text": "好的亲,今天发货"}


def test_create_chat_reply_rejects(db):
    c = _conv(db)
    with pytest.raises(ValueError):
        jobs.create_chat_reply(db, "no-such-conv", "hi")
    with pytest.raises(ValueError):
        jobs.create_chat_reply(db, c.id, "   ")


# ---------- 记账 ----------

def test_on_chat_reply_ok_inserts_out_and_dedups(db):
    c = _conv(db)
    job = jobs.create_chat_reply(db, c.id, "好的亲")
    t = db.query(Task).filter(Task.job_id == job.id).one()
    jobs._on_chat_reply_ok(db, t)
    db.commit()
    msgs = db.query(ChatMessage).filter(ChatMessage.conversation_id == c.id).all()
    assert len(msgs) == 1 and msgs[0].direction == "out" and msgs[0].text == "好的亲"
    assert db.get(Conversation, c.id).last_message == "好的亲"
    # 幂等:同一单重放不再入库(键里带任务号)
    jobs._on_chat_reply_ok(db, t)
    db.commit()
    assert db.query(ChatMessage).filter(ChatMessage.conversation_id == c.id).count() == 1


def _reply_ok(db, conv, text):
    job = jobs.create_chat_reply(db, conv.id, text)
    t = db.query(Task).filter(Task.job_id == job.id).one()
    t.status = TaskStatus.SUCCESS
    jobs._on_chat_reply_ok(db, t)
    db.commit()
    return t


def _scan(db, conv, msgs):
    """chat_scan 读回这个会话(msgs: [(direction, text)] 老→新)。"""
    t = Task(task_type="chat_scan", account_id=conv.account_id, status=TaskStatus.SUCCESS,
             result={"ok": True,
                     "conversations": [{"peer_key": conv.peer_key, "peer_nick": conv.peer_nick,
                                        "last_message": msgs[-1][1], "unread": 0}],
                     "messages": {conv.peer_key: [{"direction": d, "text": x, "msg_at": None}
                                                  for d, x in msgs]}})
    db.add(t)
    db.commit()
    jobs._on_chat_scan_ok(db, t)
    db.commit()


def _texts(db, conv):
    return [(m.direction, m.text) for m in db.query(ChatMessage).filter(
        ChatMessage.conversation_id == conv.id).order_by(ChatMessage.created_at.asc())]


def test_same_text_twice_leaves_two_records(db):
    """同一会话第二次发同一句(兜底话术每次都是同一句):两单都要留记录,末条是我们这条。
    原来与 chat_scan 同键,第二次撞键不落库,末条还是买家那句。"""
    c = _conv(db)
    _scan(db, c, [("in", "在吗")])
    _reply_ok(db, c, "您好，消息已收到")
    _scan(db, c, [("in", "在吗"), ("out", "您好，消息已收到"), ("in", "多少钱")])
    _reply_ok(db, c, "您好，消息已收到")
    assert _texts(db, c) == [("in", "在吗"), ("out", "您好，消息已收到"),
                             ("in", "多少钱"), ("out", "您好，消息已收到")]
    row = db.get(Conversation, c.id)
    assert row.last_message == "您好，消息已收到" and row.last_message_at is not None


def test_scan_after_reply_does_not_duplicate(db):
    """回复记账之后扫描读回这个气泡(页面上两条同文气泡,_parse_history 也只吐一条):不再记。"""
    c = _conv(db)
    _scan(db, c, [("in", "在吗")])
    _reply_ok(db, c, "在的")
    _reply_ok(db, c, "在的")
    _scan(db, c, [("in", "在吗"), ("out", "在的"), ("in", "包邮吗")])
    assert _texts(db, c) == [("in", "在吗"), ("out", "在的"), ("out", "在的"), ("in", "包邮吗")]


def test_reply_after_scanned_same_text(db):
    """扫描先记过一条同文 out(比如上次回复核对没过、其实发出去了),再回复同一句成功:两条都在。"""
    c = _conv(db)
    _scan(db, c, [("in", "在吗"), ("out", "在的"), ("in", "?")])
    _reply_ok(db, c, "在的")
    assert _texts(db, c)[-1] == ("out", "在的")
    assert len(_texts(db, c)) == 4


# ---------- 流程 ----------

class _FakeTransport:
    def __init__(self, nodes=None):
        self._nodes = nodes or []

    def screen_size(self):
        return (1080, 2400)

    def key(self, code):
        pass

    def dump_nodes(self):
        return self._nodes


def _bubble(text, cx, cy, w=200, h=60):
    return {"desc": text, "cls": "android.widget.TextView", "clickable": False,
            "center": (cx, cy), "size": (w, h)}


def test_run_reply_chat_rejects_bad_spec(monkeypatch):
    monkeypatch.setattr(publish_flow, "reset_to_clean", lambda e: None)
    result = reply_chat.run_reply_chat(_FakeTransport(), {"peer_key": "", "text": ""})
    assert result["ok"] is False and result["failed_step"] == "reply_spec"


def test_run_reply_chat_risk_hit_populates_risk(monkeypatch):
    def _boom(e):
        raise RiskHit("验证码", shot="shots/risk.png")

    monkeypatch.setattr(reply_chat, "_open_messages", _boom)
    monkeypatch.setattr(publish_flow, "reset_to_clean", lambda e: None)
    result = reply_chat.run_reply_chat(_FakeTransport(), {"peer_key": "t***7", "text": "好"})
    assert result["ok"] is False and result["risk"] == "验证码"


def test_verify_sent_matches_last_out_bubble():
    # out 气泡:x1 > 0.35w 且 x2 > 0.65w;cy 在 10%~90% 屏高内
    nodes = [_bubble("在吗", 200, 500), _bubble("好的亲", 900, 800)]
    e = Engine(_FakeTransport(nodes))
    assert reply_chat._verify_sent(e, "好的亲") is True
    assert reply_chat._verify_sent(e, "别的话") is False
    assert reply_chat._verify_sent(Engine(_FakeTransport([])), "好的亲") is False


class _FlutterTransport:
    """模拟 Flutter 聊天输入框:set_text 抛错(不可写),走 ime_input 注入。"""

    def __init__(self):
        self.calls = []
        self.injected = False

    def screen_size(self):
        return (1080, 2400)

    def tap(self, x, y):
        self.calls.append(("tap", x, y))

    def swipe(self, x1, y1, x2, y2, ms=300):
        self.calls.append(("swipe", ms))

    def set_text(self, text):
        self.calls.append(("set_text", text))
        raise RuntimeError("未找到聚焦输入框")

    def ime_picker(self):
        self.calls.append(("ime_picker",))

    def ime_commit(self, text):
        self.calls.append(("ime_commit", text))
        self.injected = True

    def node_click(self, desc, index=0):
        self.calls.append(("node_click", desc))
        return True

    def node_long_click(self, desc, index=0):
        self.calls.append(("node_long_click", desc))
        return True

    def dump_nodes(self):
        nodes = [
            {"desc": "想跟TA说点什么...", "cls": "View", "clickable": True,
             "center": (485, 1387), "size": (600, 80)},
            {"desc": "发送", "cls": "View", "clickable": True,
             "center": (970, 1402), "size": (100, 60)},
        ]
        if self.injected:
            nodes.append({"desc": "好的亲", "cls": "View", "clickable": False,
                          "center": (455, 1387), "size": (200, 60)})
        return nodes


def test_send_text_falls_back_to_ime_input():
    t = _FlutterTransport()
    e = Engine(t)
    reply_chat._send_text(e, "好的亲")
    assert ("ime_commit", "好的亲") in t.calls             # 走了 IME 注入
    assert ("node_click", "发送") in t.calls              # 最后点发送
    # set_text 尝试过但失败后才注入
    assert t.calls.index(("set_text", "好的亲")) < t.calls.index(("ime_commit", "好的亲"))


# ---------- API ----------
def test_reply_endpoint_creates_job(db):
    c = _conv(db)
    res = reply_conversation(c.id, ChatReplyIn(text="好的亲"), user={}, db=db)
    assert res["ok"] is True and res["job_id"]
    t = db.query(Task).filter(Task.job_id == res["job_id"]).one()
    assert t.task_type == "chat_reply"
    assert res["task_id"] == t.id      # 小程序拿它轮询这条发没发出去


def test_reply_endpoint_400_on_missing_conv(db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        reply_conversation("no-such", ChatReplyIn(text="hi"), user={}, db=db)
    assert ei.value.status_code == 400
