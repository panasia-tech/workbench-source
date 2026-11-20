"""回归(2026-07-29 幻影会话):点 row 没进聊天页 / 聊天页解析不到会员名 → 跳过,不建会话。

之前 read_chats 无校验:点歪后把消息列表/Tab 页文本当气泡解析,peer_key 用 row 坐标
兜底 → 每轮扫描新建幻影会话(rowNNN)、垃圾文本全入库(生产 6 会话 306 条垃圾)。
"""

import app.flow.publish_flow as publish_flow
import app.flow.read_chats as read_chats


class _FakeT:
    """read_chats 用到的 transport 原语最小集。"""

    def __init__(self, nodes=None):
        self._nodes = nodes or []

    def dump_nodes(self):
        return self._nodes

    def key(self, k):
        pass


class _FakeEngine:
    def __init__(self, transport, shot_sink=None):
        self.width, self.height = 1080, 2400
        self.t = transport

    def tap_xy(self, *a, **k):
        pass


def _patch_common(monkeypatch, **kw):
    monkeypatch.setattr(read_chats, "_open_messages", lambda e: None)
    monkeypatch.setattr(publish_flow, "reset_to_clean", lambda e: None)
    monkeypatch.setattr(read_chats, "Engine", _FakeEngine)
    monkeypatch.setattr(read_chats, "parse_conversation_list",
                        lambda nodes, w, h: [{"row_cy": 500, "order_status": None,
                                              "last_message": "x", "unread": 1, "has_unread": True}])
    for name, val in kw.items():
        monkeypatch.setattr(read_chats, name, val)


def test_skips_when_chat_page_not_open(monkeypatch):
    _patch_common(monkeypatch, _on_chat_page=lambda e: False)
    result = read_chats.run_read_chats(_FakeT(), {})
    assert result["ok"] is True
    assert result["conversations"] == []
    assert result["messages"] == {}


def test_skips_when_peer_key_missing(monkeypatch):
    _patch_common(
        monkeypatch,
        _on_chat_page=lambda e: True,
        _read_history=lambda e: [],
        parse_chat_page=lambda nodes, w, h: {"item_title": None, "peer_key": None,
                                             "messages": [{"direction": "in", "text": "垃圾", "msg_at": None}]},
    )
    result = read_chats.run_read_chats(_FakeT(), {})
    assert result["ok"] is True
    assert result["conversations"] == []
    assert result["messages"] == {}


def test_keeps_valid_conversation(monkeypatch):
    _patch_common(
        monkeypatch,
        _on_chat_page=lambda e: True,
        _read_history=lambda e: [],
        parse_chat_page=lambda nodes, w, h: {"item_title": "半卖半送了", "peer_key": "t***7",
                                             "messages": [{"direction": "in", "text": "在吗", "msg_at": None}]},
    )
    result = read_chats.run_read_chats(_FakeT(), {})
    assert result["ok"] is True
    assert [c["peer_key"] for c in result["conversations"]] == ["t***7"]
    assert len(result["messages"]["t***7"]) == 1


def test_on_chat_page_detection():
    e = _FakeEngine(_FakeT([{"desc": "想跟TA说点什么...", "center": (100, 2300), "size": (400, 60)}]))
    assert read_chats._on_chat_page(e) is True
    e2 = _FakeEngine(_FakeT([{"desc": "第 1 个标签，共 3 个", "center": (100, 500), "size": (400, 60)}]))
    assert read_chats._on_chat_page(e2) is False


def test_skips_conversation_without_unread(monkeypatch):
    """未读驱动:unread=0 的会话根本不点开(即便能进聊天页、也有消息)。"""
    _patch_common(
        monkeypatch,
        _on_chat_page=lambda e: True,
        _read_history=lambda e: [],
        parse_chat_page=lambda nodes, w, h: {"item_title": "x", "peer_key": "t***7",
                                             "messages": [{"direction": "in", "text": "在吗", "msg_at": None}]},
        parse_conversation_list=lambda nodes, w, h: [{"row_cy": 500, "order_status": None,
                                                      "last_message": "x", "unread": 0, "has_unread": False}],
    )
    result = read_chats.run_read_chats(_FakeT(), {})
    assert result["ok"] is True
    assert result["conversations"] == []
    assert result["messages"] == {}


def test_one_conversation_error_keeps_others(monkeypatch):
    """单会话读崩(非风控)不带走整轮:其余会话仍返回(增量保留,不再一崩全丢)。"""
    rows = [{"row_cy": 300, "order_status": None, "last_message": "a", "unread": 1, "has_unread": True},
            {"row_cy": 600, "order_status": None, "last_message": "b", "unread": 1, "has_unread": True}]
    seq = {"n": 0}

    def flaky_page(nodes, w, h):
        seq["n"] += 1
        if seq["n"] == 1:
            raise RuntimeError("OCR 崩了")
        return {"item_title": "b", "peer_key": "b***9",
                "messages": [{"direction": "in", "text": "hi", "msg_at": None}]}

    _patch_common(
        monkeypatch,
        _on_chat_page=lambda e: True,
        _read_history=lambda e: [],
        parse_chat_page=flaky_page,
        parse_conversation_list=lambda nodes, w, h: rows,
    )
    result = read_chats.run_read_chats(_FakeT(), {})
    assert result["ok"] is True
    assert [c["peer_key"] for c in result["conversations"]] == ["b***9"]
