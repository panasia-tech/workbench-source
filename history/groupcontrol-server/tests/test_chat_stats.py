"""当日消息回复率(M1 销售看板)。

口径错了看板就会骗人,而且是往好看的方向骗——这比数字不好看危险得多。
所以把几个容易搞错的地方都钉住:按会话不按条、in 之前的 out 不算回复、
没有来信时不能显示 0%。
"""
from datetime import datetime, timedelta, timezone

from app import chat_stats
from app.models import Account, ChatMessage, Conversation

CN = timezone(timedelta(hours=8))


def _conv(db, account_id="acc-1", peer="b1"):
    c = Conversation(account_id=account_id, peer_key=peer)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _msg(db, conv, direction, text, at):
    db.add(ChatMessage(conversation_id=conv.id, direction=direction, text=text,
                       msg_at=at, created_at=at, dedup_key=f"{direction}:{text}:{at}"))
    db.commit()


def test_counts_by_conversation_not_by_message(db_session):
    """买家连发三条、销售回一条,是一次完整接待,不该算成 1/3。"""
    now = datetime.utcnow()
    c = _conv(db_session)
    for i in range(3):
        _msg(db_session, c, "in", f"问题{i}", now - timedelta(minutes=10 - i))
    _msg(db_session, c, "out", "统一答复", now - timedelta(minutes=5))

    r = chat_stats.reply_rate(db_session, now=now)
    assert r["incoming"] == 1 and r["replied"] == 1
    assert r["rate"] == 1.0


def test_outbound_before_inbound_is_not_a_reply(db_session):
    """销售先开场、买家随后提问且没人再回——这不算已回复。"""
    now = datetime.utcnow()
    c = _conv(db_session)
    _msg(db_session, c, "out", "在的哦", now - timedelta(minutes=20))
    _msg(db_session, c, "in", "多少钱", now - timedelta(minutes=10))

    r = chat_stats.reply_rate(db_session, now=now)
    assert r["incoming"] == 1
    assert r["replied"] == 0, "in 之前的 out 不能算作对这条 in 的回复"
    assert r["pending"] == 1
    assert r["rate"] == 0.0


def test_no_incoming_reports_full_rate_not_zero(db_session):
    """今天没人来问 ≠ 回复率 0%。分母为 0 时显示 0% 会让人以为出了事。"""
    _conv(db_session)
    r = chat_stats.reply_rate(db_session)
    assert r["incoming"] == 0
    assert r["rate"] == 1.0


def test_mixed_conversations(db_session):
    now = datetime.utcnow()
    answered = _conv(db_session, peer="b1")
    waiting = _conv(db_session, peer="b2")
    _msg(db_session, answered, "in", "在吗", now - timedelta(minutes=30))
    _msg(db_session, answered, "out", "在", now - timedelta(minutes=29))
    _msg(db_session, waiting, "in", "还有货吗", now - timedelta(minutes=5))

    r = chat_stats.reply_rate(db_session, now=now)
    assert (r["incoming"], r["replied"], r["pending"]) == (2, 1, 1)
    assert r["rate"] == 0.5


def test_scoped_to_one_account(db_session):
    now = datetime.utcnow()
    a = _conv(db_session, "acc-1", "b1")
    b = _conv(db_session, "acc-2", "b2")
    _msg(db_session, a, "in", "在吗", now - timedelta(minutes=5))
    _msg(db_session, b, "in", "在吗", now - timedelta(minutes=5))
    _msg(db_session, b, "out", "在", now - timedelta(minutes=4))

    assert chat_stats.reply_rate(db_session, "acc-1", now)["rate"] == 0.0
    assert chat_stats.reply_rate(db_session, "acc-2", now)["rate"] == 1.0
    # 不传 account_id = 全账号聚合
    assert chat_stats.reply_rate(db_session, now=now)["incoming"] == 2


def test_yesterday_is_excluded(db_session):
    """日界用中国时区:昨天的会话不该算进今天。"""
    now = datetime.utcnow()
    c = _conv(db_session)
    _msg(db_session, c, "in", "昨天的消息", now - timedelta(days=2))

    r = chat_stats.reply_rate(db_session, now=now)
    assert r["incoming"] == 0, "两天前的消息不该进今日统计"


def test_by_account_lists_worst_first(db_session):
    """聚合台左栏:待回最多的排最前,销售一眼看到该先处理谁。"""
    now = datetime.utcnow()
    db_session.add(Account(id="acc-1", nick="甲号"))
    db_session.add(Account(id="acc-2", nick="乙号"))
    db_session.commit()

    a = _conv(db_session, "acc-1", "b1")
    _msg(db_session, a, "in", "在吗", now - timedelta(minutes=5))
    for i, peer in enumerate(("b2", "b3")):
        c = _conv(db_session, "acc-2", peer)
        _msg(db_session, c, "in", f"问{i}", now - timedelta(minutes=5))

    rows = chat_stats.reply_rate_by_account(db_session, now=now)
    assert [r["account_id"] for r in rows] == ["acc-2", "acc-1"]
    assert rows[0]["account_nick"] == "乙号"
    assert rows[0]["pending"] == 2


def test_cn_day_boundary(db_session):
    """中国日界 = UTC+8 的 00:00,换算回 naive UTC 是前一天 16:00。"""
    # 北京时间 2026-09-13 00:30 → UTC 2026-09-12 16:30
    now = datetime(2026, 9, 12, 16, 30)
    lo, hi = chat_stats.cn_today_utc_range(now)
    assert lo == datetime(2026, 9, 12, 16, 0)
    assert hi == datetime(2026, 9, 13, 16, 0)
    assert lo.replace(tzinfo=timezone.utc).astimezone(CN).strftime("%Y-%m-%d") == "2026-09-13"
