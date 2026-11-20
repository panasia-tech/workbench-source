"""采购工作台 W10：平台订单入库、对上采购单、状态新旧、要人看（禅道 #47 的验收用例）。"""
from datetime import datetime
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import OrderStatus, StaffRole, StaffStatus
from app.models import PurchaseAccount, PurchaseOrder, PurchasePlatformEvent, PurchasePlatformOrder, Staff
from app.routers import purchase_platform as api
from app.services import purchase_platform as pp

_TABLES = [Staff.__table__, PurchaseAccount.__table__, PurchasePlatformOrder.__table__, PurchasePlatformEvent.__table__,
           PurchaseOrder.__table__]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=_TABLES)
    s = sessionmaker(bind=engine, autoflush=True)()
    s.add_all([
        Staff(id="p1", staff_no="p1", username="p1", name="小吕", role=StaffRole.PURCHASER, status=StaffStatus.ACTIVE, password_hash="x"),
        Staff(id="p2", staff_no="p2", username="p2", name="小陈", role=StaffRole.PURCHASER, status=StaffStatus.ACTIVE, password_hash="x"),
        Staff(id="adm", staff_no="a", username="a", name="管理员", role=StaffRole.ADMIN, status=StaffStatus.ACTIVE, password_hash="x"),
        PurchaseAccount(code="tb062466670", label="大西洋吃汤圆的海蜘蛛", enabled=True),
    ])
    s.commit()
    yield s
    s.close()


def _po(db, no, ext, account="tb062466670", by="p1", status=OrderStatus.PENDING_INSPECT):
    po = PurchaseOrder(order_no=no, status=status, product_name="显示器", unit_price=Decimal("1000"), external_order_no=ext,
                       purchase_account=account, created_by_id=by)
    db.add(po)
    db.commit()
    return po


def _in(db, *orders, account="大西洋吃汤圆的海蜘蛛"):
    out = pp.ingest(db, "xianyu", account, list(orders))
    db.commit()
    return out


def _one(db, no="O1"):
    return db.query(PurchasePlatformOrder).filter_by(platform_order_no=no).one()


def test_同一单重复报只更新一条_账号按昵称对上(db):
    o = {"platform_order_no": "O1", "raw_status": "等待卖家发货", "item_title": "戴尔 U2720Q", "item_image": "https://img/1.jpg",
         "paid_amount": "999.5", "seller_name": "卖家甲"}
    assert _in(db, o)["created"] == 1
    assert _in(db, o)["updated"] == 1
    row = _one(db)
    assert (row.purchase_account, row.trade_status, row.pay_status, row.ship_status) == ("tb062466670", "paid", "paid", "unshipped")
    assert row.paid_amount == Decimal("999.50") and row.sync_status == "ok" and not row.needs_review
    kinds = [e.kind for e in db.query(PurchasePlatformEvent).all()]
    assert kinds.count("created") == 1 and kinds.count("status") == 1, "重复报不重复记事件"
    assert db.query(PurchasePlatformOrder).count() == 1


def test_缺字段标部分成功_后来补上不清掉已有的(db):
    _in(db, {"platform_order_no": "O1", "raw_status": "等待卖家发货", "item_title": "戴尔"})
    row = _one(db)
    assert row.sync_status == "partial" and "商品图" in row.sync_error and row.paid_amount is None, "缺了留空不填 0"
    _in(db, {"platform_order_no": "O1", "item_image": "https://img/1.jpg", "paid_amount": "900"})
    db.refresh(row)
    assert (row.item_title, row.sync_status) == ("戴尔", "ok")


def test_账号找不到_状态看不懂_都标要人看(db):
    _in(db, {"platform_order_no": "O1", "raw_status": "奇怪的状态"}, account="陌生号")
    row = _one(db)
    assert row.needs_review and "陌生号" in row.review_reason and "奇怪的状态" in row.review_reason
    assert row.purchase_account is None and row.trade_status == "unknown"


def test_关了的单不让迟到的已付款改回去(db):
    _in(db, {"platform_order_no": "O1", "raw_status": "交易关闭"})
    _in(db, {"platform_order_no": "O1", "raw_status": "等待卖家发货"})
    row = _one(db)
    assert row.trade_status == "closed"
    assert db.query(PurchasePlatformEvent).filter_by(kind="stale").count() == 1
    # 带平台时间的：旧的不改，新的改
    _in(db, {"platform_order_no": "O2", "raw_status": "卖家已发货", "platform_updated_at": "2026-11-10T10:00:00"})
    _in(db, {"platform_order_no": "O2", "raw_status": "等待卖家发货", "platform_updated_at": "2026-11-09T10:00:00"})
    assert _one(db, "O2").trade_status == "shipped"
    _in(db, {"platform_order_no": "O2", "raw_status": "交易成功", "platform_updated_at": "2026-11-12T10:00:00"})
    assert _one(db, "O2").trade_status == "done"


def test_按订单号自动挂采购单_一单多件都挂_别的号不挂(db):
    a = _po(db, "PO1", "O1")
    b = _po(db, "PO2", "O1", account="默认账户")
    c = _po(db, "PO3", "O1", account="kkxkk")
    _in(db, {"platform_order_no": "O1", "raw_status": "等待卖家发货"})
    row = _one(db)
    for p in (a, b, c):
        db.refresh(p)
    assert a.platform_order_id == row.id and b.platform_order_id == row.id, "默认账户等于没说是哪个号，也挂"
    assert c.platform_order_id is None and row.needs_review and "kkxkk" in row.review_reason


def test_平台关单了采购单还在等收货_标要人看_不自动取消(db):
    po = _po(db, "PO1", "O1")
    _in(db, {"platform_order_no": "O1", "raw_status": "等待卖家发货"})
    assert not _one(db).needs_review
    _in(db, {"platform_order_no": "O1", "raw_status": "退款成功", "refunded_amount": "999"})
    row = _one(db)
    db.refresh(po)
    assert row.needs_review and "PO1" in row.review_reason and po.status == OrderStatus.PENDING_INSPECT
    api.review(row.id, api.NoteIn(note="卖家没发货，已取消采购单"), db=db, user=db.get(Staff, "p1"))
    assert not _one(db).needs_review


def test_手动挂和摘_对不上的挂不上(db):
    _in(db, {"platform_order_no": "O1", "raw_status": "等待卖家发货"})
    row = _one(db)
    p1 = db.get(Staff, "p1")
    po = _po(db, "PO9", None)
    pp.bind(db, p1, row, po)
    assert po.platform_order_id == row.id and po.external_order_no == "O1", "没填订单号的挂上时补上"
    other = _po(db, "PO8", "O-OTHER")
    with pytest.raises(HTTPException, match="对不上"):
        pp.bind(db, p1, row, other)
    with pytest.raises(HTTPException, match="原因"):
        pp.unbind(db, p1, row, po, note=" ")
    pp.unbind(db, p1, row, po, note="挂错了")
    assert po.platform_order_id is None


def test_建采购单时挂上_一键建单的带过去(db):
    _in(db, {"platform_order_no": "O1", "raw_status": "等待卖家发货", "item_title": "戴尔 U2720Q", "paid_amount": "999",
             "item_id": "itm1", "item_image": "https://img/1.jpg", "ordered_at": "2026-11-14T08:00:00"})
    row = _one(db)
    d = pp.draft(row)
    assert (d["external_order_no"], d["purchase_account"], d["unit_price"], d["platform_item_id"]) == ("O1", "tb062466670", "999.00", "itm1")
    assert row.ordered_at == datetime(2026, 11, 14, 0, 0), "页面上的北京时间存成 UTC"
    assert d["order_time"].startswith("2026-11-14T08:00"), "带回表单的是北京时间"
    p1 = db.get(Staff, "p1")
    po = _po(db, "PO1", "O1")
    po.platform_order_id = None
    pp.bind_new_order(db, p1, po, row.id)
    assert po.platform_order_id == row.id
    # 手填的：按订单号找到唯一一条就挂
    _in(db, {"platform_order_no": "O2", "raw_status": "等待卖家发货"})
    po2 = PurchaseOrder(order_no="PO2", status=OrderStatus.PENDING_INSPECT, product_name="x", unit_price=Decimal("1"),
                        external_order_no="O2", purchase_account="tb062466670", created_by_id="p1")
    db.add(po2)
    db.flush()
    pp.bind_new_order(db, p1, po2, None)
    assert po2.platform_order_id == _one(db, "O2").id


def test_采购员看得到待建单和自己的_别人的看不到(db):
    _in(db, {"platform_order_no": "O1", "raw_status": "等待卖家发货"}, {"platform_order_no": "O2", "raw_status": "等待卖家发货"})
    _po(db, "PO1", "O1", by="p2")
    _in(db, {"platform_order_no": "O1"})  # 再报一次触发自动挂上
    p1, p2, adm = (db.get(Staff, i) for i in ("p1", "p2", "adm"))
    ls = lambda u, view="all": api.list_orders(view=view, account=None, trade_status=None, q=None, page=1, size=30, db=db, user=u)
    assert [x["platform_order_no"] for x in ls(p1)["items"]] == ["O2"]
    assert sorted(x["platform_order_no"] for x in ls(p2)["items"]) == ["O1", "O2"]
    assert ls(adm)["total"] == 2 and ls(adm, "unbound")["total"] == 1
    _in(db, {"platform_order_no": "O3", "raw_status": "退款成功"})
    assert ls(adm, "unbound")["total"] == 1, "退款关单的不用建采购单"
    with pytest.raises(HTTPException):
        api.read_order(_one(db).id, db=db, user=p1)


def test_入库接口只认本机():
    class Req:
        def __init__(self, host, headers):
            self.client = type("C", (), {"host": host})()
            self.headers = headers
    api.require_local(Req("127.0.0.1", {}))
    with pytest.raises(HTTPException):
        api.require_local(Req("127.0.0.1", {"x-real-ip": "127.0.0.1"}))
    with pytest.raises(HTTPException):
        api.require_local(Req("10.0.0.2", {}))
