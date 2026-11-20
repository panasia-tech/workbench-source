from app import jobs
from app.models import Account, Conversation, ChatMessage, Job, JobType, Task, TaskStatus


def _acc(db):
    a = Account(nick="a"); db.add(a); db.flush(); return a


def _result_task(db, acc, convs, msgs):
    t = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.SUCCESS,
             result={"ok": True, "conversations": convs, "messages": msgs})
    db.add(t); db.commit(); return t


def test_create_chat_scan_fans_out(db):
    a = _acc(db)
    job = jobs.create_chat_scan(db, a.id)
    assert job.job_type == JobType.CHAT_SCAN
    ts = db.query(Task).filter(Task.job_id == job.id).all()
    assert len(ts) == 1 and ts[0].task_type == "chat_scan" and ts[0].account_id == a.id


def test_create_chat_scan_skips_when_inflight(db):
    a = _acc(db)
    jobs.create_chat_scan(db, a.id)
    jobs.create_chat_scan(db, a.id)
    assert db.query(Task).filter_by(task_type="chat_scan", account_id=a.id).count() == 1


def test_on_chat_scan_ok_upsert_and_dedup(db):
    a = _acc(db)
    convs = [{"peer_key": "t***7", "peer_nick": "t***7", "item_title": "半卖半送了",
              "order_status": "等待买家收货", "last_message": "[卖家已发货]", "unread": 0}]
    msgs = {"t***7": [{"direction": "in", "text": "我已付款", "msg_at": None},
                       {"direction": "in", "text": "网盘", "msg_at": None}]}
    jobs._on_chat_scan_ok(db, _result_task(db, a, convs, msgs)); db.commit()
    assert db.query(Conversation).count() == 1
    assert db.query(ChatMessage).count() == 2
    conv = db.query(Conversation).one()
    assert conv.item_title == "半卖半送了" and conv.order_status == "等待买家收货"
    # 再扫一次同内容:会话不翻倍,消息按 dedup 不翻倍
    jobs._on_chat_scan_ok(db, _result_task(db, a, convs, msgs)); db.commit()
    assert db.query(Conversation).count() == 1
    assert db.query(ChatMessage).count() == 2


def test_on_chat_scan_ok_intra_batch_dup(db):
    # _read_history 跨屏滚动去重靠 (desc, cx, cy),cy 随滚动变化 → 同一句话在一次
    # scan 里可能被 parse_chat_page 重复吐出。_on_chat_scan_ok 原来只靠"查库是否存在"
    # 去重,但同一批次里两条消息都未 flush,查询都查不到对方,导致同一 dedup_key
    # 被 add 两次,commit 时撞 uq_msg_conv_dedup 唯一约束报 IntegrityError。
    a = _acc(db)
    convs = [{"peer_key": "t***9", "peer_nick": "t***9", "item_title": "货",
              "order_status": None, "last_message": "在吗", "unread": 0}]
    msgs = {"t***9": [{"direction": "in", "text": "在吗", "msg_at": None},
                       {"direction": "in", "text": "在吗", "msg_at": None}]}
    jobs._on_chat_scan_ok(db, _result_task(db, a, convs, msgs))
    db.commit()
    conv = db.query(Conversation).filter(Conversation.peer_key == "t***9").one()
    assert db.query(ChatMessage).filter(ChatMessage.conversation_id == conv.id).count() == 1


def test_on_chat_scan_ok_accumulates_unread(db):
    """小程序未读 = 累计新进站消息:首次 +N,重扫(dedup)不变,新消息再 +1,out 不计。"""
    a = _acc(db)
    convs = [{"peer_key": "t***7", "peer_nick": "t***7", "item_title": "货",
              "order_status": None, "last_message": "在吗", "unread": 0}]
    msgs = {"t***7": [{"direction": "in", "text": "在吗", "msg_at": None}]}
    jobs._on_chat_scan_ok(db, _result_task(db, a, convs, msgs)); db.commit()
    assert db.query(Conversation).one().unread == 1
    jobs._on_chat_scan_ok(db, _result_task(db, a, convs, msgs)); db.commit()   # 重扫同内容
    assert db.query(Conversation).one().unread == 1
    msgs2 = {"t***7": [{"direction": "in", "text": "还在吗", "msg_at": None},
                        {"direction": "out", "text": "在的", "msg_at": None}]}
    jobs._on_chat_scan_ok(db, _result_task(db, a, convs, msgs2)); db.commit()
    assert db.query(Conversation).one().unread == 2


def test_mark_conversation_read_clears_unread(db):
    """人工在小程序打开会话 → mark-read 清零未读(直调 endpoint 函数)。"""
    from app.api import mark_conversation_read
    a = _acc(db)
    convs = [{"peer_key": "z***1", "peer_nick": "z***1", "item_title": "货",
              "order_status": None, "last_message": "hi", "unread": 0}]
    msgs = {"z***1": [{"direction": "in", "text": "hi", "msg_at": None}]}
    jobs._on_chat_scan_ok(db, _result_task(db, a, convs, msgs)); db.commit()
    conv = db.query(Conversation).one()
    assert conv.unread == 1
    mark_conversation_read(conv.id, user={}, db=db)
    assert db.query(Conversation).one().unread == 0
