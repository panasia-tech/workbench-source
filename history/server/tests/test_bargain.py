"""W07 议价状态机：识别 → 报价 → 还价 → 谈妥；暂停请求与确认分离（PC-091）；必要问题待核（PC-090）。"""
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import StaffRole, StaffStatus
from app.models import BargainSession, Staff
from app.services import bargain as svc


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Staff.__table__, BargainSession.__table__])
    session = sessionmaker(bind=engine, autoflush=True)()
    yield session
    session.close()


@pytest.fixture()
def user(db):
    row = Staff(staff_no="b1", username="b1", name="采购", role=StaffRole.PURCHASER,
                status=StaffStatus.ACTIVE, password_hash="x")
    db.add(row)
    db.commit()
    return row


def _verify_required(db, s, user):
    for c in svc.checks_of(s):
        if c.get("required"):
            svc.update_check(s, key=c["key"], status="VERIFIED", note="已核", user_id=user.id)
    db.flush()


def test_quote_counter_deal_and_pause(db, user):
    s = svc.open_session(db, user_id=user.id, platform_item_id="item-9", purchase_account="accA",
                         listed_price=Decimal("1500"), title="显示器")
    db.commit()
    assert s.state == "IDENTIFY"
    assert s.checks and len(svc.pending_required(s)) >= 1

    svc.transition(db, s, action="quote", price=Decimal("1200"), user_id=user.id)
    assert s.state == "QUOTE" and s.our_price == Decimal("1200") and s.round_no == 1

    svc.transition(db, s, action="counter", price=Decimal("1350"), user_id=user.id)
    assert s.state == "COUNTER" and s.their_price == Decimal("1350") and s.round_no == 2

    # PC-091：先请求，再确认
    svc.transition(db, s, action="pause_request", user_id=user.id)
    assert s.state == "PAUSING" and s.paused_from == "COUNTER" and s.paused_at is None
    svc.transition(db, s, action="pause_confirm", user_id=user.id)
    assert s.state == "PAUSED" and s.paused_from == "COUNTER" and s.paused_at is not None
    svc.transition(db, s, action="resume", user_id=user.id)
    assert s.state == "COUNTER"

    with pytest.raises(HTTPException, match="必要问题待核"):
        svc.transition(db, s, action="deal", price=Decimal("1280"), user_id=user.id)
    _verify_required(db, s, user)
    svc.transition(db, s, action="deal", price=Decimal("1280"), user_id=user.id)
    assert s.state == "DEAL" and s.deal_price == Decimal("1280")
    with pytest.raises(HTTPException, match="不能"):
        svc.transition(db, s, action="quote", price=Decimal("1000"), user_id=user.id)

    same = svc.open_session(db, user_id=user.id, platform_item_id="item-9", purchase_account="accA")
    # 谈妥后新开一单
    assert same.id != s.id and same.state == "IDENTIFY"


def test_pause_alias_and_cancel_request(db, user):
    s = svc.open_session(db, user_id=user.id, platform_item_id="item-alias", purchase_account="accB")
    db.commit()
    svc.transition(db, s, action="quote", price=Decimal("900"), user_id=user.id)
    # pause 在活跃态 = 请求
    svc.transition(db, s, action="pause", user_id=user.id)
    assert s.state == "PAUSING" and s.paused_at is None
    # 取消请求 → 恢复
    svc.transition(db, s, action="resume", user_id=user.id)
    assert s.state == "QUOTE" and s.paused_from is None
    # 再请求后用 pause 确认
    svc.transition(db, s, action="pause", user_id=user.id)
    svc.transition(db, s, action="pause", user_id=user.id)
    assert s.state == "PAUSED" and s.paused_at is not None


def test_open_binds_gc_conversation(db, user):
    s = svc.open_session(
        db, user_id=user.id, platform_item_id="item-gc", purchase_account="店A",
        seller_name="卖家甲", title="键盘",
    )
    db.commit()
    assert s.gc_conversation_id is None
    again = svc.open_session(
        db, user_id=user.id, platform_item_id="item-gc", purchase_account="店A",
        gc_conversation_id="conv-123", source_url="https://www.goofish.com/item?id=item-gc",
    )
    assert again.id == s.id
    assert again.gc_conversation_id == "conv-123"
    assert again.source_url.endswith("item-gc")

    by_gc = svc.open_session(db, user_id=user.id, gc_conversation_id="conv-123")
    assert by_gc.id == s.id


def test_deal_then_bind_purchase(db, user):
    s = svc.open_session(db, user_id=user.id, platform_item_id="item-po", purchase_account="accC")
    db.commit()
    with pytest.raises(HTTPException, match="谈妥"):
        svc.bind_purchase(db, s, "po-1")
    _verify_required(db, s, user)
    # 建单路径：未 DEAL 时可先 deal 再绑
    svc.transition(db, s, action="deal", price=Decimal("880"), user_id=user.id, note="建采购单时确认谈妥")
    svc.bind_purchase(db, s, "po-1")
    assert s.purchase_order_id == "po-1" and s.state == "DEAL"


def test_necessary_checks_pc090(db, user):
    s = svc.open_session(db, user_id=user.id, platform_item_id="item-chk", purchase_account="accD")
    db.commit()
    assert len(svc.pending_required(s)) >= 5
    # 卖家已声明：记 DECLARED，不再追问（PC-089）
    svc.update_check(s, key="accessories", status="DECLARED", note="卖家说原装盒电源都在", user_id=user.id)
    assert "accessories" not in [c["key"] for c in svc.askable_checks(s)]
    # 选填可跳过；必核要 VERIFIED / DECLARED / SKIPPED 才不算 PENDING
    svc.update_check(s, key="shipping", status="SKIPPED", note="当面自提", user_id=user.id)
    for c in svc.checks_of(s):
        if c.get("required") and c["key"] != "accessories":
            svc.update_check(s, key=c["key"], status="VERIFIED", user_id=user.id)
    assert svc.pending_required(s) == []
    out = svc.session_out(s)
    assert out["pending_required"] == 0
    assert "accessories" not in out["askable"]


def test_update_check_persists_after_reload(db, user):
    """改必要问题要真写进库：原来直接改 JSON 里那个 dict，SQLAlchemy 判成没变，重读还是待核，永远谈不妥。"""
    s = svc.open_session(db, user_id=user.id, platform_item_id="item-persist", purchase_account="accP")
    db.commit()
    svc.update_check(s, key="model", status="VERIFIED", note="对过", user_id=user.id)
    db.commit()
    db.expire_all()
    again = db.get(BargainSession, s.id)
    assert {c["key"]: c["status"] for c in again.checks}["model"] == "VERIFIED"


def test_bind_purchase_does_not_rebind(db, user):
    s = svc.open_session(db, user_id=user.id, platform_item_id="item-once", purchase_account="accQ")
    db.commit()
    _verify_required(db, s, user)
    svc.transition(db, s, action="deal", price=Decimal("500"), user_id=user.id)
    svc.bind_purchase(db, s, "po-a")
    # 建单顺带绑：不改绑、不报错（多件同会话 / 页面没清会话号）
    svc.bind_purchase(db, s, "po-b", strict=False)
    assert s.purchase_order_id == "po-a"
    with pytest.raises(HTTPException, match="已经绑了"):
        svc.bind_purchase(db, s, "po-c")
