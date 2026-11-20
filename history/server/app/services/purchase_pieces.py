"""一张采购单买了同一件商品好几件、分几次到（禅道 WH01-04，方案 A）。

- 采购单记件数，每件一张验货单（piece_no 1..N），验过入库各出一个 SKU，凭证按验货单分开；
- 成交金额按件均摊（分摊不尽的几分钱算在最后一件），实收金额照旧可以逐件改；
- 还有没验的件，采购单就一直是待验货；没到的件标「没到货」关掉这件，按这件的金额跟退款；
- 一单一件（quantity=1，所有老单）的行为一点不变：状态照旧由各处直接改。
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.enums import InspectionActionType, InspectionStatus, OrderStatus, SkuStatus, StockEventType
from app.models import (
    Inspection,
    InspectionCheckItem,
    InspectionEvidence,
    InspectionException,
    PurchaseOrder,
    Sku,
    StockEvent,
)
from app.schemas._tz import utc_to_cn_iso
from app.services import inspection_ops as ops
from app.services.order_no import generate_order_no

MAX_PIECES = 50

_ACTION_LABELS = {
    InspectionActionType.INBOUND: "已入库",
    InspectionActionType.REJECT: "已拒签",
    InspectionActionType.MISSING: "没到货",
}


def not_missing_piece():
    """计件、统计「验了几单」时排除标了没到货的那件：它没人验。"""
    return Inspection.action_type.is_(None) | (Inspection.action_type != InspectionActionType.MISSING)


def piece_cost(order: PurchaseOrder, piece_no: int) -> Decimal:
    """这一件摊到的成交金额。"""
    n = max(order.quantity or 1, 1)
    total = int(round(Decimal(str(order.unit_price or 0)) * 100))
    each = total // n
    cents = each + (total - each * n if piece_no == n else 0)
    return (Decimal(cents) / 100).quantize(Decimal("0.01"))


def piece_label(order: PurchaseOrder | None, task: Inspection) -> str | None:
    if not order or (order.quantity or 1) <= 1:
        return None
    return f"第 {task.piece_no}/{order.quantity} 件"


def tasks_of(db: Session, order: PurchaseOrder) -> list[Inspection]:
    return (
        db.query(Inspection)
        .filter(Inspection.purchase_order_id == order.id, Inspection.deleted_at.is_(None))
        .order_by(Inspection.piece_no)
        .all()
    )


def add_pieces(db: Session, order: PurchaseOrder, start: int, end: int) -> None:
    for piece_no in range(start, end + 1):
        db.add(Inspection(
            inspect_no=generate_order_no(db, "IN", Inspection, "inspect_no"),
            purchase_order_id=order.id,
            piece_no=piece_no,
            status=InspectionStatus.PENDING,
        ))
        db.flush()


def _has_work(db: Session, task: Inspection) -> bool:
    """这件已经开始验了（拍了凭证、验了检查项、登了异常）就不能删。"""
    return any(
        db.query(model.id).filter(model.inspection_id == task.id).first()
        for model in (InspectionEvidence, InspectionCheckItem, InspectionException)
    )


def set_quantity(db: Session, order: PurchaseOrder, quantity: int) -> int:
    """改件数，返回原件数。只在一件都还没验完时能改：验过的件成本已经按旧件数摊了。"""
    if quantity < 1 or quantity > MAX_PIECES:
        raise HTTPException(status_code=400, detail=f"件数要在 1 到 {MAX_PIECES} 之间")
    if order.status != OrderStatus.PENDING_INSPECT:
        raise HTTPException(status_code=400, detail="采购单已经验完，不能再改件数")
    tasks = tasks_of(db, order)
    if any(t.status != InspectionStatus.PENDING for t in tasks):
        raise HTTPException(status_code=400, detail="已经有件验过了，件数不能再改；还差的件请标「没到货」")
    old = order.quantity or 1
    if quantity == old:
        return old
    if quantity < old:
        drop = [t for t in tasks if t.piece_no > quantity]
        busy = [t.piece_no for t in drop if _has_work(db, t)]
        if busy:
            raise HTTPException(status_code=400, detail=f"第 {'、'.join(map(str, busy))} 件已经开始验了，不能减掉")
        for t in drop:
            db.delete(t)
        db.flush()
    else:
        add_pieces(db, order, old + 1, quantity)
    order.quantity = quantity
    return old


def sync_order_status(db: Session, order: PurchaseOrder | None) -> None:
    """一单多件的采购单状态跟着各件走：有件没验就是待验货，验完后有货在库就是在库。"""
    if not order or (order.quantity or 1) <= 1:
        return
    db.flush()  # 会话没开 autoflush，刚改的 SKU 状态要先写下去才查得到
    tasks = tasks_of(db, order)
    if any(t.status == InspectionStatus.PENDING for t in tasks):
        order.status = OrderStatus.PENDING_INSPECT
        return
    statuses = [s for (s,) in db.query(Sku.status).filter(Sku.purchase_order_id == order.id).all()]
    if any(s in (SkuStatus.IN_STOCK, SkuStatus.RESERVED) for s in statuses):
        order.status = OrderStatus.IN_STOCK
    elif SkuStatus.SHIPPED in statuses:
        order.status = OrderStatus.SHIPPED
    elif SkuStatus.LOSS in statuses:
        order.status = OrderStatus.LOSS
    elif not statuses:
        order.status = OrderStatus.CANCELLED


def mark_missing(db: Session, order: PurchaseOrder, task: Inspection, reason: str, user_id: str) -> InspectionException:
    """这件没到：关掉这件（不算验货计件），按这件的金额开一条退款跟踪，不用退回。"""
    reason = (reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="请写明情况，比如「卖家说只剩 2 件」")
    if task.status != InspectionStatus.PENDING:
        raise HTTPException(status_code=400, detail="这件已经处理过了")
    if _has_work(db, task):
        raise HTTPException(status_code=400, detail="这件已经开始验了，说明货到了；有问题请登记异常或拒签")
    now = datetime.utcnow()
    task.action_type = InspectionActionType.MISSING
    task.remark = reason
    task.status = InspectionStatus.DONE
    task.inspector_id = user_id
    task.inspected_at = now
    amount = piece_cost(order, task.piece_no)
    exc = ops.raise_exception(
        db, task, order,
        exception_type=ops.MISSING_EXCEPTION,
        description=f"{piece_label(order, task) or '这件'}没到货：{reason}",
        user_id=user_id, now=now,
        reject_status="NOT_NEEDED", refund_amount=amount,
    )
    db.add(StockEvent(
        purchase_order_id=order.id, event_type=StockEventType.REJECT, ref_no=task.inspect_no,
        operator_id=user_id, payload={"missing": True, "piece_no": task.piece_no, "reason": reason},
    ))
    db.flush()
    sync_order_status(db, order)
    return exc


def pieces_out(db: Session, order: PurchaseOrder) -> dict:
    tasks = tasks_of(db, order)
    skus = {s.inspection_id: s for s in db.query(Sku).filter(Sku.purchase_order_id == order.id).all()}
    excs: dict[str, InspectionException] = {}
    for e in db.query(InspectionException).filter(InspectionException.purchase_order_id == order.id).all():
        excs.setdefault(e.inspection_id, e)
    pieces = []
    for t in tasks:
        sku = skus.get(t.id)
        exc = excs.get(t.id)
        pieces.append({
            "piece_no": t.piece_no,
            "inspection_id": t.id,
            "inspect_no": t.inspect_no,
            "status": t.status,
            "state": "待到货/待验" if t.status == InspectionStatus.PENDING else _ACTION_LABELS.get(t.action_type, t.action_type),
            "action_type": t.action_type,
            "cost": str(t.actual_amount if t.actual_amount is not None else piece_cost(order, t.piece_no)),
            "sku_code": sku.sku_code if sku else None,
            "sku_status": sku.status if sku else None,
            "remark": t.remark if t.action_type == InspectionActionType.MISSING else None,
            "refund_status": exc.refund_status if exc else None,
            "inspected_at": utc_to_cn_iso(t.inspected_at),
        })
    done = sum(1 for p in pieces if p["status"] != InspectionStatus.PENDING)
    return {
        "order_no": order.order_no,
        "product_name": order.product_name,
        "unit_price": str(order.unit_price),
        "quantity": order.quantity or 1,
        "status": order.status,
        "done": done,
        "arrived": sum(1 for p in pieces if p["action_type"] in (InspectionActionType.INBOUND, InspectionActionType.REJECT)),
        "missing": sum(1 for p in pieces if p["action_type"] == InspectionActionType.MISSING),
        "can_set_quantity": order.status == OrderStatus.PENDING_INSPECT and done == 0,
        "pieces": pieces,
    }
