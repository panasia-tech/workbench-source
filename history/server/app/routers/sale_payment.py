from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import PickupPayment, SalesOutbound, Staff
from app.schemas.pickup_payment import (
    PickupPaymentCreate,
    PickupPaymentList,
    PickupPaymentListItem,
    PickupPaymentOut,
)
from app.services import pickup_payment as svc
from app.services.finance import cn_range_to_utc

router = APIRouter(prefix="/api/sales/pickup-payment", tags=["pickup-payment"])

_ROLES = (StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)


def _to_out(payment: PickupPayment) -> PickupPaymentOut:
    out = PickupPaymentOut.model_validate(payment)
    out.qr_image = svc.qr_data_uri(payment.qr_code)
    return out


@router.post("/create", response_model=PickupPaymentOut, summary="创建自提收款单")
async def create_pickup_payment(
    body: PickupPaymentCreate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_ROLES)),
):
    try:
        payment = await svc.create_pickup_payment(
            db,
            user,
            sku_code=body.sku_code.strip(),
            sale_price=body.sale_price,
            buyer_name=(body.buyer_name or "").strip() or None,
            evidence_urls=body.evidence_urls,
            express_fee=body.express_fee,
            remark=body.remark,
        )
    except svc.PickupPaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _to_out(payment)


@router.get("/{out_trade_no}/status", response_model=PickupPaymentOut, summary="查询自提收款状态")
async def pickup_payment_status(
    out_trade_no: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_ROLES)),
):
    payment = db.query(PickupPayment).filter(PickupPayment.out_trade_no == out_trade_no).first()
    if not payment:
        raise HTTPException(status_code=404, detail="收款单不存在")
    try:
        payment = await svc.sync_and_complete(db, payment)
    except svc.PickupPaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _to_out(payment)


@router.get("/list", response_model=PickupPaymentList, summary="自提收款单列表（对账用）")
def pickup_payment_list(
    date_from: date | None = Query(None, description="按创建日期筛选（中国日历，含当日）"),
    date_to: date | None = Query(None),
    status: str | None = Query(None, description="按状态筛选，留空为全部"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.FINANCE, StaffRole.ADMIN)),
):
    """收款单 ↔ 支付宝交易号 ↔ 出库单的对照清单，供与支付宝账单核对。

    MISMATCH 的行是金额/收款方校验没过、已拦下未出库的单，优先人工处理。
    """
    q = db.query(PickupPayment)
    if date_from and date_to:
        start, end = cn_range_to_utc(date_from, date_to)
        q = q.filter(PickupPayment.created_at >= start, PickupPayment.created_at < end)
    if status:
        q = q.filter(PickupPayment.status == status)
    total = q.count()
    rows = (
        q.order_by(PickupPayment.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )

    # 出库单号与操作人批量取，避免逐行查库
    outbound_ids = [r.outbound_id for r in rows if r.outbound_id]
    outbound_nos: dict[str, str] = {}
    if outbound_ids:
        outbound_nos = {
            o.id: o.outbound_no
            for o in db.query(SalesOutbound).filter(SalesOutbound.id.in_(outbound_ids)).all()
        }
    operator_ids = [r.operator_id for r in rows if r.operator_id]
    operators: dict[str, str] = {}
    if operator_ids:
        operators = {
            st.id: st.name for st in db.query(Staff).filter(Staff.id.in_(operator_ids)).all()
        }

    return PickupPaymentList(
        items=[
            PickupPaymentListItem(
                out_trade_no=r.out_trade_no,
                alipay_trade_no=r.alipay_trade_no,
                sku_code=r.sku_code,
                buyer_name=r.buyer_name,
                sale_price=r.sale_price,
                status=r.status,
                outbound_no=outbound_nos.get(r.outbound_id) if r.outbound_id else None,
                operator_name=operators.get(r.operator_id),
                remark=r.remark,
                created_at=r.created_at,
                paid_at=r.paid_at,
            )
            for r in rows
        ],
        total=total,
    )
