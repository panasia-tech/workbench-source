"""完整主链路冒烟：议价(PC-090) → 建采购单 → 验货/拒签字段 → 入库 → 出库复核拦/放行。"""
from datetime import datetime
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
    BargainSession,
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
    Sku,
    Staff,
)
from app.routers import inspection as insp_router
from app.routers import inspection_ops as ops_router
from app.routers import purchase as purchase_router
from app.schemas.inspection import InspectionSubmit
from app.schemas.inspection_ops import (
    CheckItemUpdate,
    CheckStart,
    ExceptionIn,
    ExceptionProgress,
    ReviewIn,
    ReviewItemCheck,
)
from app.schemas.purchase import PurchaseOrderCreate
from app.services import bargain as bargain_svc
from app.services import inspection_ops as ops
from app.services import purchase_snapshot as snap
from app.services.inspection_templates_demo import DEMO_TEMPLATES


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    monkeypatch.setattr(purchase_router, "is_valid_purchase_account", lambda db, acc: True)
    monkeypatch.setattr(purchase_router, "detect_overdue_by_express", lambda *a, **k: False)
    monkeypatch.setattr(purchase_router.condition_scan, "enqueue", lambda *a, **k: None)
    from app.services import oa_push

    monkeypatch.setattr(oa_push, "on_inspection_done", lambda db, inspection: [])
    yield session
    session.close()


def _staff(db, name, role):
    row = Staff(staff_no=name, username=name, name=name, role=role, status=StaffStatus.ACTIVE, password_hash="x")
    db.add(row)
    db.flush()
    return row


@pytest.fixture()
def people(db):
    admin = _staff(db, "管理员", StaffRole.ADMIN)
    buyer = _staff(db, "采购", StaffRole.PURCHASER)
    keeper = _staff(db, "仓管", StaffRole.WAREHOUSE)
    seller = _staff(db, "销售", StaffRole.SALES)
    db.add_all(InspectionTemplate(**t, version=1, enabled=True) for t in DEMO_TEMPLATES)
    db.commit()
    return SimpleNamespace(admin=admin, buyer=buyer, keeper=keeper, seller=seller)


def test_full_flow_bargain_purchase_inspect_outbound(db, people, monkeypatch):
    from app.services import staff_notify

    sent = []
    monkeypatch.setattr(
        staff_notify, "send",
        lambda staff, title, body, **kw: sent.append((staff.id, title)) or ("SENT", "ok"),
    )

    # ---- 1) 开议价 + 绑群控 ----
    session = bargain_svc.open_session(
        db, user_id=people.buyer.id,
        platform_item_id="item-flow-1", purchase_account="店A",
        seller_name="卖家甲", title="戴尔 U2720Q", listed_price=Decimal("1500"),
        gc_conversation_id="conv-flow-1",
        source_url="https://www.goofish.com/item?id=item-flow-1",
    )
    db.commit()
    assert session.state == "IDENTIFY"
    assert session.gc_conversation_id == "conv-flow-1"
    assert len(bargain_svc.pending_required(session)) >= 5

    # ---- 2) PC-090 必要问题待核；未核不能谈妥 ----
    bargain_svc.transition(db, session, action="quote", price=Decimal("1200"), user_id=people.buyer.id)
    with pytest.raises(HTTPException, match="必要问题待核"):
        bargain_svc.transition(db, session, action="deal", price=Decimal("1180"), user_id=people.buyer.id)

    bargain_svc.update_check(
        session, key="accessories", status="DECLARED",
        note="卖家说原装盒电源都在", user_id=people.buyer.id,
    )
    for c in bargain_svc.checks_of(session):
        if c.get("required") and c["key"] != "accessories":
            bargain_svc.update_check(session, key=c["key"], status="VERIFIED", note="已核", user_id=people.buyer.id)
    bargain_svc.update_check(session, key="shipping", status="SKIPPED", note="包邮", user_id=people.buyer.id)
    assert bargain_svc.pending_required(session) == []

    bargain_svc.transition(db, session, action="deal", price=Decimal("1180"), user_id=people.buyer.id)
    db.commit()
    assert session.state == "DEAL" and session.deal_price == Decimal("1180")

    # ---- 3) 建采购单并绑议价 + 快照冻结 ----
    body = PurchaseOrderCreate(
        brand="戴尔", model="U2720Q 显示器", unit_price=Decimal("1180"),
        external_order_no="XY-FLOW-1", transaction_no="T-FLOW-1",
        tracking_no="SF10086", order_time=datetime(2026, 11, 12, 10),
        paid_at=datetime(2026, 11, 12, 10), purchase_account="店A",
        seller_name="卖家甲", product_images=["https://x/p.jpg"], quantity=1,
        bargain_session_id=session.id,
        platform_item_id="item-flow-1",
        source_url="https://www.goofish.com/item?id=item-flow-1",
        snapshot_title="戴尔 U2720Q 显示器",
    )
    out = purchase_router.create_order(body, db, people.buyer)
    order = db.get(PurchaseOrder, out.id)
    db.refresh(session)
    assert order is not None and session.purchase_order_id == order.id
    snaps = snap.list_versions(db, order.id)
    assert snaps and snaps[0].frozen_at is not None

    # ---- 4) 验货：逐项 + 瑕疵部位；异常记承运/网点 ----
    task = db.query(Inspection).filter(Inspection.purchase_order_id == order.id).one()
    ops_router.start_check(task.id, CheckStart(), db, people.keeper)
    items = ops.check_items(db, task.id)
    assert items
    fail_key = items[0].item_key
    for item in items[1:]:
        ops_router.update_check_item(
            task.id, item.item_key,
            CheckItemUpdate(result="PASS", evidence=["https://x/ok.jpg"]),
            db, people.keeper,
        )
    ops_router.update_check_item(
        task.id, fail_key,
        CheckItemUpdate(
            result="FAIL", note="边框磕痕", evidence=["https://x/d.jpg"],
            defect_part="右下边框", seller_claim="卖家说成色完美",
        ),
        db, people.keeper,
    )
    read = ops_router.read_check(task.id, db, people.keeper)
    assert any(i.get("defect_part") == "右下边框" for i in read["items"])

    exc = ops_router.raise_exception(
        task.id,
        ExceptionIn(exception_type="MISMATCH", description="成色不符，边框有磕"),
        db, people.keeper,
    )
    eid = exc["id"]
    prog = ops_router.update_progress(
        eid,
        ExceptionProgress(
            reject_status="RETURNING",
            return_tracking_no="SF999",
            return_carrier="顺丰",
            return_station="杭州西湖网点",
            return_logistics="IN_TRANSIT",
        ),
        db, people.admin,
    )
    assert prog["return_carrier"] == "顺丰" and prog["return_station"] == "杭州西湖网点"

    # ---- 5) 入库出 SKU ----
    insp_router.submit_inspection(
        task.id,
        InspectionSubmit(
            listing_images=["https://x/l.jpg"],
            inspection_result="PASSED",
            sku_code="FLOW1",
            serial_number="SN-FLOW1",
            location_code="A-1",
            condition_grade="B",
            defect_images=["https://x/d.jpg"],
        ),
        db, people.keeper,
    )
    sku = db.query(Sku).filter(Sku.sku_code == "FLOW1").one()
    assert sku.status == SkuStatus.IN_STOCK

    # ---- 6) 出库复核发现问题 → 拦出库 + 通知管理员和原采购 ----
    sent.clear()
    # 有 FAIL 项必须逐项比对；先用 PROBLEM 拦
    dossier = ops_router.review_sku(
        sku.sku_code,
        ReviewIn(
            result="PROBLEM",
            remark="出库前又发现新磕痕",
            identity_code="FLOW1",
            media=["https://x/now.jpg"],
            item_checks=[ReviewItemCheck(item_key=fail_key, status="WORSE")],
        ),
        db, people.seller,
    )
    assert dossier["reviews"][0]["state"] == "待处理"
    assert {sid for sid, _ in sent} == {people.admin.id, people.buyer.id}
    with pytest.raises(HTTPException, match="新问题"):
        ops.assert_outbound_reviewed(db, sku, "MANUAL")

    # ---- 7) 处理好后重新复核 OK → 可出库 ----
    ops_router.review_sku(
        sku.sku_code,
        ReviewIn(
            result="OK",
            remark="已与买家说明，同意发货",
            identity_code="FLOW1",
            item_checks=[ReviewItemCheck(item_key=fail_key, status="SAME")],
        ),
        db, people.seller,
    )
    ok = ops.assert_outbound_reviewed(db, sku, "MANUAL")
    assert ok.result == "OK"
