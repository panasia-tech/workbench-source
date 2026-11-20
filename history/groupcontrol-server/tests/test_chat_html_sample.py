"""读聊天时限量留会话页 HTML:商品 id / 缩略图没读到才留,留不下来不影响读聊天。"""
import pytest

from app.config import settings
from app.flow.web import read_chats_web as flow


class FakeTransport:
    def __init__(self, error=None):
        self.error = error
        self.calls = 0

    def page_snapshot(self):
        self.calls += 1
        if self.error:
            raise self.error
        return {"url": "https://www.goofish.com/im", "frames": [{"url": "u", "name": "", "html": "<a>卡片</a>"}]}


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    flow._html_sampled.clear()
    saved = {}

    def save(name, data, ext):
        saved[name] = (data, ext)
        return f"gc/shots/{name}.{ext}"

    monkeypatch.setattr(flow.storage, "save_blob", save)
    return saved


def test_saves_when_item_unknown(_clean):
    t = FakeTransport()
    key = flow._sample_chat_html(t, "t***2", {"item_id": None, "item_image": None})
    assert key == "gc/shots/chat_html_t___2.html"
    data, ext = _clean["chat_html_t___2"]
    assert ext == "html" and "卡片" in data.decode()


def test_skips_when_card_fully_read():
    t = FakeTransport()
    assert flow._sample_chat_html(t, "a", {"item_id": "1", "item_image": "x"}) is None
    assert t.calls == 0


def test_one_sample_per_conversation():
    t = FakeTransport()
    flow._sample_chat_html(t, "a", {})
    assert flow._sample_chat_html(t, "a", {}) is None
    assert t.calls == 1


def test_limit_and_off(monkeypatch):
    t = FakeTransport()
    monkeypatch.setattr(settings, "chat_html_sample_limit", 1)
    flow._sample_chat_html(t, "a", {})
    assert flow._sample_chat_html(t, "b", {}) is None
    assert t.calls == 1
    flow._html_sampled.clear()
    monkeypatch.setattr(settings, "chat_html_sample_limit", 0)
    assert flow._sample_chat_html(t, "c", {}) is None and t.calls == 1


def test_failure_does_not_raise():
    assert flow._sample_chat_html(FakeTransport(RuntimeError("老执行端")), "a", {}) is None
