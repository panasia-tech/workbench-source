"""验货全检、异常 10 分钟时限、出库复核。

这里钉死的口径：
  1. 坏货、拒签也要验完所有项；无法测试必须有原因和凭证。
  2. 开关默认关，没开始逐项验货的老流程（线上小程序）不受影响。
  3. 登记异常不改验货单状态，通知立刻生成；超时升级只发生一次。
  4. 退款申请不等于到账；货没退回、退款没结果不能结束。
  5. 复核出库时消耗，退货后再发要重新复核；自提、切单不拦。
"""

from datetime import datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import InspectionStatus, OrderStatus, SkuStatus, StaffRole, StaffStatus
from app.models import (
    AppSetting,
    Inspection,
    InspectionCheckItem,
    InspectionCheckItemLog,
    InspectionEvidence,
    InspectionException,
    InspectionExceptionEvent,
    InspectionTemplate,
    OutboundReview,
    PurchaseItemSnapshot,
    PurchaseOrder,
    PurchasePlatformOrder,
    Sku,
    Staff,
)
from app.routers import inspection_ops as router
from app.schemas.inspection_ops import (
    CheckItemUpdate,
    CheckStart,
    ExceptionClose,
    ExceptionIn,
    ExceptionProgress,
    PurchaserEvidenceIn,
    ReviewIn,
)
from app.services import inspection_ops as ops
from app.services.app_settings import set_setting
from app.services.inspection_templates_demo import DEMO_TEMPLATES

_TABLES = [
    m.__table__
    for m in (
        Staff, PurchaseOrder, Inspection, Sku, AppSetting, InspectionTemplate, InspectionCheckItem, InspectionCheckItemLog,
        InspectionEvidence, InspectionException, InspectionExceptionEvent, OutboundReview,
        PurchasePlatformOrder, PurchaseItemSnapshot,
    )
]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=_TABLES)
    session = sessionmaker(bind=engine, autoflush=True)()
    yield session
    session.close()


def _staff(db, name, role):
    row = Staff(staff_no=name, username=name, name=name, role=role, status=StaffStatus.ACTIVE, password_hash="x")
    db.add(row)
    db.flush()
    return row


@pytest.fixture()
def world(db):
    admin = _staff(db, "管理员", StaffRole.ADMIN)
    keeper = _staff(db, "仓管", StaffRole.WAREHOUSE)
    buyer = _staff(db, "采购", StaffRole.PURCHASER)
    handler = _staff(db, "业务员", StaffRole.BUSINESS)
    seller = _staff(db, "销售", StaffRole.SALES)
    order = PurchaseOrder(
        order_no="PO1", status=OrderStatus.PENDING_INSPECT, product_name="戴尔 U2720Q 显示器", brand="戴尔",
        model="U2720Q", unit_price=Decimal("1000"), created_by_id=buyer.id,
    )
    db.add(order)
    db.flush()
    task = Inspection(inspect_no="IN1", purchase_order_id=order.id, status=InspectionStatus.PENDING)
    db.add(task)
    db.add_all(InspectionTemplate(**t, version=1, enabled=True) for t in DEMO_TEMPLATES)
    db.commit()
    return SimpleNamespace(admin=admin, keeper=keeper, buyer=buyer, handler=handler, seller=seller, order=order, task=task)


def _start(db, w):
    router.start_check(w.task.id, CheckStart(), db, w.keeper)


def _finish_all(db, w):
    for item in ops.check_items(db, w.task.id):
        router.update_check_item(
            w.task.id, item.item_key,
            CheckItemUpdate(result="PASS", evidence=["https://x/a.jpg"]), db, w.keeper,
        )


def _targets(db, action):
    rows = db.query(InspectionExceptionEvent).filter(InspectionExceptionEvent.action == action).all()
    return {r.target_staff_id for r in rows}


def test_match_prefers_model_and_skips_other_models(db, world):
    assert ops.match_template(db, world.order).category == "显示器"
    base = dict(category="显示器", keywords=["显示器"], steps=[{"key": "a", "title": "a"}], version=1, enabled=True)
    db.add(InspectionTemplate(name="型号", model="U2720Q", **base))
    db.add(InspectionTemplate(name="别的型号", model="P2419H", **base))
    db.add(InspectionTemplate(name="笔记本品牌", brand="戴尔", category="笔记本", keywords=["笔记本"],
                              steps=base["steps"], version=1, enabled=True))
    db.commit()
    assert ops.match_template(db, world.order).name == "型号"


def test_brand_template_of_other_category_does_not_match(db, world):
    db.query(InspectionTemplate).delete()
    db.add(InspectionTemplate(name="戴尔笔记本", brand="戴尔", category="笔记本", keywords=["笔记本"],
                              steps=[{"key": "a", "title": "a"}], version=1, enabled=True))
    db.commit()
    assert ops.match_template(db, world.order) is None


def test_old_flow_untouched_when_switch_off(db, world):
    ops.assert_ready_to_submit(db, world.task, world.order)


def test_switch_on_requires_check_when_template_exists(db, world):
    set_setting(db, ops.FULL_CHECK_REQUIRED, "1", None)
    with pytest.raises(HTTPException):
        ops.assert_ready_to_submit(db, world.task, world.order)


def test_started_check_blocks_submit_until_every_item_done(db, world):
    _start(db, world)
    with pytest.raises(HTTPException) as e:
        ops.assert_ready_to_submit(db, world.task, world.order)
    assert "没验" in e.value.detail
    _finish_all(db, world)
    ops.assert_ready_to_submit(db, world.task, world.order)


def test_untestable_needs_reason_and_evidence(db, world):
    _start(db, world)
    key = ops.check_items(db, world.task.id)[0].item_key
    for body in (
        CheckItemUpdate(result="UNTESTABLE", evidence=["https://x/a.jpg"]),
        CheckItemUpdate(result="UNTESTABLE", note="屏碎了点不亮"),
    ):
        with pytest.raises(HTTPException):
            router.update_check_item(world.task.id, key, body, db, world.keeper)
    out = router.update_check_item(
        world.task.id, key,
        CheckItemUpdate(result="UNTESTABLE", note="屏碎了点不亮", evidence=["https://x/a.jpg"]), db, world.keeper,
    )
    assert out["result"] == "UNTESTABLE"


def test_template_edit_does_not_change_started_task(db, world):
    _start(db, world)
    before = [i.title for i in ops.check_items(db, world.task.id)]
    template = ops.match_template(db, world.order)
    template.steps = [{"key": "x", "title": "新项"}]
    db.commit()
    assert [i.title for i in ops.check_items(db, world.task.id)] == before


def test_exception_keeps_task_pending_and_notifies_immediately(db, world):
    out = router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    db.refresh(world.task)
    assert world.task.status == InspectionStatus.PENDING
    assert _targets(db, "NOTIFY_HANDLER") == {world.handler.id}
    assert _targets(db, "NOTIFY_PURCHASER") == {world.buyer.id}
    assert out["overdue"] is False
    assert len(router.my_notices(db, world.buyer)) == 1


def test_no_business_staff_falls_to_admin(db, world):
    world.handler.status = StaffStatus.DISABLED
    db.commit()
    router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    assert _targets(db, "NOTIFY_HANDLER") == {world.admin.id}


def test_any_business_staff_can_take_it_and_sales_cannot(db, world):
    other = _staff(db, "业务员二", StaffRole.BUSINESS)
    out = router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    assert _targets(db, "NOTIFY_HANDLER") == {world.handler.id, other.id}
    with pytest.raises(HTTPException):
        router.ack_exception(out["id"], db, world.seller)
    assert router.ack_exception(out["id"], db, other)["handler_name"] == "业务员二"
    assert len(router.list_exceptions(None, db, world.handler)) == 1


def test_overdue_escalates_once_and_only_after_due(db, world):
    router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    now = datetime.utcnow()
    assert ops.escalate_overdue(db, now + timedelta(minutes=9)) == 0
    assert ops.escalate_overdue(db, now + timedelta(minutes=11)) == 1
    assert ops.escalate_overdue(db, now + timedelta(minutes=12)) == 0
    assert _targets(db, "ESCALATE") == {world.admin.id}
    assert _targets(db, "REMIND") == {world.handler.id, world.buyer.id}


def test_handled_in_time_does_not_escalate(db, world):
    out = router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    router.ack_exception(out["id"], db, world.handler)
    router.submit_purchaser_evidence(out["id"], PurchaserEvidenceIn(evidence=["https://x/p.jpg"]), db, world.buyer)
    assert ops.escalate_overdue(db, datetime.utcnow() + timedelta(minutes=11)) == 0


def test_close_requires_goods_back_and_refund_result(db, world):
    out = router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    eid = out["id"]
    with pytest.raises(HTTPException):
        router.close_exception(eid, ExceptionClose(final_result="已退"), db, world.admin)
    router.update_progress(eid, ExceptionProgress(reject_status="RETURNED", refund_status="APPLIED"), db, world.admin)
    with pytest.raises(HTTPException):
        router.close_exception(eid, ExceptionClose(final_result="已退"), db, world.admin)
    with pytest.raises(HTTPException):
        router.update_progress(eid, ExceptionProgress(refund_status="RECEIVED"), db, world.admin)
    router.update_progress(eid, ExceptionProgress(refund_status="RECEIVED", refund_amount=Decimal("1000")), db, world.admin)
    with pytest.raises(HTTPException) as e:  # 标了已退回要有签收凭证
        router.close_exception(eid, ExceptionClose(final_result="已退"), db, world.admin)
    assert "签收" in e.value.detail
    router.update_progress(eid, ExceptionProgress(return_sign_evidence=["https://x/sign.jpg"]), db, world.admin)
    assert router.close_exception(eid, ExceptionClose(final_result="已退"), db, world.admin)["status"] == "CLOSED"


def test_other_purchaser_cannot_see_exception(db, world):
    out = router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    other = _staff(db, "别的采购", StaffRole.PURCHASER)
    with pytest.raises(HTTPException) as e:
        router.exception_events(out["id"], db, other)
    assert e.value.status_code == 404
    assert router.list_exceptions(None, db, other) == []


def _sku(db, w):
    sku = Sku(
        sku_code="A001", serial_number="S1", purchase_order_id=w.order.id, inspection_id=w.task.id,
        product_name="显示器", cost_price=Decimal("1000"), suggest_price=Decimal("1200"), status=SkuStatus.IN_STOCK,
    )
    db.add(sku)
    db.commit()
    return sku


def test_review_gate_only_for_shipping_types_when_on(db, world):
    sku = _sku(db, world)
    assert ops.assert_outbound_reviewed(db, sku, "MANUAL") is None
    set_setting(db, ops.OUTBOUND_REVIEW_REQUIRED, "1", None)
    with pytest.raises(HTTPException):
        ops.assert_outbound_reviewed(db, sku, "MANUAL")
    assert ops.assert_outbound_reviewed(db, sku, "PICKUP") is None
    assert ops.assert_outbound_reviewed(db, sku, "SWITCH") is None


def test_review_without_video_needs_remark_and_is_consumable(db, world):
    sku = _sku(db, world)
    set_setting(db, ops.OUTBOUND_REVIEW_REQUIRED, "1", None)
    with pytest.raises(HTTPException):
        router.review_sku(sku.sku_code, ReviewIn(identity_code="A001"), db, world.seller)
    router.review_sku(sku.sku_code, ReviewIn(remark="老货没有开箱视频", identity_code="A001"), db, world.seller)
    review = ops.assert_outbound_reviewed(db, sku, "MANUAL")
    assert review.snapshot["has_unbox_video"] is False
    review.consumed_at = datetime.utcnow()
    db.commit()
    with pytest.raises(HTTPException):
        ops.assert_outbound_reviewed(db, sku, "MANUAL")


def test_evidence_follows_sku(db, world):
    sku = _sku(db, world)
    db.add(InspectionEvidence(
        inspection_id=world.task.id, purchase_order_id=world.order.id, kind="UNBOX_VIDEO",
        url="https://x/a.webm", recorded_by=world.keeper.id,
    ))
    db.commit()
    assert router.search_evidence("A001", db, world.buyer) == []
    ops.bind_evidence_to_sku(db, world.task.id, sku.id)
    db.commit()
    rows = router.search_evidence("A001", db, world.buyer)
    assert len(rows) == 1 and rows[0]["is_video"] is True
    assert router.search_evidence("PO1", db, world.buyer)[0]["id"] == rows[0]["id"]


def test_console_door_is_separate_from_admin_and_h5():
    from app.routers.auth import LOGIN_SURFACES

    assert LOGIN_SURFACES["admin"] == (StaffRole.ADMIN,)
    assert StaffRole.BUSINESS in LOGIN_SURFACES["console"]
    assert StaffRole.FINANCE not in LOGIN_SURFACES["console"]
    assert StaffRole.BUSINESS not in LOGIN_SURFACES["h5"]


def test_second_exception_appends_and_keeps_first_deadline(db, world):
    """同一单再点「发现异常」：追加到原异常，十分钟照第一次算，不重复通知。"""
    first = router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    again = router.raise_exception(world.task.id, ExceptionIn(exception_type="OTHER", description="少充电器"), db, world.keeper)
    assert again["id"] == first["id"] and again["due_at"] == first["due_at"]
    assert "少充电器" in again["description"]
    assert db.query(InspectionException).count() == 1
    assert db.query(InspectionExceptionEvent).filter(InspectionExceptionEvent.action == "NOTIFY_PURCHASER").count() == 1


def test_purchaser_evidence_appends_not_overwrites(db, world):
    out = router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    router.submit_purchaser_evidence(out["id"], PurchaserEvidenceIn(evidence=["https://x/1.jpg"]), db, world.buyer)
    first_at = db.get(InspectionException, out["id"]).purchaser_evidence_at
    router.submit_purchaser_evidence(out["id"], PurchaserEvidenceIn(evidence=["https://x/1.jpg", "https://x/2.jpg"]), db, world.buyer)
    row = db.get(InspectionException, out["id"])
    assert row.purchaser_evidence == ["https://x/1.jpg", "https://x/2.jpg"]
    assert row.purchaser_evidence_at == first_at


def test_wecom_delivery_records_what_really_happened(db, world):
    """绑了企微的发出去；没绑的照实记；失败带原因。页面那句话按这个说。"""
    world.handler.wecom_userid = "YeWuYuan"
    world.buyer.wecom_userid = "CaiGou"
    db.commit()
    out = router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    assert out["notice"] == "2 人正在发"
    sent = []

    def sender(userid, content):
        sent.append(userid)
        return (True, "企微已发出") if userid == "YeWuYuan" else (False, "企微拒绝：服务器 IP 不在应用的可信 IP 里")

    assert ops.deliver_pending(db, sender=sender) == 1
    assert sorted(sent) == ["CaiGou", "YeWuYuan"]
    assert ops.deliver_pending(db, sender=sender) == 0  # 不重复发
    notice = router.read_check(world.task.id, db, world.keeper)["exceptions"][0]["notice"]
    assert notice == "企微已发出 1 人；1 人发送失败（企微拒绝：服务器 IP 不在应用的可信 IP 里），会自动重试"


def test_no_wecom_account_is_said_plainly(db, world):
    router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    ops.deliver_pending(db, sender=lambda *_: pytest.fail("没绑企微不该调接口"))
    notice = router.read_check(world.task.id, db, world.keeper)["exceptions"][0]["notice"]
    assert notice == "2 人没绑钉钉或企微，只有站内待办"


def _put(db, w, key, result, note=None, ev=("https://x/a.jpg",), who=None):
    return router.update_check_item(w.task.id, key, CheckItemUpdate(result=result, note=note, evidence=list(ev)), db, who or w.keeper)


def test_untestable_is_not_full_check_and_can_be_retested_after_submit(db, world):
    _start(db, world)
    items = ops.check_items(db, world.task.id)
    _finish_all(db, world)
    _put(db, world, items[0].item_key, "UNTESTABLE", "没有测试用的信号源")
    ops.assert_ready_to_submit(db, world.task, world.order)  # 可以先提交
    state = ops.full_check_state(ops.check_items(db, world.task.id))
    assert state["state"] == "RETEST" and state["retest"] == [items[0].title]
    world.task.status = InspectionStatus.DONE
    db.commit()
    assert router.list_retests(db, world.keeper)["total"] == 0, "没入库（拒签 / 没到货）的不用补测"
    from decimal import Decimal
    from app.enums import SkuStatus
    from app.models import Sku
    sku = Sku(sku_code="RT1", product_name="显示器", purchase_order_id=world.order.id, inspection_id=world.task.id,
              cost_price=Decimal("1"), status=SkuStatus.IN_STOCK)
    db.add(sku)
    db.commit()
    assert router.list_retests(db, world.keeper)["items"][0]["inspect_no"] == "IN1"
    sku.status = SkuStatus.SHIPPED
    db.commit()
    assert router.list_retests(db, world.keeper)["total"] == 0, "出库了补测不了"
    sku.status = SkuStatus.IN_STOCK
    db.commit()
    # 提交后只能补测「无法测试」的项，且只能补成通过/不通过
    with pytest.raises(HTTPException):
        _put(db, world, items[1].item_key, "FAIL", "改个别的")
    with pytest.raises(HTTPException):
        _put(db, world, items[0].item_key, "UNTESTABLE", "还是测不了")
    _put(db, world, items[0].item_key, "PASS")
    assert ops.full_check_state(ops.check_items(db, world.task.id))["state"] == "COMPLETE"
    assert router.list_retests(db, world.keeper)["total"] == 0
    log = db.query(InspectionCheckItemLog).filter(InspectionCheckItemLog.action == "RETEST").one()
    assert (log.old_result, log.new_result) == ("UNTESTABLE", "PASS")


def test_changing_an_answer_is_logged_and_flags_later_items(db, world):
    _start(db, world)
    _finish_all(db, world)
    items = ops.check_items(db, world.task.id)
    first, later = items[0], items[1]
    # 让后面那项的填写时间早于改答案
    later.checked_at = datetime.utcnow() - timedelta(minutes=5)
    db.commit()
    _put(db, world, first.item_key, "FAIL", "屏幕有亮点")
    out = router.read_check(world.task.id, db, world.keeper)
    by_key = {i["item_key"]: i for i in out["items"]}
    assert by_key[first.item_key]["changed_times"] == 1
    assert "请复核" in (by_key[later.item_key]["review_hint"] or "")
    assert out["history"][0]["from"] == "通过" and out["history"][0]["to"] == "不通过"
    assert out["full_check"]["state"] == "COMPLETE"


def test_dingtalk_first_then_wecom_and_failed_retries(db, world, monkeypatch):
    from app.services import dingtalk, staff_notify
    monkeypatch.setattr(dingtalk, "configured", lambda: True)
    world.handler.dingtalk_userid = "ding-yw"  # 后台关联的钉钉成员
    world.handler.wecom_userid = "YeWuYuan"           # 有钉钉就不走企微
    world.buyer.wecom_userid = "CaiGou"
    db.commit()
    router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)
    ding, wx = [], []

    def ding_sender(ids, title, md, url, button):
        ding.append((ids, url))
        return False, "钉钉返回 无权限"

    ops.deliver_pending(db, ding_sender=ding_sender, sender=lambda uid, c: (wx.append(uid), (True, "企微已发出"))[1])
    assert ding == [(["ding-yw"], ops.EXCEPTIONS_URL)] and wx == ["CaiGou"]
    # 失败的 2 分钟后重试，成功后不再发
    ev = db.query(InspectionExceptionEvent).filter(InspectionExceptionEvent.channel_status == "FAILED").one()
    assert ev.channel_attempts == 1
    ev.channel_at = datetime.utcnow() - timedelta(minutes=3)
    db.commit()
    ops.deliver_pending(db, ding_sender=lambda *a: (True, "ok"), sender=lambda *a: pytest.fail("企微成功的不该重发"))
    db.refresh(ev)
    assert ev.channel_status == "SENT" and ev.channel_detail == "钉钉已发出" and ev.channel_attempts == 2
    notice = router.read_check(world.task.id, db, world.keeper)["exceptions"][0]["notice"]
    assert notice == "已发出 2 人（钉钉 1 人、企微 1 人）"


def test_staff_notify_plain_when_nothing_bound(db, world):
    from app.services import staff_notify
    assert staff_notify.send(world.seller, "t", "b") == (staff_notify.NO_ACCOUNT, "没绑钉钉或企微，只有站内待办")


def test_review_checks_identity_and_problem_blocks_until_reviewed_ok(db, world, monkeypatch):
    from app.schemas.inspection_ops import ReviewItemCheck
    from app.services import staff_notify
    sent = []
    monkeypatch.setattr(staff_notify, "send", lambda staff, title, body, **kw: sent.append(staff.id) or ("SENT", "ok"))
    sku = _sku(db, world)
    with pytest.raises(HTTPException) as e:
        router.review_sku(sku.sku_code, ReviewIn(remark="x", identity_code="B999"), db, world.seller)
    assert "对不上" in e.value.detail
    with pytest.raises(HTTPException):
        router.review_sku(sku.sku_code, ReviewIn(result="PROBLEM", identity_code="s1"), db, world.seller)  # 要写问题
    out = router.review_sku(sku.sku_code, ReviewIn(result="PROBLEM", remark="边框新磕了一块", identity_code="s1",
                                                    media=["https://x/now.jpg"]), db, world.seller)
    # 管理员 + 原采购员都要收到（WH10-06）
    assert set(sent) == {world.admin.id, world.buyer.id}
    # 开关关着也拦
    with pytest.raises(HTTPException) as e:
        ops.assert_outbound_reviewed(db, sku, "MANUAL")
    assert "新问题" in e.value.detail
    assert router.outbound_problems(db, world.seller)["items"][0]["remark"] == "边框新磕了一块"
    assert out["reviews"][0]["state"] == "待处理"
    with pytest.raises(HTTPException, match="放行要写明"):
        router.review_sku(sku.sku_code, ReviewIn(remark="ok", identity_code="A001"), db, world.seller)
    sent.clear()
    out = router.review_sku(sku.sku_code, ReviewIn(remark="已和买家说明磕痕，买家同意", identity_code="A001"), db, world.seller)
    assert [r["state"] for r in out["reviews"]] == ["待出库", "已处理"]
    assert set(sent) == {world.admin.id, world.buyer.id}, "放行告诉管理员和采购"
    assert ops.assert_outbound_reviewed(db, sku, "MANUAL").result == "OK"
    assert router.outbound_problems(db, world.seller)["total"] == 0

    # 入库瑕疵逐项比对：FAIL 项必须勾；WORSE/NEW 只能走 PROBLEM；管理员也能复核
    _start(db, world)
    items = ops.check_items(db, world.task.id)
    _finish_all(db, world)
    _put(db, world, items[0].item_key, "FAIL", "边框磕痕")
    sku2 = Sku(
        sku_code="A002", serial_number="S2", purchase_order_id=world.order.id, inspection_id=world.task.id,
        product_name="显示器", cost_price=Decimal("1000"), suggest_price=Decimal("1200"), status=SkuStatus.IN_STOCK,
    )
    db.add(sku2)
    db.commit()
    with pytest.raises(HTTPException) as e:
        router.review_sku(sku2.sku_code, ReviewIn(remark="ok", identity_code="A002"), db, world.admin)
    assert "逐项比对" in e.value.detail
    with pytest.raises(HTTPException) as e:
        router.review_sku(
            sku2.sku_code,
            ReviewIn(
                remark="ok", identity_code="A002",
                item_checks=[ReviewItemCheck(item_key=items[0].item_key, status="WORSE")],
            ),
            db, world.admin,
        )
    assert "发现新问题" in e.value.detail
    out = router.review_sku(
        sku2.sku_code,
        ReviewIn(
            remark="磕痕和入库时一样", identity_code="A002",
            item_checks=[ReviewItemCheck(item_key=items[0].item_key, status="SAME")],
        ),
        db, world.admin,
    )
    assert out["pending_review"]["result"] == "OK"
    assert out["reviews"][0]["state"] == "待出库"


def test_step_tutorial_video_follows_current_template(db, world):
    _start(db, world)
    tpl = db.query(InspectionTemplate).filter(InspectionTemplate.id == ops.check_items(db, world.task.id)[0].template_id).one()
    steps = [dict(s) for s in tpl.steps]
    steps[0]["video_url"] = "https://x/tutorial.mp4"
    steps[0]["standard"] = "包装六面无破损为合格"
    tpl.steps = steps
    db.commit()
    first = router.read_check(world.task.id, db, world.keeper)["items"][0]
    assert first["video_url"] == "https://x/tutorial.mp4" and first["standard"] == "包装六面无破损为合格"


def test_return_logistics_and_refund_reconcile(db, world, monkeypatch):
    from app.services import staff_notify
    sent = []
    monkeypatch.setattr(staff_notify, "send", lambda staff, title, body, **kw: sent.append(title) or ("SENT", "ok"))
    eid = router.raise_exception(world.task.id, ExceptionIn(exception_type="MISMATCH", description="型号不对"), db, world.keeper)["id"]
    with pytest.raises(HTTPException):  # 没单号和承运方不能跟踪运输
        router.update_progress(eid, ExceptionProgress(return_logistics="IN_TRANSIT"), db, world.admin)
    router.update_progress(eid, ExceptionProgress(reject_status="RETURNING", return_tracking_no="SF1", return_carrier="顺丰",
                                                  return_station="杭州西湖网点", return_logistics="IN_TRANSIT"), db, world.admin)
    out = router.update_progress(eid, ExceptionProgress(return_logistics="ABNORMAL", note="快递显示退回途中丢件"), db, world.admin)
    assert out["needs_takeover"] and sent == ["退回物流异常，需要接管"]
    router.update_progress(eid, ExceptionProgress(return_logistics="SIGNED", reject_status="RETURNED",
                                                  return_sign_evidence=["https://x/sign.jpg"]), db, world.admin)
    # 采购 1000：只到账 900、扣费 50，差 50 要写原因
    router.update_progress(eid, ExceptionProgress(refund_status="PARTIAL", refund_amount=Decimal("900"), refund_fee=Decimal("50")), db, world.admin)
    with pytest.raises(HTTPException) as e:
        router.close_exception(eid, ExceptionClose(final_result="部分退款"), db, world.admin)
    assert "差额" in e.value.detail
    router.update_progress(eid, ExceptionProgress(refund_shortfall_reason="卖家扣了 50 元包装损坏费，主管已复核同意"), db, world.admin)
    assert router.close_exception(eid, ExceptionClose(final_result="部分退款结案"), db, world.admin)["status"] == "CLOSED"


def test_close_waits_for_full_check(db, world):
    _start(db, world)
    eid = router.raise_exception(world.task.id, ExceptionIn(exception_type="DAMAGED", description="屏碎"), db, world.keeper)["id"]
    router.update_progress(eid, ExceptionProgress(reject_status="NOT_NEEDED", refund_status="NOT_NEEDED"), db, world.admin)
    with pytest.raises(HTTPException) as e:
        router.close_exception(eid, ExceptionClose(final_result="留货"), db, world.admin)
    assert "全检" in e.value.detail
    _finish_all(db, world)
    assert router.close_exception(eid, ExceptionClose(final_result="留货"), db, world.admin)["status"] == "CLOSED"


def test_evidence_dedup_verify_and_gap(db, world, monkeypatch):
    from app.schemas.inspection_ops import EvidenceIn
    monkeypatch.setattr(ops, "check_uploaded", lambda url, size: "文件只传了一部分（10/20 字节），请重试上传" if size == 20 else None)
    _start(db, world)
    assert router.read_check(world.task.id, db, world.keeper)["unbox_gap"].startswith("没有开箱视频")
    with pytest.raises(HTTPException):
        router.add_evidence(world.task.id, EvidenceIn(kind="UNBOX_VIDEO", url="https://x/v.mp4", size_bytes=20), db, world.keeper)
    body = EvidenceIn(kind="UNBOX_VIDEO", url="https://x/v.mp4", size_bytes=10, started_at="2026-11-08T10:00:00+08:00",
                      interrupted=True, gap_note="摄像头 USB 松了")
    a = router.add_evidence(world.task.id, body, db, world.keeper)
    b = router.add_evidence(world.task.id, body, db, world.keeper)  # 重试登记不重复
    assert a["id"] == b["id"] and db.query(InspectionEvidence).count() == 1
    assert a["started_at"].startswith("2026-11-08T10:00") and a["interrupted"]
    assert "中断" in router.read_check(world.task.id, db, world.keeper)["unbox_gap"]


def test_defect_part_and_seller_claim_reach_purchaser(db, world):
    _start(db, world)
    _finish_all(db, world)
    key = ops.check_items(db, world.task.id)[0].item_key
    router.update_check_item(world.task.id, key, CheckItemUpdate(result="FAIL", note="右下角亮点", evidence=["https://x/d.jpg"],
                                                                 defect_part="屏幕右下角", seller_claim="卖家说屏幕完美无坏点"), db, world.keeper)
    out = router.order_inspection("PO1", db, world.buyer)
    assert [(i["defect_part"], i["seller_claim"]) for i in out["items"]] == [("屏幕右下角", "卖家说屏幕完美无坏点")]
    # 改成通过，部位和卖家描述清掉
    router.update_check_item(world.task.id, key, CheckItemUpdate(result="PASS", evidence=["https://x/d.jpg"], defect_part="x"), db, world.keeper)
    assert router.order_inspection("PO1", db, world.buyer)["items"] == []


def test_demo_templates_match_real_product_names(db):
    """11 月实际收货的写法：显示器多只写型号，小米净化器不能配到手机上。"""
    from app.services.inspection_templates_demo import DEMO_TEMPLATES

    db.query(InspectionTemplate).delete()
    for data in DEMO_TEMPLATES:
        db.add(InspectionTemplate(**data, version=1, enabled=True))
    db.commit()
    cases = {
        "aoc 24g10ze": "显示器", "HKCg24h3s": "显示器", "泰坦军团p2510hplus": "显示器",
        "小米空气净化器4": "空气净化器", "sonos play5": "音箱", "毒蝰v3p": "鼠标", "gpw3": "鼠标",
        "wootinghe60 磁玉轴体": "键盘", "5070": "显卡", "全新卡农智能墙壁开关z1双键版": "智能家居",
        "小米多模智能网关2": "智能家居",
    }
    for name, category in cases.items():
        order = SimpleNamespace(product_name=name, brand=None, model=None)
        assert ops.match_template(db, order).category == category, name


def test_seed_demo_only_adds_missing(db, world):
    admin = world.admin
    router.seed_demo_templates(db=db, _=admin)
    assert router.seed_demo_templates(db=db, _=admin)["count"] == 0
    db.query(InspectionTemplate).filter(InspectionTemplate.name == "示例：音箱").delete()
    db.commit()
    assert router.seed_demo_templates(db=db, _=admin)["names"] == ["示例：音箱"]


def test_worse_item_can_ship_after_reported_without_lying(db, world, monkeypatch):
    """更差的项先报「发现新问题」；报过之后处理好了（买家同意）照实填「更严重」也能放行，不用改选「一样」。"""
    from app.schemas.inspection_ops import ReviewItemCheck
    from app.services import staff_notify
    monkeypatch.setattr(staff_notify, "send", lambda *a, **kw: ("SENT", "ok"))
    _start(db, world)
    items = ops.check_items(db, world.task.id)
    _finish_all(db, world)
    _put(db, world, items[0].item_key, "FAIL", "边框磕痕")
    sku = Sku(sku_code="W001", serial_number="SW", purchase_order_id=world.order.id, inspection_id=world.task.id,
              product_name="显示器", cost_price=Decimal("1000"), suggest_price=Decimal("1200"), status=SkuStatus.IN_STOCK)
    db.add(sku)
    db.commit()
    worse = [ReviewItemCheck(item_key=items[0].item_key, status="WORSE")]
    with pytest.raises(HTTPException, match="发现新问题"):
        router.review_sku("W001", ReviewIn(remark="ok", identity_code="W001", item_checks=worse), db, world.seller)
    router.review_sku("W001", ReviewIn(result="PROBLEM", remark="磕痕变大了", identity_code="W001", item_checks=worse), db, world.seller)
    out = router.review_sku("W001", ReviewIn(remark="拍给买家看过，买家同意照发", identity_code="W001", item_checks=worse),
                            db, world.seller)
    assert out["pending_review"]["result"] == "OK"
