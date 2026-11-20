"""OA/台账 MCP 推送单测：映射、结果解析、入参构建、outbox 去重、worker 状态机。

不连真 OA：worker 测试里 monkeypatch client.call_tool，并把 worker 的 SessionLocal 指到内存 SQLite。
"""
from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.models import Inspection, OaPushOutbox, PurchaseOrder, SaleOrder, SalesOutbound, Staff
from app.services.oa_push import client, events, mapping, outbox, worker


# ── 纯函数：mapping ────────────────────────────────────────────────────────
def test_mapping_period_and_status():
    # 2026-08-10 03:00 UTC → 11:00 CN，同日；月 202608，日 20260810
    dt = datetime(2026, 8, 10, 3, 0, 0)
    assert mapping.period_month(dt) == "202608"
    assert mapping.period_day(dt) == "20260810"
    assert mapping.biz_date(dt) == "2026-08-10"
    # 跨 UTC 日界：2026-08-10 20:00 UTC → 次日 04:00 CN
    assert mapping.period_day(datetime(2026, 8, 10, 20, 0, 0)) == "20260811"
    assert mapping.staff_status_to_oa("ACTIVE") == "ENABLED"
    assert mapping.staff_status_to_oa("DISABLED") == "DISABLED"
    assert mapping.staff_status_to_oa("PENDING") == "DISABLED"
    assert mapping.is_human_role("SALES") is True
    assert mapping.is_human_role("RFID_DEVICE") is False
    assert mapping.is_human_role("CRAWLER") is False


# ── 纯函数：client 结果解析 ────────────────────────────────────────────────
class _Text:
    def __init__(self, text):
        self.text = text


class _Result:
    def __init__(self, *, content=None, structured=None, is_error=False):
        self.content = content or []
        self.structuredContent = structured
        self.isError = is_error


def test_interpret_success_json():
    r = _Result(content=[_Text('{"success": true, "message": "推送成功", "id": 1001}')])
    assert client._interpret(r) == "1001"


def test_interpret_success_structured():
    r = _Result(structured={"success": True, "id": 45, "message": "ok"})
    assert client._interpret(r) == "45"


def test_interpret_success_plaintext_id():
    r = _Result(content=[_Text("推送成功，记录ID=45，userId=5，roleId=3")])
    assert client._interpret(r) == "45"


def test_interpret_duplicate_is_success():
    r = _Result(content=[_Text("该来源数据已存在，禁止重复同步")], is_error=True)
    assert client._interpret(r) is None  # 幂等重复视为成功，不抛


def test_interpret_mapping_missing_raises_blocked():
    r = _Result(content=[_Text("未找到该第三方用户对应的系统用户映射，staffId=xxx")], is_error=True)
    with pytest.raises(client.OaMappingMissingError):
        client._interpret(r)


def test_interpret_validation_error_non_retriable():
    r = _Result(content=[_Text("缺少必填参数：content")], is_error=True)
    with pytest.raises(client.OaPushError) as ei:
        client._interpret(r)
    assert ei.value.retriable is False


# ── 纯函数：events 入参构建 ────────────────────────────────────────────────
def _outbound(**kw):
    base = dict(
        id="ob1", outbound_no="OB1", sku_id="sku1", operator_id="op1",
        sale_price=Decimal("100.00"), cost_price=Decimal("60.00"),
        sale_order_id=None, created_at=datetime(2026, 8, 10, 3, 0, 0),
    )
    base.update(kw)
    return SalesOutbound(**base)


def test_build_sale_stat_args():
    args = events.build_sale_stat_args(_outbound())
    assert args["sourceNo"] == "OB1"
    assert args["erpStaffId"] == "op1"
    assert args["erpSkuId"] == "sku1"
    assert args["payAmount"] == 100.0
    assert args["costAmount"] == 60.0
    assert args["netPayAmount"] == 100.0   # 支付-退款，退款=0
    assert args["grossProfit"] == 40.0     # 净支付-成本
    assert args["refundAmount"] == 0
    assert args["periodType"] == "day"
    assert args["periodValue"] == "20260810"
    assert "platform" not in args          # 无关联 SaleOrder


def test_build_sale_stat_args_with_order():
    so = SaleOrder(id="so1", order_no="SO1", platform="xianyu", shop_name="店A", status="SHIPPED")
    args = events.build_sale_stat_args(_outbound(sale_order_id="so1"), so)
    assert args["platform"] == "xianyu"
    assert args["storeName"] == "店A"
    assert args["erpOrderId"] == "so1"


def test_finance_for_outbound_sales_role():
    po = PurchaseOrder(order_no="PO1", created_by_id="buyer1", is_overdue=False)
    recs = events.build_finance_for_outbound(_outbound(), po, "SALES")
    suffixes = {s for _, s in recs}
    assert suffixes == {"purchase", "sales_outbound"}
    by = {s: a for a, s in recs}
    assert by["purchase"]["erpStaffId"] == "buyer1"
    assert by["purchase"]["amount"] == 4.0          # (100-60)*10%
    assert by["purchase"]["period"] == "202608"
    assert by["sales_outbound"]["erpStaffId"] == "op1"
    assert by["sales_outbound"]["amount"] == 10.0
    assert all(r["settleZone"] == "income" for r, _ in recs)


def test_finance_for_outbound_overdue_skips_purchase():
    po = PurchaseOrder(order_no="PO1", created_by_id="buyer1", is_overdue=True)
    recs = events.build_finance_for_outbound(_outbound(), po, "WAREHOUSE")
    suffixes = {s for _, s in recs}
    assert suffixes == {"wh_outbound"}              # 逾期不发采购提成
    assert recs[0][0]["amount"] == 5.0


def test_finance_for_outbound_admin_gets_both_fees():
    po = PurchaseOrder(order_no="PO1", created_by_id="buyer1", is_overdue=False)
    recs = events.build_finance_for_outbound(_outbound(), po, "ADMIN")
    assert {s for _, s in recs} == {"purchase", "wh_outbound", "sales_outbound"}


def test_build_staff_args_drops_empty_and_maps_status():
    s = Staff(id="s1", username="u1", staff_no="M1", role="SALES", status="ACTIVE",
              name="张三", shop=None, openid=None, password_hash="hash")
    args = events.build_staff_args(s)
    assert args["staffId"] == "s1"
    assert args["status"] == "ENABLED"
    assert args["name"] == "张三"
    assert args["passwordHash"] == "hash"
    assert "shop" not in args and "openid" not in args


def test_build_staff_args_always_requests_create():
    """恒带 createIfNotExists,新员工不再挂 BLOCKED_NO_MAPPING(OA 文档 v1.8)。"""
    s = Staff(id="s1", username="u1", staff_no="M1", role="SALES", status="ACTIVE",
              name="张三", password_hash="h")
    assert events.build_staff_args(s)["createIfNotExists"] is True


def test_build_staff_args_name_falls_back_when_blank():
    """创建模式下 name 必填;ERP 有历史账号姓名为空,兜底到 username 再到工号。"""
    s = Staff(id="s1", username="u1", staff_no="M1", role="SALES", status="ACTIVE",
              name="   ", password_hash="h")
    assert events.build_staff_args(s)["name"] == "u1"

    s2 = Staff(id="s2", username="", staff_no="M2", role="SALES", status="ACTIVE",
               name="", password_hash="h")
    assert events.build_staff_args(s2)["name"] == "M2"


def test_build_staff_args_create_requires_name_and_role_present():
    """OA 创建模式的两个必填项在任何情况下都不能缺。"""
    s = Staff(id="s1", username="", staff_no="M1", role="PURCHASER", status="PENDING",
              name="", password_hash="h")
    args = events.build_staff_args(s)
    assert args["name"] and args["role"] == "PURCHASER"


class _Feedback:
    """最小化的匿名反馈替身（build_reply_args 只读这几个字段）。"""

    def __init__(self, created_at=None, handled_at=None):
        self.id = "fb1"
        self.content = "客户原话"
        self.handled_note = "已回复"
        self.handled_by_id = "s1"
        self.created_at = created_at
        self.handled_at = handled_at


def test_build_reply_args_includes_role_and_response_sec():
    fb = _Feedback(
        created_at=datetime(2026, 8, 10, 6, 0, 0),
        handled_at=datetime(2026, 8, 10, 6, 2, 30),
    )
    args = events.build_reply_args(fb, "ADMIN")
    assert args["erpStaffId"] == "s1"
    assert args["erpRole"] == "ADMIN"  # OA 侧再映射成 PTADMIN
    assert args["responseSec"] == 150  # 2分30秒
    assert args["content"] == "已回复" and args["replyContent"] == "客户原话"


def test_build_reply_args_omits_role_when_unknown():
    fb = _Feedback(created_at=datetime(2026, 8, 10, 6, 0, 0), handled_at=datetime(2026, 8, 10, 6, 0, 5))
    args = events.build_reply_args(fb)
    assert "erpRole" not in args
    assert args["responseSec"] == 5


def test_build_reply_args_skips_negative_response_sec():
    """处理时间早于创建时间（数据异常）时不传 responseSec，避免 OA 侧收到负数。"""
    fb = _Feedback(
        created_at=datetime(2026, 8, 10, 6, 0, 0),
        handled_at=datetime(2026, 8, 10, 5, 0, 0),
    )
    assert "responseSec" not in events.build_reply_args(fb, "ADMIN")


def test_build_reply_args_without_created_at():
    assert "responseSec" not in events.build_reply_args(_Feedback(), "ADMIN")


# ── DB 夹具：仅建 outbox 表 ────────────────────────────────────────────────
@pytest.fixture()
def oa_db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[OaPushOutbox.__table__])
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(settings, "oa_push_enabled", True)
    monkeypatch.setattr(worker, "SessionLocal", TestSession)  # worker 短会话指到测试库
    outbox.set_autosubmit(False)  # commit 不触发真投递
    try:
        yield TestSession
    finally:
        outbox.set_autosubmit(True)
        engine.dispose()


def test_enqueue_dedup(oa_db):
    db = oa_db()
    try:
        a = outbox.enqueue_push(db, "push_sale_stat", {"x": 1}, dedup_key="k1")
        db.commit()
        b = outbox.enqueue_push(db, "push_sale_stat", {"x": 1}, dedup_key="k1")
        db.commit()
        assert a is not None and b is None            # 第二次被去重
        assert db.query(OaPushOutbox).count() == 1
    finally:
        db.close()


def _seed_one(oa_db, tool="push_sale_stat", dedup="k1") -> str:
    db = oa_db()
    try:
        oid = outbox.enqueue_push(db, tool, {"x": 1}, dedup_key=dedup)
        db.commit()
        return oid
    finally:
        db.close()


def test_worker_success(oa_db, monkeypatch):
    oid = _seed_one(oa_db)
    monkeypatch.setattr(client, "call_tool", lambda tool, args: "77")
    worker._run(oid)
    db = oa_db()
    try:
        row = db.get(OaPushOutbox, oid)
        assert row.status == "SUCCEEDED"
        assert row.remote_id == "77"
        assert row.sent_at is not None
    finally:
        db.close()


def test_worker_retriable_then_retry(oa_db, monkeypatch):
    oid = _seed_one(oa_db)

    def boom(tool, args):
        raise client.OaPushError("连接超时", retriable=True)

    monkeypatch.setattr(client, "call_tool", boom)
    worker._run(oid)
    db = oa_db()
    try:
        row = db.get(OaPushOutbox, oid)
        assert row.status == "RETRY"
        assert row.attempts == 1
        assert row.next_due_at > datetime.utcnow()
    finally:
        db.close()


def test_worker_mapping_missing_blocked(oa_db, monkeypatch):
    oid = _seed_one(oa_db)

    def miss(tool, args):
        raise client.OaMappingMissingError("未找到映射")

    monkeypatch.setattr(client, "call_tool", miss)
    worker._run(oid)
    db = oa_db()
    try:
        assert db.get(OaPushOutbox, oid).status == "BLOCKED_NO_MAPPING"
    finally:
        db.close()


def test_worker_non_retriable_failed(oa_db, monkeypatch):
    oid = _seed_one(oa_db)

    def bad(tool, args):
        raise client.OaPushError("参数非法", retriable=False)

    monkeypatch.setattr(client, "call_tool", bad)
    worker._run(oid)
    db = oa_db()
    try:
        assert db.get(OaPushOutbox, oid).status == "FAILED"
    finally:
        db.close()


def test_worker_exhausts_attempts(oa_db, monkeypatch):
    oid = _seed_one(oa_db)
    monkeypatch.setattr(settings, "oa_push_max_attempts", 2)

    def boom(tool, args):
        raise client.OaPushError("超时", retriable=True)

    monkeypatch.setattr(client, "call_tool", boom)
    # 第 1 次 → RETRY(attempts=1)；把 next_due_at 拨到过去再跑第 2 次 → FAILED(attempts=2)
    worker._run(oid)
    db = oa_db()
    try:
        row = db.get(OaPushOutbox, oid)
        row.status = "RETRY"
        row.next_due_at = datetime.utcnow() - timedelta(seconds=1)
        db.commit()
    finally:
        db.close()
    worker._run(oid)
    db = oa_db()
    try:
        row = db.get(OaPushOutbox, oid)
        assert row.attempts == 2
        assert row.status == "FAILED"
    finally:
        db.close()
