"""ERP 虚拟商品(卡券)从聊天认付款、替人发码。"""

from datetime import datetime

from app.api import InternalReplyIn, chat_paid, chat_send_internal
from app.models import Account, ChatMessage, Conversation, Task


def _seed(db):
    a = Account(nick="a")
    db.add(a)
    db.flush()
    c = Conversation(account_id=a.id, peer_key="b***1", peer_nick="小鹿", item_id="900001",
                     item_price="46.00", order_status="等待卖家发货")
    other = Conversation(account_id=a.id, peer_key="b***2", item_id="900002")
    db.add_all([c, other])
    db.flush()
    db.add_all([
        ChatMessage(conversation_id=c.id, direction="in", text="在吗", dedup_key="1"),
        ChatMessage(conversation_id=c.id, direction="in", text="我已付款，等待你发货\n请包装好商品", dedup_key="2",
                    msg_at=datetime(2026, 11, 14, 10, 0)),
        ChatMessage(conversation_id=c.id, direction="out", text="我已付款", dedup_key="3"),
    ])
    db.commit()
    return c


def test_paid_lists_only_asked_items_and_paid_messages(db):
    c = _seed(db)
    out = chat_paid(item_ids="900001, 123", db=db)
    assert len(out) == 1
    row = out[0]
    assert row["conversation_id"] == c.id and row["order_status"] == "等待卖家发货"
    # 只算买家那边的付款消息,我们自己发的同样文字不算
    assert [p["at"] for p in row["paid"]] == [datetime(2026, 11, 14, 10, 0)]


def test_send_builds_chat_reply_task(db):
    c = _seed(db)
    res = chat_send_internal(c.id, InternalReplyIn(text="券码 ABC", by_name="陈小满"), db=db)
    t = db.get(Task, res["task_id"])
    assert t.task_type == "chat_reply" and t.spec["text"] == "券码 ABC" and t.spec["by_name"] == "陈小满"
