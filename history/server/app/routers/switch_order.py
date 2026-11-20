from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import OutboundType, ReserveSource, SkuStatus, StaffRole, SwitchCutoffStatus, SwitchOrderStatus
from app.services.sku_reserve import clear_reserve
from app.models import Sku, Staff, SwitchOrder
from app.schemas.switch_order import (
    SwitchCutoffApplyIn,
    SwitchCutoffReviewIn,
    SwitchDepositIn,
    SwitchFinalPaymentIn,
    SwitchOrderCreate,
    SwitchOrderOut,
    SwitchOrderUpdate,
)
from app.services.oss_media import sign_media_payload
from app.services.order_no import generate_order_no
from app.services import stock_lock_delist

router = APIRouter(prefix="/api/switch", tags=["switch"])


def _out(row: SwitchOrder, sku: Sku | None = None) -> SwitchOrderOut:
    data = SwitchOrderOut.model_validate(row).model_dump()
    if sku:
        data["sku_code"] = sku.sku_code
        data["product_name"] = sku.product_name
    return SwitchOrderOut(**sign_media_payload(data))


@router.get("/orders", response_model=list[SwitchOrderOut], summary="换机单列表")
def list_orders(
    status: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    q = db.query(SwitchOrder, Sku).join(Sku, SwitchOrder.sku_id == Sku.id)
    if user.role not in (StaffRole.ADMIN,):
        q = q.filter(SwitchOrder.created_by_id == user.id)
    if status:
        q = q.filter(SwitchOrder.status == status)
    rows = q.order_by(SwitchOrder.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return [_out(order, sku) for order, sku in rows]


@router.get("/orders/{order_id}", response_model=SwitchOrderOut, summary="换机单详情")
def get_order(order_id: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    row = db.query(SwitchOrder, Sku).join(Sku, SwitchOrder.sku_id == Sku.id).filter(SwitchOrder.id == order_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="切单不存在")
    order, sku = row
    if user.role != StaffRole.ADMIN and order.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="无权查看")
    return _out(order, sku)


@router.post("/orders", response_model=SwitchOrderOut, summary="创建换机单")
def create_order(
    body: SwitchOrderCreate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == body.sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status != SkuStatus.IN_STOCK or sku.reserve_source:
        raise HTTPException(status_code=400, detail="商品不在库或已被锁定")
    if not body.evidence_urls:
        raise HTTPException(status_code=400, detail="请上传切单证据")
    switch_no = generate_order_no(db, "SW", SwitchOrder, "switch_no")
    order = SwitchOrder(
        switch_no=switch_no,
        sku_id=sku.id,
        unit_price=body.unit_price,
        evidence_urls=body.evidence_urls,
        remark=body.remark,
        created_by_id=user.id,
    )
    sku.status = SkuStatus.RESERVED
    sku.reserve_source = ReserveSource.SWITCH
    db.add(order)
    db.commit()
    db.refresh(order)
    # 锁给换机客户了：别的号上的链接下掉，免得被别人拍下
    stock_lock_delist.after_stock_left(db, sku, reason="换机锁货", operator_id=user.id)
    return _out(order, sku)


@router.post("/orders/{order_id}/deposit", response_model=SwitchOrderOut, summary="收取换机定金")
def collect_deposit(
    order_id: str,
    body: SwitchDepositIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    order, sku = _get_active_order(db, order_id, user)
    order.deposit_amount = body.deposit_amount
    order.deposit_evidence_urls = body.evidence_urls
    order.deposit_paid_at = datetime.utcnow()
    db.commit()
    return _out(order, sku)


@router.post("/orders/{order_id}/final-payment", response_model=SwitchOrderOut, summary="收取换机尾款")
def collect_final(
    order_id: str,
    body: SwitchFinalPaymentIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    order, sku = _get_active_order(db, order_id, user)
    order.final_amount = body.final_amount
    order.final_evidence_urls = body.evidence_urls
    order.final_paid_at = datetime.utcnow()
    db.commit()
    return _out(order, sku)


@router.post("/orders/{order_id}/apply-cutoff", response_model=SwitchOrderOut, summary="申请换机截单")
def apply_cutoff(
    order_id: str,
    body: SwitchCutoffApplyIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    order, sku = _get_active_order(db, order_id, user)
    if order.cutoff_status == SwitchCutoffStatus.PENDING:
        raise HTTPException(status_code=400, detail="截单申请处理中")
    if not order.deposit_paid_at:
        raise HTTPException(status_code=400, detail="请先收定金")
    order.cutoff_status = SwitchCutoffStatus.PENDING
    order.cutoff_applied_at = datetime.utcnow()
    order.cutoff_remark = body.remark
    db.commit()
    return _out(order, sku)


@router.post("/orders/{order_id}/review-cutoff", response_model=SwitchOrderOut, summary="审批换机截单")
def review_cutoff(
    order_id: str,
    body: SwitchCutoffReviewIn,
    db: Session = Depends(get_db),
    admin: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    from app.routers.inventory import _do_outbound

    row = db.query(SwitchOrder, Sku).join(Sku, SwitchOrder.sku_id == Sku.id).filter(SwitchOrder.id == order_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="切单不存在")
    order, sku = row
    if order.cutoff_status != SwitchCutoffStatus.PENDING:
        raise HTTPException(status_code=400, detail="无待审批截单")
    order.cutoff_reviewed_by = admin.id
    if body.remark:
        order.cutoff_remark = body.remark
    if body.approved:
        order.cutoff_status = SwitchCutoffStatus.APPROVED
        sale_price = order.final_amount or order.unit_price

        class _Req:
            pass

        req = _Req()
        req.sale_price = sale_price
        req.buyer_name = None
        req.sale_order_id = None
        req.evidence_urls = order.evidence_urls
        req.payment_screenshot_url = None
        req.tracking_no = None
        req.remark = f"切单 {order.switch_no}"
        req.express_fee = None
        clear_reserve(sku)
        outbound = _do_outbound(db, admin, sku, req, OutboundType.SWITCH)
        order.sales_outbound_id = outbound.id
        order.status = SwitchOrderStatus.COMPLETED
    else:
        order.cutoff_status = SwitchCutoffStatus.NONE
    db.commit()
    if body.approved:
        stock_lock_delist.after_stock_left(db, sku, reason="切单出库", operator_id=admin.id)
    return _out(order, sku)


@router.patch("/orders/{order_id}", response_model=SwitchOrderOut, summary="更新换机单")
def update_order(
    order_id: str,
    body: SwitchOrderUpdate,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    row = db.query(SwitchOrder, Sku).join(Sku, SwitchOrder.sku_id == Sku.id).filter(SwitchOrder.id == order_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="切单不存在")
    order, sku = row
    for key, val in body.model_dump(exclude_unset=True).items():
        setattr(order, key, val)
    db.commit()
    return _out(order, sku)


@router.post("/orders/{order_id}/cancel", response_model=SwitchOrderOut, summary="取消换机单")
def cancel_order(
    order_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    row = db.query(SwitchOrder, Sku).join(Sku, SwitchOrder.sku_id == Sku.id).filter(SwitchOrder.id == order_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="切单不存在")
    order, sku = row
    if user.role != StaffRole.ADMIN and order.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="无权取消")
    if order.status != SwitchOrderStatus.ACTIVE:
        raise HTTPException(status_code=400, detail="切单不可取消")
    if order.cutoff_status == SwitchCutoffStatus.APPROVED:
        raise HTTPException(status_code=400, detail="已截单通过，不可取消")
    order.status = SwitchOrderStatus.CANCELLED
    clear_reserve(sku)
    db.commit()
    return _out(order, sku)


def _get_active_order(db: Session, order_id: str, user: Staff) -> tuple[SwitchOrder, Sku]:
    row = db.query(SwitchOrder, Sku).join(Sku, SwitchOrder.sku_id == Sku.id).filter(SwitchOrder.id == order_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="切单不存在")
    order, sku = row
    if user.role != StaffRole.ADMIN and order.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="无权操作")
    if order.status != SwitchOrderStatus.ACTIVE:
        raise HTTPException(status_code=400, detail="切单已结束")
    return order, sku
