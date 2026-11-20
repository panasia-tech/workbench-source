"""进会话:列表还没渲染时要等,不能滚(一滚最新的几行就被滚过去了)。"""
from app.flow.web import reply_chat_web as flow

ROW = {"nick": "嘻喵喵酱", "last_message": "你好", "row_cx": 378, "row_cy": 202}
PAGE = {"peer_key": "2641179363", "peer_nick": "嘻喵喵酱"}


class FakeTransport:
    def __init__(self):
        self.swipes = 0
        self.taps = 0

    def dump_nodes(self):
        return []

    def swipe(self, *args, **kwargs):
        self.swipes += 1

    def tap(self, x, y):
        self.taps += 1


def _patch(monkeypatch, row_batches):
    batches = iter(row_batches)
    monkeypatch.setattr(flow, "parse_conversation_list_web", lambda n, w, h: next(batches))
    monkeypatch.setattr(flow, "parse_chat_page_web", lambda n, w, h: PAGE)
    monkeypatch.setattr(flow, "_on_chat_page", lambda n: True)
    monkeypatch.setattr(flow, "_check_risk", lambda n: None)
    monkeypatch.setattr(flow.time, "sleep", lambda s: None)


def test_waits_for_list_instead_of_scrolling(monkeypatch):
    _patch(monkeypatch, [[], [], [ROW]])
    t = FakeTransport()
    assert flow._enter_conversation(t, "2641179363", 1600, 800) is True
    assert t.swipes == 0 and t.taps == 1


def test_gives_up_when_list_never_loads(monkeypatch):
    _patch(monkeypatch, [[]] * (flow.LIST_LOAD_WAITS + 2))
    t = FakeTransport()
    assert flow._enter_conversation(t, "2641179363", 1600, 800) is False
    assert t.swipes == 0 and t.taps == 0


def test_still_scrolls_after_visible_rows_tried(monkeypatch):
    other = {**ROW, "nick": "别人"}
    page_iter = iter([{"peer_key": "1", "peer_nick": "别人"}, PAGE])
    _patch(monkeypatch, [[other], [], [ROW]])
    monkeypatch.setattr(flow, "parse_chat_page_web", lambda n, w, h: next(page_iter))
    t = FakeTransport()
    assert flow._enter_conversation(t, "2641179363", 1600, 800) is True
    assert t.swipes == 1 and t.taps == 2
