"""一张采购单多件、分次到货（禅道 WH01-04，方案 A）。
这里钉死的口径：
  1. 建单带件数就每件一张验货单；成交金额按件均摊，分不尽的几分钱算在最后一件。
  2. 还有件没验，采购单就一直是待验货；验完后有货在库就是在库，全拒签/没到就是取消。
  3. 每件入库各出一个 SKU，凭证、复验按这件自己的验货单找，不串到别的件上。
  4. 没到的件标「没到货」：不算验货计件，按这件金额开退款跟踪，不用退回。
  5. 一件都没验时才能改件数；减件不能减掉已经开始验的那件。
  6. 一单一件的老单什么都不变。
"""
from datetime import datetime
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import InspectionActionType, InspectionStatus, OrderStatus, SkuStatus, StaffRole, StaffStatus
from app.models import (
    EventLog,
    Inspection,
    InspectionEvidence,
    InspectionException,
    PurchaseOrder,
    Sku,
    Staff,
)
from app.routers import inspection as insp_router
from app.routers import inspection_ops as ops_router
from app.routers import purchase as purchase_router
from app.schemas.inspection import InspectionSubmit
from app.schemas.purchase import PurchaseOrderCreate, PurchasePiecesMissingIn, PurchaseQuantityIn
from app.services import purchase_pieces, return_recheck
from app.services.commission import compute_commission



@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)  # 建单、验货牵扯的表多（物流缓存、资产、标签），全建上
    # 和生产一样不开 autoflush：状态同步要自己 flush 才查得到刚改的 SKU
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
    return _staff(db, "采购", StaffRole.PURCHASER), _staff(db, "仓管", StaffRole.WAREHOUSE), _staff(db, "管理员", StaffRole.ADMIN)


def _create(db, buyer, quantity=1, price="100.00"):
    ext_no = f"X{db.query(PurchaseOrder).count() + 1}"
    body = PurchaseOrderCreate(
        brand="罗技", model="G304", unit_price=Decimal(price), external_order_no=ext_no, transaction_no="T1",
        tracking_no="SF1", order_time=datetime(2026, 11, 9, 9), paid_at=datetime(2026, 11, 9, 9), purchase_account="A",
        seller_name="卖家", product_images=["https://x/p.jpg"], quantity=quantity,
    )
    out = purchase_router.create_order(body, db, buyer)
    return db.get(PurchaseOrder, out.id)


def _task(db, order, piece_no):
    return db.query(Inspection).filter(Inspection.purchase_order_id == order.id, Inspection.piece_no == piece_no).one()


def _inbound(db, order, piece_no, keeper, code):
    body = InspectionSubmit(listing_images=["https://x/l.jpg"], inspection_result="PASSED", sku_code=code,
                            serial_number=f"SN-{code}", location_code="A-1", condition_grade="A")
    return insp_router.submit_inspection(_task(db, order, piece_no).id, body, db, keeper)


def _reject(db, order, piece_no, keeper):
    body = InspectionSubmit(action_type="REJECT", remark="碎了")
    return insp_router.submit_inspection(_task(db, order, piece_no).id, body, db, keeper)


def test_create_with_quantity_makes_one_task_per_piece(db, people):
    buyer, *_ = people
    order = _create(db, buyer, quantity=3)
    tasks = purchase_pieces.tasks_of(db, order)
    assert [t.piece_no for t in tasks] == [1, 2, 3]
    assert len({t.inspect_no for t in tasks}) == 3
    assert [purchase_pieces.piece_cost(order, n) for n in (1, 2, 3)] == [Decimal("33.33"), Decimal("33.33"), Decimal("33.34")]


def test_order_stays_pending_until_every_piece_done(db, people):
    buyer, keeper, _ = people
    order = _create(db, buyer, quantity=3)
    _inbound(db, order, 1, keeper, "S1")
    db.refresh(order)
    assert order.status == OrderStatus.PENDING_INSPECT
    sku1 = db.query(Sku).filter(Sku.sku_code == "S1").one()
    assert sku1.cost_price == Decimal("33.33") and sku1.inspection_id == _task(db, order, 1).id
    _reject(db, order, 2, keeper)
    db.refresh(order)
    assert order.status == OrderStatus.PENDING_INSPECT  # 第 3 件还没到
    _inbound(db, order, 3, keeper, "S3")
    db.refresh(order)
    assert order.status == OrderStatus.IN_STOCK
    assert db.query(Sku).filter(Sku.sku_code == "S3").one().cost_price == Decimal("33.34")
    # 列表和详情标出第几件、显示这件摊到的金额
    item = insp_router._inspection_list_item(_task(db, order, 2), order, {})
    assert item.piece_label == "第 2/3 件" and item.unit_price == Decimal("33.33")


def test_all_rejected_cancels_and_sold_out_ships(db, people):
    buyer, keeper, _ = people
    order = _create(db, buyer, quantity=2)
    _reject(db, order, 1, keeper)
    _reject(db, order, 2, keeper)
    db.refresh(order)
    assert order.status == OrderStatus.CANCELLED

    order = _create(db, buyer, quantity=2)
    _inbound(db, order, 1, keeper, "A1")
    _inbound(db, order, 2, keeper, "A2")
    a1, a2 = (db.query(Sku).filter(Sku.sku_code == c).one() for c in ("A1", "A2"))
    a1.status = SkuStatus.SHIPPED
    purchase_pieces.sync_order_status(db, order)
    assert order.status == OrderStatus.IN_STOCK  # 还有一件在库
    a2.status = SkuStatus.SHIPPED
    purchase_pieces.sync_order_status(db, order)
    assert order.status == OrderStatus.SHIPPED


def test_missing_piece_tracks_refund_and_is_not_paid_as_inspection(db, people):
    buyer, keeper, admin = people
    order = _create(db, buyer, quantity=3, price="300.00")
    _inbound(db, order, 1, keeper, "M1")
    _inbound(db, order, 2, keeper, "M2")
    with pytest.raises(HTTPException, match="写明情况"):
        purchase_router.mark_piece_missing(order.id, 3, PurchasePiecesMissingIn(reason=" "), db, keeper)
    out = purchase_router.mark_piece_missing(order.id, 3, PurchasePiecesMissingIn(reason="卖家说只剩 2 件"), db, keeper)
    assert out["status"] == OrderStatus.IN_STOCK and out["arrived"] == 2 and out["missing"] == 1
    assert out["pieces"][2]["state"] == "没到货" and out["pieces"][2]["refund_status"] == "PENDING"
    exc = db.query(InspectionException).filter(InspectionException.inspection_id == _task(db, order, 3).id).one()
    assert exc.exception_type == "MISSING" and exc.reject_status == "NOT_NEEDED" and exc.refund_amount == Decimal("100.00")
    assert "第 3/3 件没到货" in exc.description
    with pytest.raises(HTTPException, match="已经处理过了"):
        purchase_router.mark_piece_missing(order.id, 3, PurchasePiecesMissingIn(reason="再标一次"), db, keeper)
    # 验货计件只算真验了的两件
    assert compute_commission(db, keeper, "today").detail["inspection_count"] == 2


def test_cannot_hand_raise_missing_exception(db, people):
    buyer, keeper, _ = people
    order = _create(db, buyer, quantity=2)
    from app.schemas.inspection_ops import ExceptionIn

    with pytest.raises(HTTPException, match="异常类型不正确"):
        ops_router.raise_exception(_task(db, order, 1).id, ExceptionIn(exception_type="MISSING", description="x"), db, keeper)


def test_set_quantity_rules(db, people):
    buyer, keeper, admin = people
    order = _create(db, buyer, quantity=1)
    out = purchase_router.set_quantity(order.id, PurchaseQuantityIn(quantity=3), db, keeper)
    assert out["quantity"] == 3 and [p["piece_no"] for p in out["pieces"]] == [1, 2, 3]
    assert db.query(EventLog).filter(EventLog.entity_id == order.id).count() == 1
    # 第 3 件已经开始验（拍了开箱视频）就不能减掉
    t3 = _task(db, order, 3)
    db.add(InspectionEvidence(inspection_id=t3.id, purchase_order_id=order.id, kind="UNBOX_VIDEO", url="https://x/v.mp4",
                              recorded_by=keeper.id))
    db.commit()
    with pytest.raises(HTTPException, match="第 3 件已经开始验了"):
        purchase_router.set_quantity(order.id, PurchaseQuantityIn(quantity=2), db, keeper)
    with pytest.raises(HTTPException, match="件数要在 1 到 50"):
        purchase_router.set_quantity(order.id, PurchaseQuantityIn(quantity=0), db, keeper)
    _inbound(db, order, 1, keeper, "Q1")
    with pytest.raises(HTTPException, match="已经有件验过了"):
        purchase_router.set_quantity(order.id, PurchaseQuantityIn(quantity=4), db, keeper)
    # 采购员只能动自己的单
    other = _staff(db, "别的采购", StaffRole.PURCHASER)
    with pytest.raises(HTTPException, match="无权查看"):
        purchase_router.list_pieces(order.id, db, other)


def test_evidence_and_recheck_follow_own_piece(db, people):
    buyer, keeper, _ = people
    order = _create(db, buyer, quantity=2)
    t1, t2 = _task(db, order, 1), _task(db, order, 2)
    for t, url in ((t1, "https://x/v1.mp4"), (t2, "https://x/v2.mp4")):
        db.add(InspectionEvidence(inspection_id=t.id, purchase_order_id=order.id, kind="UNBOX_VIDEO", url=url, recorded_by=keeper.id))
    db.commit()
    _inbound(db, order, 1, keeper, "E1")
    _inbound(db, order, 2, keeper, "E2")
    page = ops_router.order_inspection(order.order_no, db, keeper, piece=2)
    assert page["piece_no"] == 2 and [p["label"] for p in page["pieces"]] == ["第 1/2 件", "第 2/2 件"]
    assert [e["url"].split("?")[0] for e in page["evidence"]] == ["https://x/v2.mp4"]
    assert page["sku_code"] == "E2"
    sku2 = db.query(Sku).filter(Sku.sku_code == "E2").one()
    assert return_recheck._inspection_of(db, sku2).id == t2.id


def test_single_piece_order_unchanged(db, people):
    buyer, keeper, _ = people
    order = _create(db, buyer)
    assert order.quantity == 1 and len(purchase_pieces.tasks_of(db, order)) == 1
    item = insp_router._inspection_list_item(_task(db, order, 1), order, {})
    assert item.piece_label is None and item.unit_price == Decimal("100.00")
    _inbound(db, order, 1, keeper, "ONE")
    db.refresh(order)
    assert order.status == OrderStatus.IN_STOCK
    with pytest.raises(HTTPException, match="一单一件"):
        purchase_router.mark_piece_missing(order.id, 1, PurchasePiecesMissingIn(reason="x"), db, keeper)
    assert _task(db, order, 1).action_type == InspectionActionType.INBOUND
    assert _task(db, order, 1).status == InspectionStatus.DONE
