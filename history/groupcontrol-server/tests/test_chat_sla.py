"""消息响应考核：开轮/结束、员工看与回、夜间不计时、推送提醒升级各一次、按人统计。"""
from datetime import datetime, timedelta

from app import chat_sla
from app.models import Account, AccountOwner, ChatMessage, ChatSla, Conversation, Task

# 北京时间 2026-11-09 10:00 = UTC 02:00，白天
DAY = datetime(2026, 11, 9, 2, 0, 0)


def _conv(db, peer="buyer-1"):
    if not db.get(Account, "acc-1"):
        db.add(Account(id="acc-1", nick="土星"))
    conv = Conversation(account_id="acc-1", peer_key=peer, peer_nick="买家甲", item_title="戴尔 U2720Q", last_message="还在吗")
    db.add(conv)
    db.commit()
    return conv


def _msg(db, conv, direction, at):
    db.add(ChatMessage(conversation_id=conv.id, direction=direction, text=f"{direction}{at}", created_at=at, dedup_key=f"{direction}{at}"))
    db.commit()


def _owner(db, sid="s1", name="小王"):
    db.add(AccountOwner(account_id="acc-1", staff_id=sid, staff_name=name))
    db.commit()


def test_effective_seconds_skips_quiet_hours():
    conf = {"quiet_start": 23, "quiet_end": 9}
    # 北京 22:50 → 次日 09:10：只算 22:50-23:00 和 09:00-09:10，共 20 分钟
    start = datetime(2026, 11, 9, 14, 50)   # UTC 14:50 = 北京 22:50
    end = datetime(2026, 11, 10, 1, 10)     # UTC 01:10 = 北京 09:10
    assert chat_sla.effective_seconds(start, end, conf) == 20 * 60
    assert chat_sla.in_quiet(datetime(2026, 11, 9, 16, 0), conf)          # 北京 00:00
    assert not chat_sla.in_quiet(DAY, conf)


def test_cycle_opens_on_buyer_message_and_closes_on_our_reply(db_session):
    db = db_session
    conv = _conv(db)
    _msg(db, conv, "in", DAY)
    chat_sla.track_after_scan(db, [conv], DAY)
    db.commit()
    cycle = chat_sla.open_cycle(db, conv.id)
    assert cycle and cycle.await_since == DAY
    chat_sla.track_after_scan(db, [conv], DAY)  # 没回之前不重复开
    db.commit()
    assert db.query(ChatSla).count() == 1
    # 在闲鱼端直接回：扫描读到我们这边的新消息
    _msg(db, conv, "out", DAY + timedelta(minutes=3))
    chat_sla.track_after_scan(db, [conv], DAY + timedelta(minutes=4))
    db.commit()
    db.refresh(cycle)
    assert cycle.closed_at and cycle.replied_via == "XIANYU" and cycle.replied_by is None


def test_old_buyer_message_does_not_open_cycle(db_session):
    db = db_session
    conv = _conv(db)
    _msg(db, conv, "in", DAY - timedelta(days=3))  # 上线前就没回的老会话
    chat_sla.track_after_scan(db, [conv], DAY)
    db.commit()
    assert db.query(ChatSla).count() == 0
    _msg(db, conv, "in", DAY + timedelta(minutes=1))  # 买家又发了一条
    chat_sla.track_after_scan(db, [conv], DAY + timedelta(minutes=1))
    db.commit()
    assert db.query(ChatSla).count() == 1


def test_staff_read_and_app_reply_are_recorded(db_session):
    db = db_session
    conv = _conv(db)
    _msg(db, conv, "in", DAY)
    chat_sla.track_after_scan(db, [conv], DAY)
    chat_sla.on_staff_read(db, conv.id, "s1", "小王", DAY + timedelta(minutes=1))
    chat_sla.on_staff_reply(db, conv.id, "s1", "小王", DAY + timedelta(minutes=2))
    db.commit()
    c = db.query(ChatSla).one()
    assert (c.read_by_name, c.replied_by_name, c.replied_via) == ("小王", "小王", "APP")
    assert c.closed_at == DAY + timedelta(minutes=2)


def test_auto_reply_does_not_close_cycle(db_session):
    from app.jobs import _on_chat_reply_ok
    db = db_session
    conv = _conv(db)
    _msg(db, conv, "in", DAY)
    chat_sla.track_after_scan(db, [conv], DAY)
    db.commit()
    task = Task(id="t1", job_id="j1", account_id="acc-1", task_type="chat_reply", status="SUCCESS", source="AUTO",
                spec={"conversation_id": conv.id, "text": "收到，稍后回复"})
    _on_chat_reply_ok(db, task)
    db.commit()
    assert chat_sla.open_cycle(db, conv.id) is not None
    task2 = Task(id="t2", job_id="j2", account_id="acc-1", task_type="chat_reply", status="SUCCESS", source="MANUAL",
                 spec={"conversation_id": conv.id, "text": "在的", "by_id": "s1", "by_name": "小王"})
    _on_chat_reply_ok(db, task2)
    db.commit()
    assert chat_sla.open_cycle(db, conv.id) is None
    assert db.query(ChatSla).one().replied_by == "s1"


def test_pass_notifies_reminds_escalates_once(db_session):
    db = db_session
    conv = _conv(db)
    _owner(db)
    _msg(db, conv, "in", DAY)
    chat_sla.track_after_scan(db, [conv], DAY)
    db.commit()
    sent = []
    note = lambda p: sent.append(p) or (True, "ok")  # noqa: E731
    chat_sla.run_pass(db, DAY + timedelta(seconds=30), note)
    assert [p.get("staff_ids") for p in sent] == [["s1"]] and "闲鱼新消息" in sent[0]["title"]
    assert "id=" + conv.id in sent[0]["url"]
    chat_sla.run_pass(db, DAY + timedelta(minutes=1), note)
    assert len(sent) == 1
    chat_sla.run_pass(db, DAY + timedelta(minutes=6), note)   # 5 分钟没看 → 提醒负责人
    assert "没人看" in sent[1]["title"] and sent[1]["staff_ids"] == ["s1"]
    chat_sla.run_pass(db, DAY + timedelta(minutes=16), note)  # 15 分钟没回 → 管理员
    assert sent[2].get("admins") is True and "小王" in sent[2]["body"]
    chat_sla.run_pass(db, DAY + timedelta(minutes=30), note)
    assert len(sent) == 3


def test_read_in_time_skips_reminder_and_quiet_hours_send_nothing(db_session):
    db = db_session
    conv = _conv(db)
    _owner(db)
    night = datetime(2026, 11, 9, 16, 0)  # 北京 00:00
    _msg(db, conv, "in", night)
    chat_sla.track_after_scan(db, [conv], night)
    db.commit()
    sent = []
    note = lambda p: sent.append(p) or (True, "ok")  # noqa: E731
    chat_sla.run_pass(db, night + timedelta(hours=2), note)
    assert sent == []  # 夜里不推不提醒
    morning = datetime(2026, 11, 10, 1, 1)  # 北京 09:01
    chat_sla.run_pass(db, morning, note)
    assert len(sent) == 1  # 早上补推新消息，计时才 1 分钟
    chat_sla.on_staff_read(db, conv.id, "s1", "小王", morning + timedelta(minutes=1))
    db.commit()
    chat_sla.run_pass(db, morning + timedelta(minutes=8), note)
    assert len(sent) == 1  # 看过了不提醒


def test_no_owner_only_escalates_to_admin(db_session):
    db = db_session
    conv = _conv(db)
    _msg(db, conv, "in", DAY)
    chat_sla.track_after_scan(db, [conv], DAY)
    db.commit()
    sent = []
    chat_sla.run_pass(db, DAY + timedelta(minutes=20), lambda p: sent.append(p) or (True, "ok"))
    assert len(sent) == 1 and sent[0]["admins"] and "还没指定负责人" in sent[0]["body"]


def test_stats_per_owner(db_session):
    db = db_session
    _owner(db)
    for i, (read_m, reply_m) in enumerate([(1, 2), (8, 20)]):
        conv = _conv(db, peer=f"b{i}")
        t0 = DAY + timedelta(hours=i)
        _msg(db, conv, "in", t0)
        chat_sla.track_after_scan(db, [conv], t0)
        chat_sla.on_staff_read(db, conv.id, "s1", "小王", t0 + timedelta(minutes=read_m))
        chat_sla.on_staff_reply(db, conv.id, "s1", "小王", t0 + timedelta(minutes=reply_m))
    db.commit()
    for c in db.query(ChatSla).all():
        if c.read_at - c.await_since > timedelta(minutes=5):
            c.reminded_at = c.await_since + timedelta(minutes=5)
    db.commit()
    out = chat_sla.staff_stats(db, DAY - timedelta(hours=1), DAY + timedelta(days=1))
    row = out["items"][0]
    assert (row["name"], row["cycles"], row["replied"], row["late_read"]) == ("小王", 2, 2, 1)
    assert row["avg_reply_sec"] == 11 * 60
