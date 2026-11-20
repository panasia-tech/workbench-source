"""读聊天(网页版)多轮 dump 并成一份时的消息顺序:老→新。

/im 最新在底部。_read_history 先回到底部 dump 一轮,再往上翻、每翻一次 dump 一轮:每轮都带着
全部已渲染的行,往上翻才加载的更早历史只出现在后面几轮。原来从第一轮正着并,更早的历史被排到
最新消息后面;jobs 按这个顺序落库,兜底判欠回复看的「最后一条」就成了一条老消息。
"""
from app.flow.web.read_chats_web import _parse_history


def _n(desc, cls, cx, cy, w=100, h=20):
    return {"desc": desc, "cls": cls, "clickable": False, "cx": cx, "cy": cy, "w": w, "h": h}


def _dump(msgs, peer="t***7"):
    """msgs: [(direction, text)] 老→新;最后一条在 cy=600,往上每条 80。"""
    nodes = [_n("", "message-topbar--x", 888, 40, 950, 80), _n(f"({peer})", "text2--x", 509, 40)]
    k = len(msgs)
    for i, (d, text) in enumerate(msgs):
        cy = 600 - (k - 1 - i) * 80
        x = 595 if d == "in" else 1177
        side = "message-text-left--l" if d == "in" else "message-text-right--o"
        nodes += [_n("", "message-row--r", x, cy, 364, 60),
                  _n("", f"message-text--t {side}", x + 32, cy, 300, 40),
                  _n(text, "span", x + 32, cy)]
    return nodes


def test_history_loaded_later_goes_before_newest():
    bottom = [("out", "在的"), ("in", "多少钱")]                 # 第一轮:回到底部时已渲染的
    older = [("in", "你好"), ("in", "在吗")]                      # 往上翻才加载出来的
    page = _parse_history([_dump(bottom), _dump(older + bottom), _dump(older + bottom)], 1446, 815)
    assert [m["text"] for m in page["messages"]] == ["你好", "在吗", "在的", "多少钱"]
    assert page["messages"][-1]["direction"] == "in"
    assert page["peer_key"] == "t***7"


def test_single_round_keeps_screen_order():
    msgs = [("in", "在吗"), ("out", "在的"), ("in", "多少钱")]
    page = _parse_history([_dump(msgs)], 1446, 815)
    assert [(m["direction"], m["text"]) for m in page["messages"]] == msgs


def test_page_meta_from_last_round_with_peer():
    """页面包仍取最后一轮(最后一轮没解析到 peer_key 就退回前一轮)。"""
    a = _dump([("in", "在吗")], peer="a***1")
    b = _dump([("in", "在吗")], peer="b***2")
    no_peer = [n for n in _dump([("in", "在吗")]) if "text2--" not in n["cls"]]
    assert _parse_history([a, b], 1446, 815)["peer_key"] == "b***2"
    assert _parse_history([a, b, no_peer], 1446, 815)["peer_key"] == "b***2"
