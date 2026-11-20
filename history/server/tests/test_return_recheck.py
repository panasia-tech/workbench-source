"""退回复验：照搬原验货检查项并带入库结果、不通过必须判发现问题、开关拦入库、发现问题一律只能挂起、历次影像按时间排。"""
from datetime import datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import InspectionStatus, OrderStatus, ReturnOrderStatus, SkuStatus, StaffRole, StaffStatus
from app.models import (
    AppSetting,
    Inspection,
    InspectionCheckItem,
    InspectionEvidence,
    InspectionTemplate,
    OutboundReview,
    PurchaseOrder,
    ReturnOrder,
    ReturnRecheck,
    SalesOutbound,
    Sku,
    Staff,
)
from app.routers import inspection_ops as router
from app.routers.returns import receive_return
from app.schemas.inspection_ops import RecheckFinishIn, RecheckItemIn
from app.schemas.returns import ReturnReceiveRequest
from app.services import return_recheck
from app.services.app_settings import set_setting

_TABLES = [
    m.__table__
    for m in (
        Staff, PurchaseOrder, Inspection, Sku, AppSetting, InspectionTemplate, InspectionCheckItem,
        InspectionEvidence, OutboundReview, SalesOutbound, ReturnOrder, ReturnRecheck,
    )
]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=_TABLES)
    session = sessionmaker(bind=engine, autoflush=True)()
    yield session
    session.close()


@pytest.fixture()
def world(db):
    keeper = Staff(staff_no="K", username="k", name="仓管", role=StaffRole.WAREHOUSE, status=StaffStatus.ACTIVE, password_hash="x")
    db.add(keeper)
    db.flush()
    order = PurchaseOrder(order_no="PO1", status=OrderStatus.SHIPPED, product_name="AOC 24G10ZE", unit_price=Decimal("500"),
                          created_by_id=keeper.id)
    db.add(order)
    db.flush()
    task = Inspection(inspect_no="IN1", purchase_order_id=order.id, status=InspectionStatus.DONE)
    db.add(task)
    db.flush()
    t0 = datetime(2026, 11, 1, 2, 0)
    db.add_all([
        InspectionCheckItem(inspection_id=task.id, item_key="panel", title="屏幕", sort_order=0, result="PASS",
                            need_photo=True, evidence=["https://x/panel.jpg"], checked_at=t0),
        InspectionCheckItem(inspection_id=task.id, item_key="stand", title="支架", sort_order=1, result="FAIL",
                            note="底座划痕", evidence=[], checked_at=t0),
    ])
    db.add(InspectionEvidence(inspection_id=task.id, purchase_order_id=order.id, kind="UNBOX_VIDEO",
                              url="https://x/unbox.mp4", recorded_by=keeper.id, created_at=t0 - timedelta(minutes=5)))
    sku = Sku(sku_code="S1", purchase_order_id=order.id, inspection_id=task.id, product_name=order.product_name,
              status=SkuStatus.SHIPPED, serial_number="SN1", cost_price=Decimal("500"))
    db.add(sku)
    db.flush()
    ret = ReturnOrder(return_no="RT1", sku_id=sku.id, sku_code="S1", product_name=sku.product_name,
                      status=ReturnOrderStatus.PENDING_INBOUND, reason_code="OTHER", reason="客户说不亮",
                      created_by_id=keeper.id, received_media=None)
    db.add(ret)
    db.commit()
    return SimpleNamespace(keeper=keeper, order=order, task=task, sku=sku, ret=ret, t0=t0)


def _receive(db, w, **kw):
    body = ReturnReceiveRequest(serial_number="SN1", condition="NORMAL", location_code="A-1", media=["https://x/r.jpg"], **kw)
    return receive_return(w.ret.id, body, db, w.keeper)


def _pass_all(db, w):
    for item in router.read_recheck(w.ret.id, db, w.keeper)["items"]:
        router.save_recheck_item(w.ret.id, item["key"], RecheckItemIn(result="PASS", evidence=["https://x/re.jpg"]), db, w.keeper)


def test_items_copy_original_inspection_with_before_results(db, world):
    out = router.start_recheck(world.ret.id, db, world.keeper)
    assert [(i["key"], i["before_result"]) for i in out["items"]] == [("panel", "PASS"), ("stand", "FAIL")]
    assert out["started"] and out["result"] is None
    assert router.start_recheck(world.ret.id, db, world.keeper)["started"]  # 重复点开始不重建
    assert db.query(ReturnRecheck).count() == 1


def test_no_original_items_falls_back_to_generic(db, world):
    db.query(InspectionCheckItem).delete()
    db.commit()
    out = router.start_recheck(world.ret.id, db, world.keeper)
    assert [i["key"] for i in out["items"]] == ["identity", "accessories", "appearance", "function"]


def test_finish_rules(db, world):
    router.start_recheck(world.ret.id, db, world.keeper)
    with pytest.raises(HTTPException, match="还有 2 项没验"):
        router.finish_recheck(world.ret.id, RecheckFinishIn(result="OK"), db, world.keeper)
    router.save_recheck_item(world.ret.id, "panel", RecheckItemIn(result="FAIL", note="新亮线", evidence=["https://x/line.jpg"]), db, world.keeper)
    router.save_recheck_item(world.ret.id, "stand", RecheckItemIn(result="PASS"), db, world.keeper)
    with pytest.raises(HTTPException, match="结论要选「发现问题」"):
        router.finish_recheck(world.ret.id, RecheckFinishIn(result="OK"), db, world.keeper)
    with pytest.raises(HTTPException, match="要写明"):
        router.finish_recheck(world.ret.id, RecheckFinishIn(result="PROBLEM"), db, world.keeper)
    out = router.finish_recheck(world.ret.id, RecheckFinishIn(result="PROBLEM", note="屏幕新亮线"), db, world.keeper)
    assert out["result"] == "PROBLEM" and out["finished_at"]
    with pytest.raises(HTTPException, match="不能再改"):
        router.save_recheck_item(world.ret.id, "panel", RecheckItemIn(result="PASS"), db, world.keeper)


def test_problem_blocks_restock_even_with_switch_off(db, world):
    router.start_recheck(world.ret.id, db, world.keeper)
    router.save_recheck_item(world.ret.id, "panel", RecheckItemIn(result="FAIL", note="新亮线", evidence=["https://x/line.jpg"]), db, world.keeper)
    router.save_recheck_item(world.ret.id, "stand", RecheckItemIn(result="PASS"), db, world.keeper)
    router.finish_recheck(world.ret.id, RecheckFinishIn(result="PROBLEM", note="屏幕新亮线"), db, world.keeper)
    with pytest.raises(HTTPException, match="只能标记异常挂起"):
        _receive(db, world)
    db.refresh(world.ret)
    assert world.ret.status == ReturnOrderStatus.PENDING_INBOUND
    out = _receive(db, world, mark_abnormal=True, abnormal_reason="复验发现屏幕新亮线")
    assert out.status == ReturnOrderStatus.ABNORMAL


def test_switch_on_requires_finished_recheck(db, world):
    set_setting(db, return_recheck.RETURN_RECHECK_REQUIRED, "1", world.keeper.id)
    db.commit()
    with pytest.raises(HTTPException, match="先在 H5「退回复验」验完"):
        _receive(db, world)
    router.start_recheck(world.ret.id, db, world.keeper)
    with pytest.raises(HTTPException, match="验完才能入库"):
        _receive(db, world)  # 开始了没做完一样拦
    _pass_all(db, world)
    router.finish_recheck(world.ret.id, RecheckFinishIn(result="OK"), db, world.keeper)
    return_recheck.assert_receivable(db, world.ret, False)  # 不再拦


def test_history_sorted_by_time(db, world):
    world.ret.received_media = ["https://x/r.jpg"]
    world.ret.received_at = world.t0 + timedelta(days=5)
    db.commit()
    router.start_recheck(world.ret.id, db, world.keeper)
    _pass_all(db, world)
    rows = router.sku_history("S1", db, world.keeper)["items"]
    assert [r["stage"] for r in rows] == ["入库验货", "入库验货", "退回收货", "退回复验", "退回复验"]
    assert rows[0]["is_video"] and rows[0]["label"] == "开箱视频"
    assert rows[0]["at"] == "2026-11-01T09:55:00"  # 北京时间
