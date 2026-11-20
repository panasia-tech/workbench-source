import pytest
from sqlalchemy.exc import IntegrityError
from app.models import Account, Conversation, ChatMessage


def _acc(db):
    a = Account(nick="a"); db.add(a); db.flush(); return a


def test_conversation_unique_account_peer(db):
    a = _acc(db)
    db.add(Conversation(account_id=a.id, peer_key="t***7", peer_nick="t***7")); db.commit()
    db.add(Conversation(account_id=a.id, peer_key="t***7"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_chat_message_unique_dedup(db):
    a = _acc(db)
    c = Conversation(account_id=a.id, peer_key="t***7"); db.add(c); db.flush()
    db.add(ChatMessage(conversation_id=c.id, direction="in", text="hi", dedup_key="k1")); db.commit()
    db.add(ChatMessage(conversation_id=c.id, direction="in", text="hi", dedup_key="k1"))
    with pytest.raises(IntegrityError):
        db.commit()
