"""Server酱推送(1c):notify 发送 + maybe_notify_new_messages 聚合/冷却 + jobs 接线。"""

import json
from datetime import datetime, timedelta

import pytest

from app import jobs, notify
from app.config import settings
from app.models import Account, NotifyState, Task, TaskStatus


@pytest.fixture()
def sendkey(monkeypatch):
    """配上 sendkey(否则整个推送链是 no-op),用例结束自动还原。"""
    monkeypatch.setattr(settings, "serverchan_sendkey", "TESTKEY")
    return "TESTKEY"


def _ok_poster(calls):
    def poster(url, fields):
        calls.append((url, fields))
        return {"code": 0}
    return poster


def test_notify_noop_without_sendkey():
    assert notify.notify("t", "d", poster=_ok_poster([])) is False


def test_notify_success_and_fail(sendkey):
    calls = []
    assert notify.notify("新买家消息", "x", poster=_ok_poster(calls)) is True
    url, fields = calls[0]
    assert url == "https://sctapi.ftqq.com/TESTKEY.send"
    assert fields == {"title": "新买家消息", "desp": "x"}
    assert notify.notify("t", "d", poster=lambda u, f: {"code": 1}) is False
    assert notify.notify("t", "d", poster=lambda u, f: 1 / 0) is False  # 异常只记日志不抛


def test_maybe_notify_disabled_without_sendkey(db):
    assert notify.maybe_notify_new_messages(db, 3) is False
    # 未配置 sendkey 时也要累计 pending,配上之后能一并发出
    assert db.get(NotifyState, notify.K_PENDING).value == "3"


def test_maybe_notify_sends_and_resets(db, sendkey):
    calls = []
    ok = notify.maybe_notify_new_messages(db, 5, now=datetime(2026, 7, 28, 10, 0, 0),
                                          poster=_ok_poster(calls))
    assert ok is True
    assert calls[0][1]["desp"] == "自上次提醒新增 5 条,请进小程序处理"
    assert db.get(NotifyState, notify.K_PENDING).value == "0"
    assert db.get(NotifyState, notify.K_LAST_NOTIFIED).value == "2026-07-28T10:00:00"


def test_cooldown_accumulates_then_flushes(db, sendkey):
    calls = []
    t0 = datetime(2026, 7, 28, 10, 0, 0)
    assert notify.maybe_notify_new_messages(db, 2, now=t0, poster=_ok_poster(calls)) is True
    # 冷却窗内:累计但不再发
    assert notify.maybe_notify_new_messages(db, 3, now=t0 + timedelta(seconds=60),
                                            poster=_ok_poster(calls)) is False
    assert len(calls) == 1
    assert db.get(NotifyState, notify.K_PENDING).value == "3"
    # 过窗:把窗内累计的一起发出去
    assert notify.maybe_notify_new_messages(db, 1, now=t0 + timedelta(seconds=301),
                                            poster=_ok_poster(calls)) is True
    assert calls[1][1]["desp"] == "自上次提醒新增 4 条,请进小程序处理"
    assert db.get(NotifyState, notify.K_PENDING).value == "0"


def test_send_failure_keeps_pending(db, sendkey):
    bad = lambda u, f: {"code": 500}
    t0 = datetime(2026, 7, 28, 10, 0, 0)
    assert notify.maybe_notify_new_messages(db, 4, now=t0, poster=bad) is False
    assert db.get(NotifyState, notify.K_PENDING).value == "4"
    # 失败后不影响下个窗口重试(无 last_notified,下一笔直接触发)
    calls = []
    assert notify.maybe_notify_new_messages(db, 1, now=t0 + timedelta(seconds=10),
                                            poster=_ok_poster(calls)) is True
    assert calls[0][1]["desp"] == "自上次提醒新增 5 条,请进小程序处理"


# ==================== 企微直发通道 ====================


@pytest.fixture()
def wecom(monkeypatch):
    """配上企微三要素并清空 token 缓存,用例结束自动还原。"""
    monkeypatch.setattr(settings, "wecom_corpid", "ww123")
    monkeypatch.setattr(settings, "wecom_corpsecret", "sec")
    monkeypatch.setattr(settings, "wecom_agentid", "1000002")
    notify._token_cache.update(token=None, expires_at=0.0)
    yield
    notify._token_cache.update(token=None, expires_at=0.0)


def _token_getter(calls):
    def getter(url):
        calls.append(url)
        return {"access_token": "DEMO_ONLY_REDACTED", "expires_in": 7200}
    return getter


def test_wecom_noop_without_config():
    assert notify.notify_wecom("t", "d", getter=_token_getter([]),
                               poster=lambda u, p: {"errcode": 0}) is False


def test_wecom_success_and_token_cache(wecom):
    gets, posts = [], []
    poster = lambda u, p: posts.append((u, p)) or {"errcode": 0}
    assert notify.notify_wecom("新买家消息", "3 条", getter=_token_getter(gets), poster=poster) is True
    assert notify.notify_wecom("t2", "d2", getter=_token_getter(gets), poster=poster) is True
    assert len(gets) == 1  # 第二次命中进程内 token 缓存,不再 gettoken
    url, payload = posts[0]
    assert url == "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=TOK"
    assert payload["touser"] == "@all" and payload["msgtype"] == "text"
    assert payload["agentid"] == 1000002
    assert payload["text"]["content"] == "新买家消息\n\n3 条"


def test_wecom_send_fail_and_token_invalidate(wecom):
    gets = []
    assert notify.notify_wecom("t", "d", getter=_token_getter(gets),
                               poster=lambda u, p: {"errcode": 40014}) is False
    assert notify._token_cache["token"] is None  # 40014 → 清缓存,下次重新 gettoken
    assert notify.notify_wecom("t", "d", getter=_token_getter(gets),
                               poster=lambda u, p: {"errcode": 60020}) is False
    assert len(gets) == 2  # 60020 不清缓存(是可信IP问题,token 本身有效)…但上一步已清,故重取
    # 异常不抛:poster 抛(此时命中缓存,不走 getter)
    assert notify.notify_wecom("t", "d", getter=_token_getter(gets),
                               poster=lambda u, p: 1 / 0) is False
    # 缓存清空后 getter 抛同样不抛
    notify._token_cache.update(token=None, expires_at=0.0)
    assert notify.notify_wecom("t", "d", getter=lambda u: 1 / 0,
                               poster=lambda u, p: {"errcode": 0}) is False


def test_send_prefers_wecom_then_fallback(db, wecom, sendkey, monkeypatch):
    calls = []
    monkeypatch.setattr(notify, "notify_wecom", lambda t, d: calls.append(("wecom", t)) or True)
    assert notify._send("t", "d", poster=_ok_poster(calls)) is True
    assert calls == [("wecom", "t")]  # 企微成功,不触 Server酱
    monkeypatch.setattr(notify, "notify_wecom", lambda t, d: False)
    assert notify._send("t", "d", poster=_ok_poster(calls)) is True
    assert calls[-1][0].startswith("https://sctapi.ftqq.com/")  # 回退 Server酱


def test_chat_scan_ok_counts_only_new_inbound(db, monkeypatch):
    calls = []
    monkeypatch.setattr(jobs, "maybe_notify_new_messages",
                        lambda db_, n, details=None: calls.append(n))
    a = Account(nick="a")
    db.add(a)
    db.flush()
    convs = [{"peer_key": "t***7", "peer_nick": "t***7"}]
    msgs = {"t***7": [{"direction": "in", "text": "在吗", "msg_at": None},
                       {"direction": "out", "text": "在的", "msg_at": None},
                       {"direction": "in", "text": "在吗", "msg_at": None}]}  # 批内重复,只插一条
    t = Task(task_type="chat_scan", account_id=a.id, status=TaskStatus.SUCCESS,
             result={"ok": True, "conversations": convs, "messages": msgs})
    db.add(t)
    db.commit()
    jobs._on_chat_scan_ok(db, t)
    assert calls[-1] == 1  # 2 条同文 inbound 去重后只算 1 条新增
    db.commit()  # 生产上 on_task_result 在回调后 commit;重放前需落盘
    jobs._on_chat_scan_ok(db, t)  # 幂等重放:无新增
    assert calls[-1] == 0


# ==================== 明细通知(2026-10-09:按会话出明细) ====================

_D1 = {"account": "南方举重雪白海胆", "buyer": "南极拍Vlog的蓝足海鸟",
       "title": "泰坦军团 P2710S", "price": "1588.00", "text": "260出吗"}
_D2 = {"account": "洞穴Q弹的荆芥", "buyer": "春婵l",
       "title": None, "price": None, "text": "在吗,还在吗"}


def test_details_render_into_desp(db, sendkey):
    calls = []
    t0 = datetime(2026, 7, 28, 10, 0, 0)
    ok = notify.maybe_notify_new_messages(db, 1, details=[_D1], now=t0,
                                          poster=_ok_poster(calls))
    assert ok is True
    assert calls[0][1]["title"] == "新买家消息 1个会话待处理"
    assert calls[0][1]["desp"] == (
        "新买家消息(1 个会话):\n"
        "1. 「南方举重雪白海胆」买家 南极拍Vlog的蓝足海鸟 "
        "咨询「泰坦军团 P2710S」¥1588.00:\"260出吗\""
    )
    # flush 后明细清零(同 pending 一起)
    assert db.get(NotifyState, notify.K_PENDING_DETAILS).value == "[]"


def test_details_line_skips_missing_segments(db, sendkey):
    """无标题/价格:跳过商品段和 ¥ 段,只留账号+买家+引用。"""
    calls = []
    ok = notify.maybe_notify_new_messages(db, 1, details=[_D2], now=datetime(2026, 7, 28, 10),
                                          poster=_ok_poster(calls))
    assert ok is True
    assert calls[0][1]["desp"] == '新买家消息(1 个会话):\n1. 「洞穴Q弹的荆芥」买家 春婵l:"在吗,还在吗"'


def test_details_accumulate_across_cooldown(db, sendkey):
    calls = []
    t0 = datetime(2026, 7, 28, 10, 0, 0)
    # 预置上次推送时间:头两笔都落在冷却窗内,只攒不发
    notify._set(db, notify.K_LAST_NOTIFIED, t0.isoformat())
    assert notify.maybe_notify_new_messages(db, 1, details=[_D1], now=t0 + timedelta(seconds=30),
                                            poster=_ok_poster(calls)) is False
    assert notify.maybe_notify_new_messages(db, 1, details=[_D2], now=t0 + timedelta(seconds=60),
                                            poster=_ok_poster(calls)) is False
    assert len(calls) == 0
    assert json.loads(db.get(NotifyState, notify.K_PENDING_DETAILS).value) == [_D1, _D2]
    # 过窗 flush:两条明细一起发
    assert notify.maybe_notify_new_messages(db, 0, now=t0 + timedelta(seconds=301),
                                            poster=_ok_poster(calls)) is True
    assert len(calls) == 1
    assert calls[0][1]["title"] == "新买家消息 2个会话待处理"
    assert "新买家消息(2 个会话):" in calls[0][1]["desp"]
    assert "1. 「南方举重雪白海胆」" in calls[0][1]["desp"]
    assert "2. 「洞穴Q弹的荆芥」" in calls[0][1]["desp"]


def test_details_capped_with_overflow_note(db, sendkey):
    calls = []
    many = [dict(_D2, buyer=f"买家{i}") for i in range(15)]
    ok = notify.maybe_notify_new_messages(db, 15, details=many, now=datetime(2026, 7, 28, 10),
                                          poster=_ok_poster(calls))
    assert ok is True
    desp = calls[0][1]["desp"]
    assert notify.MAX_DETAIL_LINES == 12
    assert desp.count("」买家 ") == 12          # 只出 12 行明细
    assert "等 3 个会话" in desp                # 超出的会话数收口


def test_send_failure_keeps_details(db, sendkey):
    bad = lambda u, f: {"code": 500}
    t0 = datetime(2026, 7, 28, 10, 0, 0)
    assert notify.maybe_notify_new_messages(db, 1, details=[_D1], now=t0, poster=bad) is False
    assert json.loads(db.get(NotifyState, notify.K_PENDING_DETAILS).value) == [_D1]
    # 下个窗口重试成功:攒下的明细仍在 desp 里
    calls = []
    assert notify.maybe_notify_new_messages(db, 0, now=t0 + timedelta(seconds=10),
                                            poster=_ok_poster(calls)) is True
    assert "南方举重雪白海胆" in calls[0][1]["desp"]


def test_chat_scan_ok_passes_details(db, monkeypatch):
    """jobs 接线:明细带账号 nick/买家/标题/价格,引用文本取本轮最新一条 in。"""
    got = {}

    def fake(db_, n, details=None):
        got["n"], got["details"] = n, details

    monkeypatch.setattr(jobs, "maybe_notify_new_messages", fake)
    a = Account(nick="南方举重雪白海胆")
    db.add(a)
    db.flush()
    convs = [{"peer_key": "t***7", "peer_nick": "南极拍Vlog的蓝足海鸟",
              "item_title": "泰坦军团 P2710S", "item_price": "1588.00"},
             {"peer_key": "t***9", "peer_nick": "春婵l",
              "item_title": None, "item_price": None}]
    msgs = {"t***7": [{"direction": "in", "text": "260出吗", "msg_at": None},
                      {"direction": "out", "text": "不刀", "msg_at": None},
                      {"direction": "in", "text": "包邮吗", "msg_at": None}],
            "t***9": [{"direction": "out", "text": "在的", "msg_at": None}]}  # 无新 in
    t = Task(task_type="chat_scan", account_id=a.id, status=TaskStatus.SUCCESS,
             result={"ok": True, "conversations": convs, "messages": msgs})
    db.add(t)
    db.commit()
    jobs._on_chat_scan_ok(db, t)
    assert got["n"] == 2                        # 两条新 in(去重后新插入的)
    assert len(got["details"]) == 1             # t***9 无新 in,不出明细
    d = got["details"][0]
    assert d["account"] == "南方举重雪白海胆"      # 账号 nick,不是 id
    assert d["buyer"] == "南极拍Vlog的蓝足海鸟"
    assert d["title"] == "泰坦军团 P2710S" and d["price"] == "1588.00"
    assert d["text"] == "包邮吗"                 # 本轮最新一条 in(out 不算)


def test_chat_scan_details_fallback_and_truncation(db, monkeypatch):
    """账号无 nick 用 id 前 8 位;买家/标题缺省回退;长文本截 40 字;换行拍平。"""
    got = {}
    monkeypatch.setattr(jobs, "maybe_notify_new_messages",
                        lambda db_, n, details=None: got.update(details=details))
    a = Account(nick="")                        # 空昵称 → 走 id 兜底
    db.add(a)
    db.flush()
    long_text = "第一行\n第二行" + "很" * 50
    convs = [{"peer_key": "k***1", "peer_nick": None,
              "item_title": "", "item_price": None}]
    msgs = {"k***1": [{"direction": "in", "text": long_text, "msg_at": None}]}
    t = Task(task_type="chat_scan", account_id=a.id, status=TaskStatus.SUCCESS,
             result={"ok": True, "conversations": convs, "messages": msgs})
    db.add(t)
    db.commit()
    jobs._on_chat_scan_ok(db, t)
    d = got["details"][0]
    assert d["account"] == a.id[:8]
    assert d["buyer"] == "k***1"                # 无 nick 回退 peer_key
    assert d["title"] is None and d["price"] is None
    assert "\n" not in d["text"] and len(d["text"]) == 40


# ==================== 现场截图:image 消息 / 签名直链降级(2026-10-10) ====================


def _recording_uploader(calls, body=None):
    def uploader(url, field, filename, blob):
        calls.append((url, field, filename, blob))
        return body if body is not None else {"media_id": "MEDIA1"}
    return uploader


def test_wecom_image_upload_and_send(wecom):
    """① 图上传拿 media_id → message/send 发 image,两处带上同一个 token。"""
    ups, posts = [], []
    poster = lambda u, p: posts.append((u, p)) or {"errcode": 0}
    ok = notify.notify_wecom_image(b"\xff\xd8jpeg", getter=_token_getter([]),
                                   uploader=_recording_uploader(ups), poster=poster)
    assert ok is True
    url, field, filename, blob = ups[0]
    assert "media/upload?access_token=TOK&type=image" in url
    assert field == "media" and filename == "risk.jpg" and blob == b"\xff\xd8jpeg"
    send_url, payload = posts[0]
    assert send_url == "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=TOK"
    assert payload["msgtype"] == "image" and payload["agentid"] == 1000002
    assert payload["image"] == {"media_id": "MEDIA1"}


def test_wecom_image_failures_no_raise(wecom):
    """② 上传失败/发送 errcode!=0 → 返回 False 不抛;upload 阶段 token 失效也清缓存。"""
    posts = []
    poster = lambda u, p: posts.append(u) or {"errcode": 0}
    # 上传返回没有 media_id → False,且不再发 message/send
    up = _recording_uploader([], body={"errcode": 40018, "errmsg": "invalid media"})
    assert notify.notify_wecom_image(b"x", getter=_token_getter([]),
                                     uploader=up, poster=poster) is False
    assert posts == []
    # upload 阶段 40014 → 清缓存(与 notify_wecom 的 message/send 阶段一致)
    assert notify.notify_wecom_image(b"x", getter=_token_getter([]),
                                     uploader=_recording_uploader([], {"errcode": 40014}),
                                     poster=poster) is False
    assert notify._token_cache["token"] is None
    # uploader 抛异常 → False 不抛
    def boom(*a):
        raise RuntimeError("net down")
    assert notify.notify_wecom_image(b"x", getter=_token_getter([]),
                                     uploader=boom, poster=poster) is False
    # message/send errcode!=0 → False
    assert notify.notify_wecom_image(b"x", getter=_token_getter([]),
                                     uploader=_recording_uploader([]),
                                     poster=lambda u, p: {"errcode": 40050}) is False


def test_alert_with_shot_wecom_sends_image(wecom, monkeypatch):
    """企微在配:文本走企微(不带链接),截图字节经 image 消息补发。"""
    texts, images = [], []
    monkeypatch.setattr(notify, "notify_wecom", lambda t, d: texts.append((t, d)) or True)
    monkeypatch.setattr(notify, "notify_wecom_image", lambda b, **kw: images.append(b) or True)
    monkeypatch.setattr(notify.storage, "load_blob", lambda key: b"\xff\xd8jpeg-bytes")
    ok = notify.send_alert_with_shot("闲鱼账号要人工处理", "body", shot_key="oss-shots/a.jpg")
    assert ok is True
    assert texts == [("闲鱼账号要人工处理", "body")]
    assert images == [b"\xff\xd8jpeg-bytes"]


def test_alert_with_shot_serverchan_gets_signed_link(sendkey, monkeypatch):
    """③ 企微未配置(走 Server酱)发不了图:shot_key 的 24h 签名直链拼进文本,让人有链接可点。"""
    calls = []
    monkeypatch.setattr(notify.storage, "load_blob", lambda key: None)
    monkeypatch.setattr(notify.storage, "signed_url",
                        lambda key, expires=1800, width=None: f"https://oss.example/{key}?e={expires}")
    ok = notify.send_alert_with_shot("闲鱼账号要人工处理", "账号「x」命中风控",
                                     shot_key="oss-shots/a.jpg", poster=_ok_poster(calls))
    assert ok is True
    fields = calls[0][1]
    assert fields["title"] == "闲鱼账号要人工处理"
    assert "命中风控" in fields["desp"]
    assert "oss-shots/a.jpg?e=86400" in fields["desp"], "Server酱通道降级为 24h 签名直链"


def test_alert_with_shot_falls_back_to_replay_last_shot(wecom, monkeypatch):
    """shot 没有 → 任务的 actions 留痕里取最后一步带截图的,下载下来发。"""
    images = []
    monkeypatch.setattr(notify, "notify_wecom", lambda t, d: True)
    monkeypatch.setattr(notify, "notify_wecom_image", lambda b, **kw: images.append(b) or True)
    monkeypatch.setattr(notify, "build_replay",
                        lambda task: {"steps": [{"shot_url": None},
                                                {"shot_url": "https://oss/1.png"},
                                                {"shot_url": "https://oss/2.png"}]})
    monkeypatch.setattr(notify, "_download", lambda url: b"img:" + url.encode())
    task = type("T", (), {"id": 7, "result": {"trace_key": "oss-actions/7.json"}})()
    ok = notify.send_alert_with_shot("闲鱼账号要人工处理", "body", shot_key=None, task=task)
    assert ok is True
    assert images == [b"img:https://oss/2.png"], "要取最后一步的截图"


def test_alert_with_shot_replay_failure_still_sends_text(wecom, monkeypatch):
    """留痕读不出来也只记日志:文本照发,不补图、不炸。"""
    texts, images = [], []
    monkeypatch.setattr(notify, "notify_wecom", lambda t, d: texts.append(d) or True)
    monkeypatch.setattr(notify, "notify_wecom_image", lambda b, **kw: images.append(b) or True)
    monkeypatch.setattr(notify, "build_replay", lambda task: 1 / 0)
    task = type("T", (), {"id": 7, "result": {"trace_key": "oss-actions/7.json"}})()
    ok = notify.send_alert_with_shot("闲鱼账号要人工处理", "body", task=task)
    assert ok is True and texts == ["body"] and images == []


def test_alert_with_shot_no_image_text_still_sent(sendkey, monkeypatch):
    """④ 没图可发(shot 空、任务无留痕):文本照发、不炸、不拼链接。"""
    calls = []
    monkeypatch.setattr(notify.storage, "signed_url", lambda *a, **k: None)
    ok = notify.send_alert_with_shot("闲鱼账号要人工处理", "body", poster=_ok_poster(calls))
    assert ok is True
    assert calls[0][1]["desp"] == "body"
