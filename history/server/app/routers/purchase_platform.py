"""采购工作台 W10：平台订单（执行端只读「我买到的」抓回来）。

执行端 → 群控 → 这里的本机接口入库；采购员在「平台订单」里看、对、一键建单。规矩见 services/purchase_platform.py。
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import PurchaseOrder, PurchasePlatformEvent, PurchasePlatformOrder, Staff
from app.routers.internal_notify import require_local
from app.schemas._tz import utc_to_cn_iso
from app.services import purchase_platform as pp

router = APIRouter(prefix="/api/purchase/platform-orders", tags=["purchase"])
internal = APIRouter(prefix="/api/internal/purchase-platform", tags=["内部"])

_ROLES = require_roles(StaffRole.PURCHASER, StaffRole.ADMIN)
# 取消、关闭（退款关单）的不用建采购单，不进「待建单」
_NO_PO = ("cancelled", "closed")


class IngestIn(BaseModel):
    platform: str = "xianyu"
    buyer_account: str = Field(min_length=1, max_length=64)
    orders: list[dict] = Field(default_factory=list, max_length=200)


@internal.post("/ingest", summary="执行端抓回来的买家订单入库（本机群控转过来）", dependencies=[Depends(require_local)])
def ingest(body: IngestIn, background: BackgroundTasks, db: Session = Depends(get_db)):
    out = pp.ingest(db, body.platform, body.buyer_account.strip(), body.orders)
    db.commit()
    from app.routers.purchase import _archive_in_background

    background.add_task(_archive_in_background)  # 商品页上的原图转存到我们图床
    return out


def _d(v):
    return str(v) if v is not None else None


def _out(row: PurchasePlatformOrder, pos: list[PurchaseOrder] | None = None) -> dict:
    return {
        "id": row.id, "platform": row.platform, "platform_label": pp.PLATFORMS.get(row.platform, row.platform),
        "buyer_account": row.buyer_account, "purchase_account": row.purchase_account,
        "platform_order_no": row.platform_order_no, "item_id": row.item_id, "item_title": row.item_title,
        "item_image": row.item_image, "seller_name": row.seller_name, "quantity": row.quantity,
        "order_amount": _d(row.order_amount), "paid_amount": _d(row.paid_amount), "freight": _d(row.freight),
        "refunded_amount": _d(row.refunded_amount),
        "trade_status": row.trade_status, "trade_label": pp.TRADE.get(row.trade_status, row.trade_status),
        "pay_status": row.pay_status, "pay_label": pp.PAY.get(row.pay_status, row.pay_status),
        "refund_status": row.refund_status, "refund_label": pp.REFUND.get(row.refund_status, row.refund_status),
        "ship_status": row.ship_status, "ship_label": pp.SHIP.get(row.ship_status, row.ship_status),
        "raw_status": row.raw_status, "tracking_no": row.tracking_no, "logistics_company": row.logistics_company,
        "ordered_at": utc_to_cn_iso(row.ordered_at), "paid_at": utc_to_cn_iso(row.paid_at),
        "sync_status": row.sync_status, "sync_error": row.sync_error, "last_synced_at": utc_to_cn_iso(row.last_synced_at),
        "needs_review": row.needs_review, "review_reason": row.review_reason,
        "orders": [{"id": p.id, "order_no": p.order_no, "status": p.status, "product_name": p.product_name}
                   for p in (pos or [])],
    }


def _visible(db: Session, user: Staff):
    """采购员看没挂采购单的（谁都能认领建单）和挂着自己采购单的；管理员看全部。"""
    q = db.query(PurchasePlatformOrder)
    if user.role == StaffRole.ADMIN:
        return q
    mine = db.query(PurchaseOrder.platform_order_id).filter(PurchaseOrder.created_by_id == user.id,
                                                            PurchaseOrder.platform_order_id.isnot(None))
    bound = db.query(PurchaseOrder.platform_order_id).filter(PurchaseOrder.platform_order_id.isnot(None))
    return q.filter(or_(PurchasePlatformOrder.id.in_(mine), PurchasePlatformOrder.id.notin_(bound)))


def _get(db: Session, user: Staff, oid: str) -> PurchasePlatformOrder:
    row = _visible(db, user).filter(PurchasePlatformOrder.id == oid).first()
    if row is None:
        raise HTTPException(status_code=404, detail="没有这单，或者不是你的")
    return row


@router.get("", summary="平台订单：待建单、要人看、按账号 / 状态 / 订单号找")
def list_orders(
    view: str = Query("all", description="all 全部 / unbound 待建单 / review 要人看 / open 没结束的"),
    account: str | None = None, trade_status: str | None = None, q: str | None = None,
    page: int = Query(1, ge=1), size: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db), user: Staff = Depends(_ROLES),
):
    qry = _visible(db, user)
    bound = db.query(PurchaseOrder.platform_order_id).filter(PurchaseOrder.platform_order_id.isnot(None))
    if view == "unbound":
        qry = qry.filter(PurchasePlatformOrder.id.notin_(bound), PurchasePlatformOrder.trade_status.notin_(_NO_PO))
    elif view == "review":
        qry = qry.filter(PurchasePlatformOrder.needs_review.is_(True))
    elif view == "open":
        qry = qry.filter(PurchasePlatformOrder.trade_status.notin_(tuple(pp.TERMINAL)))
    if account:
        qry = qry.filter(or_(PurchasePlatformOrder.purchase_account == account, PurchasePlatformOrder.buyer_account == account))
    if trade_status:
        qry = qry.filter(PurchasePlatformOrder.trade_status == trade_status)
    if q and q.strip():
        like = f"%{q.strip()}%"
        qry = qry.filter(or_(PurchasePlatformOrder.platform_order_no.like(like), PurchasePlatformOrder.item_title.like(like),
                             PurchasePlatformOrder.seller_name.like(like)))
    total = qry.count()
    rows = qry.order_by(PurchasePlatformOrder.ordered_at.desc(), PurchasePlatformOrder.created_at.desc()) \
        .offset((page - 1) * size).limit(size).all()
    pos: dict[str, list] = {}
    if rows:
        for p in db.query(PurchaseOrder).filter(PurchaseOrder.platform_order_id.in_([r.id for r in rows])).all():
            pos.setdefault(p.platform_order_id, []).append(p)
    last = db.query(PurchasePlatformOrder.last_synced_at).order_by(PurchasePlatformOrder.last_synced_at.desc()).first()
    counts = {
        "unbound": _visible(db, user).filter(PurchasePlatformOrder.id.notin_(bound),
                                             PurchasePlatformOrder.trade_status.notin_(_NO_PO)).count(),
        "review": _visible(db, user).filter(PurchasePlatformOrder.needs_review.is_(True)).count(),
    }
    return {"items": [_out(r, pos.get(r.id)) for r in rows], "total": total, "counts": counts,
            "last_synced_at": utc_to_cn_iso(last[0]) if last else None,
            "labels": {"trade": pp.TRADE, "pay": pp.PAY, "refund": pp.REFUND, "ship": pp.SHIP}}


@router.get("/{oid}", summary="一单的详情：挂着的采购单、状态变化")
def read_order(oid: str, db: Session = Depends(get_db), user: Staff = Depends(_ROLES)):
    row = _get(db, user, oid)
    events = (db.query(PurchasePlatformEvent).filter(PurchasePlatformEvent.order_id == row.id)
              .order_by(PurchasePlatformEvent.created_at.desc()).limit(200).all())
    return {**_out(row, pp.bound_orders(db, row)),
            "events": [{"kind": e.kind, "text": e.text, "source": e.source, "at": utc_to_cn_iso(e.created_at),
                        "occurred_at": utc_to_cn_iso(e.occurred_at)} for e in events]}


@router.get("/{oid}/draft", summary="一键建单：采购单表单里能从这单带过去的字段")
def draft(oid: str, db: Session = Depends(get_db), user: Staff = Depends(_ROLES)):
    return pp.draft(_get(db, user, oid))


class BindIn(BaseModel):
    order_no: str = Field(min_length=1, max_length=32)
    note: str | None = Field(default=None, max_length=200)


def _po(db: Session, user: Staff, order_no: str) -> PurchaseOrder:
    po = db.query(PurchaseOrder).filter(PurchaseOrder.order_no == order_no.strip()).first()
    if po is None or (user.role != StaffRole.ADMIN and po.created_by_id != user.id):
        raise HTTPException(status_code=404, detail="没有这张采购单，或者不是你建的")
    return po


@router.post("/{oid}/bind", summary="手动把一张采购单挂到这单上")
def bind(oid: str, body: BindIn, db: Session = Depends(get_db), user: Staff = Depends(_ROLES)):
    row = _get(db, user, oid)
    pp.bind(db, user, row, _po(db, user, body.order_no), note=body.note)
    db.commit()
    return read_order(oid, db=db, user=user)


@router.post("/{oid}/unbind", summary="挂错了摘掉（要写原因）")
def unbind(oid: str, body: BindIn, db: Session = Depends(get_db), user: Staff = Depends(_ROLES)):
    row = _get(db, user, oid)
    pp.unbind(db, user, row, _po(db, user, body.order_no), note=body.note or "")
    db.commit()
    return read_order(oid, db=db, user=user)


class NoteIn(BaseModel):
    note: str = Field(min_length=1, max_length=200)


@router.post("/{oid}/review", summary="要人看的看过了")
def review(oid: str, body: NoteIn, db: Session = Depends(get_db), user: Staff = Depends(_ROLES)):
    row = _get(db, user, oid)
    pp.review_done(db, user, row, body.note)
    db.commit()
    return read_order(oid, db=db, user=user)
