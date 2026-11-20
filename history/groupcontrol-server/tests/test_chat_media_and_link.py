"""聊天页改版配套:会话认货(listing_sku)、发图片 / 视频(收件规则、开关、记账、网页流程)、
单个会话 / 最新消息 / 贴链接认货接口。"""

import pytest
from fastapi import HTTPException

from app import chat_media, jobs, storage
from app.api import get_conversation, list_messages, reply_conversation, resolve_item
from app.config import settings
from app.flow.web import reply_chat_web
from app.flow.web.parse import parse_chat_page_web
from app.models import (
    Account, ChatMessage, Conversation, Device, Listing, ListingStatus, Task,
)
from app.schemas import ChatReplyIn

HOST = "bkt.oss-cn-shanghai.aliyuncs.com"


@pytest.fixture(autouse=True)
def _oss(monkeypatch):
    monkeypatch.setattr(settings, "oss_bucket", "bkt")
    monkeypatch.setattr(settings, "oss_endpoint", "https://oss-cn-shanghai.aliyuncs.com")
    # 签名要真 OSS:测试里拼一个看得出参数的假链接
    monkeypatch.setattr(storage, "sign_object_url",
                        lambda key, expires=86400, process=None: f"https://{HOST}/{key}?sig" + (f"&p={process}" if process else ""))


def _acc_conv(db, kind="browser", **conv_kw):
    d = Device(name="d1", kind=kind)
    db.add(d)
    db.flush()
    a = Account(nick="店A", device_id=d.id)
    db.add(a)
    db.flush()
    c = Conversation(account_id=a.id, peer_key="1001", peer_nick="买家", **conv_kw)
    db.add(c)
    db.commit()
    return a, c


def _listing(db, acc, sku, *, title=None, price=None, item_id=None, status=ListingStatus.LIVE):
    lst = Listing(sku=sku, account_id=acc.id, title=title, price=price, item_id=item_id, status=status)
    db.add(lst)
    db.commit()
    return lst


# ---------------------------------------------------------------- 认货

def test_link_by_title_price_and_item_id(db):
    a, _ = _acc_conv(db)
    _listing(db, a, "SKU-T", title="Rokid Glasses AR智能眼镜 9成新 全套", price=1688)
    _listing(db, a, "SKU-P1", price=999)
    _listing(db, a, "SKU-P2", price=500)
    _listing(db, a, "SKU-P3", price=500)
    _listing(db, a, "SKU-I", item_id="778899001122", status=ListingStatus.SOLD)
    convs = [
        {"peer_key": "1001", "item_title": "Rokid Glasses AR智能眼镜…", "item_price": "1688.00"},
        {"peer_key": "1002", "item_title": None, "item_price": "999.00"},
        {"peer_key": "1003", "item_title": None, "item_price": "500"},       # 两条同价:不认
        {"peer_key": "1004", "item_id": "778899001122", "item_price": "1"},   # 商品 id 最准,卖了也认
    ]
    for c in convs[1:]:
        db.add(Conversation(account_id=a.id, peer_key=c["peer_key"]))
    db.commit()
    jobs._link_listings(db, a.id, convs)
    db.commit()
    got = {c.peer_key: (c.listing_sku, c.item_id) for c in db.query(Conversation).all()}
    assert got["1001"] == ("SKU-T", None)
    assert got["1002"] == ("SKU-P1", None)
    assert got["1003"] == (None, None)
    assert got["1004"] == ("SKU-I", "778899001122")


def test_link_keeps_old_when_unsure_and_clears_on_new_unknown_item(db):
    a, c = _acc_conv(db, listing_sku="SKU-OLD", item_id="111111")
    jobs._link_listings(db, a.id, [{"peer_key": "1001", "item_price": "123"}])
    db.commit()
    assert db.get(Conversation, c.id).listing_sku == "SKU-OLD"      # 认不出:留着
    jobs._link_listings(db, a.id, [{"peer_key": "1001", "item_id": "222222"}])
    db.commit()
    row = db.get(Conversation, c.id)
    assert (row.listing_sku, row.item_id) == (None, "222222")     # 换了一件、账本里没有:旧的作废


def test_parse_item_id_from_card_link():
    nodes = [
        {"cls": "message-topbar--x", "desc": "", "cx": 500, "cy": 40, "w": 600, "h": 60, "clickable": False},
        {"cls": "card--x", "desc": "https://www.goofish.com/item?spm=a&id=778899001122", "cx": 500, "cy": 120,
         "w": 500, "h": 80, "clickable": True},
        {"cls": "message-row--a", "desc": "", "cx": 500, "cy": 300, "w": 600, "h": 50, "clickable": False},
        {"cls": "message-text-left--x", "desc": "在吗", "cx": 300, "cy": 300, "w": 100, "h": 30, "clickable": False},
    ]
    assert parse_chat_page_web(nodes, 1200, 900)["item_id"] == "778899001122"


# ---------------------------------------------------------------- 收件规则

def test_normalize_media_accepts_own_bucket_only():
    out = chat_media.normalize_media([
        {"type": "image", "url": f"https://{HOST}/sku/product/a.jpg?Expires=1&Signature=x"},
        {"type": "image", "url": f"https://{HOST}/chat/outbox/v%201.webp"},
        {"type": "image", "url": f"https://{HOST}/sku/product/a.jpg"},                    # 重复
    ])
    assert out == [{"type": "image", "key": "sku/product/a.jpg"},
                   {"type": "image", "key": "chat/outbox/v 1.webp"}]
    bad = [
        {"type": "image", "url": "https://evil.example.com/a.jpg"},
        {"type": "image", "url": f"https://{HOST}/sku/location/l.jpg"},
        {"type": "image", "url": f"https://{HOST}/asset/x_order_1.jpg"},
        {"type": "image", "url": f"https://{HOST}/gc/shots/1.png"},
        {"type": "image", "url": f"https://{HOST}/sku/product/a.mp4"},
        {"type": "video", "url": f"https://{HOST}/chat/outbox/v.mp4"},                     # 网页版发不了视频
    ]
    for item in bad:
        with pytest.raises(ValueError):
            chat_media.normalize_media([item])
    with pytest.raises(ValueError):
        chat_media.normalize_media([{"type": "image", "url": f"https://{HOST}/sku/product/{i}.jpg"} for i in range(10)])


def test_summary_and_media_out():
    media = [{"type": "image", "key": "a.jpg"}, {"type": "image", "key": "b.jpg"}, {"type": "video", "key": "c.mp4"}]
    assert chat_media.summary_text(media) == "[图片]×2 [视频]"
    out = chat_media.media_out(media)
    assert out[0]["url"].startswith(f"https://{HOST}/a.jpg") and "image/resize" in out[0]["thumb"]
    assert "video/snapshot" in out[2]["thumb"]


# ---------------------------------------------------------------- 回复接口

def test_media_reply_rejected_while_switch_off(db, monkeypatch):
    monkeypatch.setattr(settings, "chat_media_enabled", False)
    _, c = _acc_conv(db)
    with pytest.raises(HTTPException) as ei:
        reply_conversation(c.id, ChatReplyIn(media=[{"type": "image", "url": f"https://{HOST}/sku/product/a.jpg"}]),
                           user={}, db=db)
    assert ei.value.status_code == 409
    assert db.query(Task).count() == 0


def test_media_reply_rejected_on_android(db, monkeypatch):
    monkeypatch.setattr(settings, "chat_media_enabled", True)
    _, c = _acc_conv(db, kind="android")
    with pytest.raises(HTTPException) as ei:
        reply_conversation(c.id, ChatReplyIn(media=[{"type": "image", "url": f"https://{HOST}/sku/product/a.jpg"}]),
                           user={}, db=db)
    assert ei.value.status_code == 409


def test_media_reply_builds_task_and_records(db, monkeypatch):
    monkeypatch.setattr(settings, "chat_media_enabled", True)
    monkeypatch.setattr(storage, "_get_bucket", lambda: _FakeBucket({"sku/product/a.jpg": 1000, "chat/outbox/b.png": 1000}))
    _, c = _acc_conv(db)
    res = reply_conversation(
        c.id,
        ChatReplyIn(media=[{"type": "image", "url": f"https://{HOST}/sku/product/a.jpg?sig"},
                           {"type": "image", "url": f"https://{HOST}/chat/outbox/b.png"}]),
        user={}, db=db,
    )
    t = db.get(Task, res["task_id"])
    assert t.spec["text"] == "" and t.spec["media"] == [
        {"type": "image", "key": "sku/product/a.jpg"}, {"type": "image", "key": "chat/outbox/b.png"}]
    jobs._on_chat_reply_ok(db, t)
    db.commit()
    m = db.query(ChatMessage).filter(ChatMessage.conversation_id == c.id).one()
    assert m.text == "[图片]×2" and m.media == t.spec["media"]
    assert db.get(Conversation, c.id).last_message == "[图片]×2"


def test_product_card_reply_keeps_text_and_card(db, monkeypatch):
    monkeypatch.setattr(settings, "chat_media_enabled", True)
    monkeypatch.setattr(storage, "_get_bucket", lambda: _FakeBucket({"sku/product/a.jpg": 1000}))
    _, c = _acc_conv(db)
    card = {"title": "ThinkPad X1", "grade": "95新", "price": "3999"}
    res = reply_conversation(
        c.id,
        ChatReplyIn(media=[{"type": "image", "url": f"https://{HOST}/sku/product/a.jpg"}],
                    text="ThinkPad X1 95新 ¥3999", card=card),
        user={}, db=db,
    )
    t = db.get(Task, res["task_id"])
    assert t.spec["text"] == "ThinkPad X1 95新 ¥3999" and t.spec["card"] == card
    jobs._on_chat_reply_ok(db, t)
    db.commit()
    # 文字记原文:扫描读回这个气泡按方向+原文认出,不再记一条
    m = db.query(ChatMessage).filter(ChatMessage.conversation_id == c.id).one()
    assert m.text == "ThinkPad X1 95新 ¥3999" and m.card == card and m.media == t.spec["media"]
    out = list_messages(c.id, page=1, size=50, tail=False, user={}, db=db)
    assert out[0].card == card


def test_card_needs_media_and_text_with_media_needs_card():
    with pytest.raises(ValueError):
        ChatReplyIn(text="hi", card={"title": "x"})
    with pytest.raises(ValueError):
        ChatReplyIn(text="hi", media=[{"type": "image", "url": f"https://{HOST}/a.jpg"}])


def test_video_reply_rejected_before_task(db, monkeypatch):
    monkeypatch.setattr(settings, "chat_media_enabled", True)
    _, c = _acc_conv(db)
    with pytest.raises(HTTPException) as e:
        reply_conversation(c.id, ChatReplyIn(media=[{"type": "video", "url": f"https://{HOST}/chat/outbox/v.mp4"}]),
                           user={}, db=db)
    assert e.value.status_code == 400 and "发不了视频" in e.value.detail
    assert db.query(Task).count() == 0


def test_reply_body_needs_text_or_media_but_not_both():
    with pytest.raises(ValueError):
        ChatReplyIn()
    with pytest.raises(ValueError):
        ChatReplyIn(text="hi", media=[{"type": "image", "url": f"https://{HOST}/a.jpg"}])


# ---------------------------------------------------------------- 详情 / 消息 / 贴链接

def test_get_conversation_and_tail_messages(db):
    from datetime import datetime, timedelta

    a, c = _acc_conv(db, item_id="5566778899", listing_sku="SKU-1")
    base = datetime(2026, 10, 25, 8, 0, 0)
    for i in range(5):
        db.add(ChatMessage(conversation_id=c.id, direction="in", text=f"m{i}", dedup_key=f"k{i}",
                           created_at=base + timedelta(minutes=i)))
    db.add(ChatMessage(conversation_id=c.id, direction="out", text="[图片]", dedup_key="km",
                       media=[{"type": "image", "key": "sku/product/a.jpg"}], created_at=base + timedelta(minutes=9)))
    db.commit()
    out = get_conversation(c.id, user={}, db=db)
    assert out.item_url == "https://www.goofish.com/item?id=5566778899" and out.account_nick == "店A"
    rows = list_messages(c.id, page=1, size=3, tail=True, user={}, db=db)
    assert [r.text for r in rows] == ["m3", "m4", "[图片]"]
    assert rows[-1].media[0]["type"] == "image"
    rows = list_messages(c.id, page=1, size=3, tail=False, user={}, db=db)
    assert [r.text for r in rows] == ["m0", "m1", "m2"]


def test_resolve_item_prefers_live(db):
    a, _ = _acc_conv(db)
    _listing(db, a, "SKU-OLD", item_id="998877665544", status=ListingStatus.DELISTED)
    _listing(db, a, "SKU-LIVE", item_id="998877665544")
    res = resolve_item("https://m.goofish.com/item?id=998877665544&spm=x", user={}, db=db)
    assert res["sku"] == "SKU-LIVE"
    with pytest.raises(HTTPException) as ei:
        resolve_item("https://www.goofish.com/item?id=123456789", user={}, db=db)
    assert ei.value.status_code == 404
    with pytest.raises(HTTPException) as ei:
        resolve_item("随便一段字", user={}, db=db)
    assert ei.value.status_code == 400


# ---------------------------------------------------------------- 网页流程

class _FakeT:
    """只模拟发媒体要用的原语:dump 回的消息行数在喂完文件后涨上去。"""

    def __init__(self, rows_after=None, multiple=True):
        self.rows = 2
        self.rows_after = rows_after
        self.multiple = multiple
        self.fed: list[list[str]] = []
        self.cleared = None

    def push_media(self, url):
        return "/tmp/" + url.split("/")[-1].split("?")[0]

    def dump_nodes(self):
        return [{"cls": "message-row--x", "desc": "", "cx": 1, "cy": i, "w": 1, "h": 1, "clickable": False}
                for i in range(self.rows)]

    def set_input_files(self, paths, selector="input[type=file]"):
        got = list(paths) if self.multiple else list(paths[:1])
        self.fed.append(got)
        if self.rows_after is not None:
            self.rows += len(got) if self.rows_after == "grow" else 0
        return len(got)

    def clear_media(self, uris=None):
        self.cleared = list(uris or [])
        return len(self.cleared)

    def screencap(self):
        return b""


@pytest.fixture()
def _fast(monkeypatch):
    monkeypatch.setattr(reply_chat_web.time, "sleep", lambda s: None)
    monkeypatch.setattr(settings, "chat_media_enabled", True)


MEDIA = [{"type": "image", "key": "sku/product/a.jpg"}, {"type": "video", "key": "chat/outbox/v.mp4"}]


def test_send_media_ok_one_by_one_when_input_not_multiple(_fast):
    t = _FakeT(rows_after="grow", multiple=False)
    reply_chat_web._send_media(t, MEDIA, lambda n, b: None)
    assert t.fed == [["/tmp/a.jpg", "/tmp/v.mp4"][:1], ["/tmp/v.mp4"]]
    assert t.cleared == ["/tmp/a.jpg", "/tmp/v.mp4"]


def test_send_media_unverified_does_not_resend(_fast):
    t = _FakeT(rows_after="stay")
    with pytest.raises(reply_chat_web._Fail) as ei:
        reply_chat_web._send_media(t, MEDIA, lambda n, b: None)
    assert ei.value.step == "reply_verify"
    assert len(t.fed) == 1          # 喂一次就停,不重发
    assert t.cleared                # 临时文件照样清


def test_send_media_refuses_when_switch_off(monkeypatch):
    monkeypatch.setattr(settings, "chat_media_enabled", False)
    with pytest.raises(reply_chat_web._Fail) as ei:
        reply_chat_web._send_media(_FakeT(), MEDIA, lambda n, b: None)
    assert ei.value.step == "reply_media"


# ---------------------------------------------------------------- 门铃补扫

def _scan_task(db, acc, status):
    from app.models import TaskStatus  # noqa: F401
    job = jobs.create_chat_scan(db, acc.id, source="SCHED")
    t = db.query(Task).filter(Task.job_id == job.id).one()
    t.status = status
    db.commit()
    return t


def test_hint_during_running_scan_marks_rescan_and_rescans_after(db):
    from app.models import TaskStatus

    a, _ = _acc_conv(db)
    running = _scan_task(db, a, TaskStatus.RUNNING)
    jobs.create_chat_scan(db, a.id, source="HINT")          # 门铃:不新建,记补扫
    assert db.query(Task).filter(Task.task_type == "chat_scan").count() == 1
    assert db.get(Task, running.id).spec.get("rescan") is True
    # 这单跑完(先落 SUCCESS 再记账,和 runner 一样)→ 马上补扫一单
    running.status = TaskStatus.SUCCESS
    running.result = {"conversations": [], "messages": {}}
    db.commit()
    jobs._on_chat_scan_ok(db, running)
    db.commit()
    rows = db.query(Task).filter(Task.task_type == "chat_scan").all()
    assert len(rows) == 2 and {r.source for r in rows} == {"SCHED", "HINT"}


def test_hint_while_scan_pending_needs_no_rescan(db):
    from app.models import TaskStatus

    a, _ = _acc_conv(db)
    pending = _scan_task(db, a, TaskStatus.PENDING)
    jobs.create_chat_scan(db, a.id, source="HINT")
    assert not (db.get(Task, pending.id).spec or {}).get("rescan")


def test_reply_flow_leaves_conversation_afterwards(monkeypatch):
    """回复发完要重开一遍 /im,别让业务标签页停在会话里把买家后来的消息读掉。"""
    calls = []
    monkeypatch.setattr(reply_chat_web, "leave_conversation", lambda t: calls.append("leave"))
    monkeypatch.setattr(reply_chat_web.time, "sleep", lambda s: None)

    class T:
        def launch_app(self, url): calls.append(("launch", url))
        def screen_size(self): return (1200, 900)
        def dump_nodes(self): return []
        def screencap(self): return b""

    monkeypatch.setattr(reply_chat_web, "_ensure_login", lambda t, nodes, h, save: nodes)
    monkeypatch.setattr(reply_chat_web, "_enter_conversation", lambda t, pk, w, h: True)
    monkeypatch.setattr(reply_chat_web, "_fill_text", lambda t, text, save: None)
    monkeypatch.setattr(reply_chat_web, "_send_and_verify", lambda t, text, w, h, save: None)
    res = reply_chat_web.run_reply_chat_web(T(), {"peer_key": "1001", "text": "好的"}, shot_sink=lambda n, b: None)
    assert res["ok"] is True and calls[-1] == "leave"
    # 没找到会话(没进去过)就不用退
    calls.clear()
    monkeypatch.setattr(reply_chat_web, "_enter_conversation", lambda t, pk, w, h: False)
    res = reply_chat_web.run_reply_chat_web(T(), {"peer_key": "1001", "text": "好的"}, shot_sink=lambda n, b: None)
    assert res["ok"] is False and "leave" not in calls


# ---------------------------------------------------------------- 闲鱼不收的图转 jpg


class _FakeBucket:
    def __init__(self, sizes, converted=b"x" * 100):
        self.sizes = sizes
        self.converted = converted
        self.put = {}
        self.processed = []

    def head_object(self, key):
        return type("Head", (), {"content_length": self.sizes[key]})()

    def get_object(self, key, process=None):
        self.processed.append((key, process))
        if isinstance(self.converted, Exception):
            raise self.converted
        return type("Obj", (), {"read": lambda s: self.converted})()

    def put_object(self, key, data):
        self.put[key] = data


def _prepare(monkeypatch, bucket, key):
    monkeypatch.setattr(storage, "_get_bucket", lambda: bucket)
    return chat_media.prepare_images([{"type": "image", "key": key}])[0]["key"]


def test_small_jpg_sent_as_is(monkeypatch):
    b = _FakeBucket({"a/x.jpg": 1000})
    assert _prepare(monkeypatch, b, "a/x.jpg") == "a/x.jpg" and not b.put


def test_big_jpg_and_webp_become_small_jpg(monkeypatch):
    b = _FakeBucket({"a/x.jpg": chat_media.MAX_SEND_BYTES})
    assert _prepare(monkeypatch, b, "a/x.jpg") == "a/x-send.jpg" and "a/x-send.jpg" in b.put
    b = _FakeBucket({})
    assert _prepare(monkeypatch, b, "a/y.webp") == "a/y-send.jpg"
    assert "format,jpg" in b.processed[0][1]
    assert _prepare(monkeypatch, _FakeBucket({}), "a/z.HEIC") == "a/z-send.jpg"


def test_conversion_failure_tells_user(monkeypatch):
    with pytest.raises(ValueError, match="转不了格式"):
        _prepare(monkeypatch, _FakeBucket({}, converted=RuntimeError("oss")), "a/y.heic")
    with pytest.raises(ValueError, match="超过 3MB"):
        _prepare(monkeypatch, _FakeBucket({}, converted=b"x" * chat_media.MAX_SEND_BYTES), "a/y.webp")


# ---------------------------------------------------------------- 发商品:图片 + 文字

def _stub_reply_flow(monkeypatch, calls, fill=None):
    for name, fn in {
        "_flat": lambda n: n,
        "_check_risk": lambda n: None,
        "_ensure_login": lambda t, n, h, s: n,
        "_enter_conversation": lambda t, p, w, h: True,
        "leave_conversation": lambda t: None,
        "_send_media": lambda t, m, s: calls.append("media"),
        "_fill_text": fill or (lambda t, x, s: calls.append("fill:" + x)),
        "_send_and_verify": lambda t, x, w, h, s: calls.append("send"),
    }.items():
        monkeypatch.setattr(reply_chat_web, name, fn)


class _ReplyT:
    def launch_app(self, url): pass
    def screen_size(self): return (1200, 800)
    def dump_nodes(self): return []
    def screencap(self): return b""


def test_flow_sends_media_then_text(monkeypatch, _fast):
    calls: list[str] = []
    _stub_reply_flow(monkeypatch, calls)
    res = reply_chat_web.run_reply_chat_web(_ReplyT(), {"peer_key": "p", "text": "X1 ¥3999", "media": MEDIA})
    assert res["ok"] and calls == ["media", "fill:X1 ¥3999", "send"]


def test_flow_text_failure_after_media_is_unverified_not_retryable(monkeypatch, _fast):
    def boom(t, x, s):
        raise reply_chat_web._Fail("reply_input", "没找到输入框")
    _stub_reply_flow(monkeypatch, [], fill=boom)
    res = reply_chat_web.run_reply_chat_web(_ReplyT(), {"peer_key": "p", "text": "X1", "media": MEDIA})
    assert not res["ok"] and res["failed_step"] == "reply_verify"
    assert "图片已发出" in res["reason"]
