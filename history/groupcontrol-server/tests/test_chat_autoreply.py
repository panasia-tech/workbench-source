"""50 秒未回复自动兜底(M1)。

这块的失败模式都很安静,所以逐条钉死:
  - 判定放宽 → 买家收到一串重复兜底话术(最脏的一种,对外可见);
  - 判定收紧 → 回复率掉了却没人知道;
  - 重复建单 → 同上,且把派发队列塞满。
"""
from datetime import datetime, timedelta

from app import chat_autoreply
from app.models import ChatMessage, Conversation, Task, TaskStatus


def _conv(db, account_id="acc-1", peer="buyer-1", last_at=None):
    conv = Conversation(account_id=account_id, peer_key=peer, peer_nick="买家",
                        last_message_at=last_at, last_message="在吗")
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def _msg(db, conv, direction, text, at, dedup=None):
    m = ChatMessage(conversation_id=conv.id, direction=direction, text=text,
                    msg_at=at, created_at=at, dedup_key=dedup or f"{direction}:{text}:{at}")
    db.add(m)
    db.commit()
    return m


def test_overdue_when_buyer_waited_past_threshold(db_session):
    now = datetime.utcnow()
    old = now - timedelta(seconds=90)
    conv = _conv(db_session, last_at=old)
    _msg(db_session, conv, "in", "在吗", old)

    assert [c.id for c in chat_autoreply.overdue_conversations(db_session, now, 50)] == [conv.id]


def test_not_overdue_before_threshold(db_session):
    now = datetime.utcnow()
    recent = now - timedelta(seconds=20)
    conv = _conv(db_session, last_at=recent)
    _msg(db_session, conv, "in", "在吗", recent)

    assert chat_autoreply.overdue_conversations(db_session, now, 50) == []


def test_not_overdue_when_last_message_is_ours(db_session):
    """销售已经回过了:最后一条是 out,不欠回复。"""
    now = datetime.utcnow()
    conv = _conv(db_session, last_at=now - timedelta(seconds=60))
    _msg(db_session, conv, "in", "在吗", now - timedelta(seconds=120))
    _msg(db_session, conv, "out", "在的", now - timedelta(seconds=60))

    assert chat_autoreply.overdue_conversations(db_session, now, 50) == []


def test_open_reply_task_blocks_second_queue(db_session):
    """已有在途 chat_reply 时不再建单——否则买家会收到一串重复兜底。"""
    now = datetime.utcnow()
    old = now - timedelta(seconds=90)
    conv = _conv(db_session, last_at=old)
    _msg(db_session, conv, "in", "在吗", old)

    for state in (TaskStatus.PENDING, TaskStatus.DISPATCHED, TaskStatus.RUNNING):
        db_session.query(Task).delete()
        db_session.add(Task(account_id=conv.account_id, task_type="chat_reply", status=state,
                    ref_type="conversation", ref_id=conv.id, spec={}))
        db_session.commit()
        assert chat_autoreply.overdue_conversations(db_session, now, 50) == [], \
            f"{state} 状态的在途任务应挡住重复建单"

    # 任务已结束(失败)则重新欠回复:一次发送失败不该让这个会话永远没人管
    db_session.query(Task).delete()
    db_session.add(Task(account_id=conv.account_id, task_type="chat_reply", status=TaskStatus.FAILED,
                ref_type="conversation", ref_id=conv.id, spec={}))
    db_session.commit()
    assert [c.id for c in chat_autoreply.overdue_conversations(db_session, now, 50)] == [conv.id]


def test_run_pass_is_idempotent_within_a_window(db_session):
    """连跑两轮只建一单:第一轮建的在途任务挡住第二轮。"""
    now = datetime.utcnow()
    old = now - timedelta(seconds=90)
    conv = _conv(db_session, last_at=old)
    _msg(db_session, conv, "in", "在吗", old)

    first = chat_autoreply.run_autoreply_pass(db_session, now, threshold_sec=50)
    assert first == [conv.id]
    second = chat_autoreply.run_autoreply_pass(db_session, now, threshold_sec=50)
    assert second == [], "同一会话不该被重复排队"

    tasks = db_session.query(Task).filter(Task.task_type == "chat_reply").all()
    assert len(tasks) == 1
    assert tasks[0].source == "AUTO", "兜底建的单要能和人工回复区分开"
    assert tasks[0].spec["conversation_id"] == conv.id


def test_fallback_text_makes_no_promises(db_session):
    """兜底话术不得包含商品/价格/库存承诺——乱编的代价远大于那点考核分。"""
    conv = _conv(db_session, last_at=datetime.utcnow())
    text = chat_autoreply.generate_text(db_session, conv)
    assert text.strip()
    for forbidden in ("¥", "元", "包邮", "有货", "现货", "库存", "发货", "便宜", "优惠"):
        assert forbidden not in text, f"兜底话术不该出现「{forbidden}」"


def test_multiple_accounts_are_independent(db_session):
    now = datetime.utcnow()
    old = now - timedelta(seconds=90)
    a = _conv(db_session, "acc-1", "buyer-a", old)
    b = _conv(db_session, "acc-2", "buyer-b", old)
    _msg(db_session, a, "in", "在吗", old)
    _msg(db_session, b, "in", "多少钱", old)
    # acc-2 已经回过
    _msg(db_session, b, "out", "稍等", now - timedelta(seconds=10))
    db_session.query(Conversation).filter(Conversation.id == b.id).update(
        {"last_message_at": now - timedelta(seconds=10)})
    db_session.commit()

    assert [c.id for c in chat_autoreply.overdue_conversations(db_session, now, 50)] == [a.id]


def _succeed_open_replies(db, conv):
    """把这个会话在途的兜底单都当发送成功记账(跑 runner 的那半截)。"""
    from app import jobs
    for t in db.query(Task).filter(Task.ref_id == conv.id, Task.status == TaskStatus.PENDING).all():
        t.status = TaskStatus.SUCCESS
        jobs._on_chat_reply_ok(db, t)
    db.commit()


def test_second_fallback_with_same_text_is_not_resent(db_session):
    """同一会话第二次兜底(话术每次都是同一句)发成功后,不再欠回复。

    原来回复记账与 chat_scan 同键 sha1(out+原文),第二次撞键不落库,最后一条还是买家那句,
    下一轮又判欠回复——开着兜底就隔一分钟给买家再发一遍。"""
    real_now = datetime.utcnow()
    first_at = real_now - timedelta(seconds=600)
    conv = _conv(db_session, last_at=first_at)
    _msg(db_session, conv, "in", "在吗", first_at)
    assert chat_autoreply.run_autoreply_pass(db_session, real_now, threshold_sec=50) == [conv.id]
    _succeed_open_replies(db_session, conv)
    assert chat_autoreply.overdue_conversations(db_session, real_now + timedelta(seconds=120), 50) == []

    # 买家又问一句,过了阈值再兜一次——还是同一句话术
    asked_at = datetime.utcnow()
    _msg(db_session, conv, "in", "多少钱", asked_at)
    conv.last_message_at = asked_at
    db_session.commit()
    later = asked_at + timedelta(seconds=120)
    assert chat_autoreply.run_autoreply_pass(db_session, later, threshold_sec=50) == [conv.id]
    _succeed_open_replies(db_session, conv)

    much_later = later + timedelta(seconds=300)
    assert chat_autoreply.overdue_conversations(db_session, much_later, 50) == []
    assert chat_autoreply.run_autoreply_pass(db_session, much_later, threshold_sec=50) == []
    outs = db_session.query(ChatMessage).filter(
        ChatMessage.conversation_id == conv.id, ChatMessage.direction == "out").count()
    assert outs == 2


def test_unverified_reply_is_not_resent(db_session):
    """上一单停在 reply_verify(点了发送、回读没核对上,多半已经发出去了):不自动补发,交人工。
    别的失败(没发出去)照旧重新欠回复,见 test_open_reply_task_blocks_second_queue。"""
    now = datetime.utcnow()
    old = now - timedelta(seconds=300)
    conv = _conv(db_session, last_at=old)
    _msg(db_session, conv, "in", "在吗", old)
    db_session.add(Task(account_id=conv.account_id, task_type="chat_reply", status=TaskStatus.FAILED,
                        failed_step="reply_verify", ref_type="conversation", ref_id=conv.id, spec={},
                        created_at=old + timedelta(seconds=60)))
    db_session.commit()
    assert chat_autoreply.overdue_conversations(db_session, now, 50) == []

    # 买家之后又说了一句:那是新的一问,照常兜底
    newer = now - timedelta(seconds=100)
    _msg(db_session, conv, "in", "还在吗", newer)
    conv.last_message_at = newer
    db_session.commit()
    assert [c.id for c in chat_autoreply.overdue_conversations(db_session, now, 50)] == [conv.id]


def test_msg_at_missing_falls_back_to_created_at(db_session):
    """闲鱼气泡时间只到分钟且可能缺失,缺了要用落库时间,不能当成永不超时。"""
    now = datetime.utcnow()
    old = now - timedelta(seconds=200)
    conv = _conv(db_session, last_at=old)
    m = _msg(db_session, conv, "in", "在吗", old)
    m.msg_at = None
    db_session.commit()

    assert [c.id for c in chat_autoreply.overdue_conversations(db_session, now, 50)] == [conv.id]
