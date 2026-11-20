from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import (
    OrderStatus,
    ReturnCondition,
    ReturnOrderStatus,
    ReturnReasonCode,
    ReturnResolution,
    SkuStatus,
    StaffRole,
    StockEventType,
)
from app.models import PurchaseOrder, ReturnOrder, SalesOutbound, Sku, Staff, StockEvent
from app.schemas.returns import (
    ReturnOrderCreate,
    ReturnOrderListResponse,
    ReturnOrderOut,
    ReturnReceiveRequest,
    ReturnResolveRequest,
)
from app.services import purchase_pieces
from app.services import listing_approval, return_recheck
from app.services.order_no import generate_order_no
from app.services.oss_media import sign_media_payload, thumb_url_for_cover
from app.services.return_snapshot import build_listing_snapshot, restore_listing_snapshot
from app.services.staff_lookup import map_staff_names

router = APIRouter(prefix="/api/returns", tags=["returns"])


def _return_out(
    row: ReturnOrder,
    names: dict[str, str],
    cover_url: str | None = None,
    location_images: list | None = None,
) -> ReturnOrderOut:
    data = ReturnOrderOut.model_validate(row).model_dump()
    data["operator_name"] = names.get(row.created_by_id)
    data["receiver_name"] = names.get(row.receiver_id) if row.receiver_id else None
    data["resolver_name"] = names.get(row.resolved_by_id) if row.resolved_by_id else None
    data["cover_url"] = cover_url
    data["location_images"] = location_images or []
    payload = sign_media_payload(data)
    if payload.get("cover_url"):
        payload["cover_thumb_url"] = thumb_url_for_cover(payload["cover_url"])
    return ReturnOrderOut(**payload)


def _norm_serial(value: str | None) -> str:
    return (value or "").replace(" ", "").strip().upper()


def _restore_sku_from_return(
    db: Session,
    row: ReturnOrder,
    sku: Sku,
    operator_id: str,
    now: datetime,
    location_code: str | None,
    event_payload: dict,
) -> None:
    """退货恢复在库：收货核对通过与异常裁决 RESTOCK 共用。"""
    sku.status = SkuStatus.IN_STOCK
    sku.outbound_at = None
    sku.reserve_source = None
    sku.negotiated_at = now
    if location_code:
        sku.location_code = location_code
    restore_listing_snapshot(db, sku, row.listing_snapshot)
    # 退回来的货要重新核状态再清洗，发货前批的价和图不能直接接着用
    listing_approval.mark_stale(db, sku.id, f"退货回仓（{row.return_no}），要重新核状态")
    order = db.get(PurchaseOrder, sku.purchase_order_id)
    if order:
        order.status = OrderStatus.IN_STOCK
        purchase_pieces.sync_order_status(db, order)  # 一单多件按各件算
    db.add(
        StockEvent(
            purchase_order_id=sku.purchase_order_id,
            sku_id=sku.id,
            event_type=StockEventType.RETURN,
            ref_no=row.return_no,
            operator_id=operator_id,
            payload=event_payload,
        )
    )


@router.get("", response_model=ReturnOrderListResponse, summary="退货单列表")
def list_returns(
    status: str | None = None,
    q: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    query = db.query(ReturnOrder)
    if user.role == StaffRole.SALES:
        query = query.filter(ReturnOrder.created_by_id == user.id)
    elif user.role == StaffRole.WAREHOUSE:
        query = query.filter(
            ReturnOrder.status.in_(
                (
                    ReturnOrderStatus.RETURNING,
                    ReturnOrderStatus.PENDING_INBOUND,
                    ReturnOrderStatus.ABNORMAL,
                )
            )
        )
    elif user.role not in (StaffRole.ADMIN, StaffRole.NEGOTIATOR):
        raise HTTPException(status_code=403, detail="权限不足")
    if status:
        query = query.filter(ReturnOrder.status == status)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (ReturnOrder.return_no.like(like))
            | (ReturnOrder.sku_code.like(like))
            | (ReturnOrder.product_name.like(like))
        )
    total = query.count()
    rows = (
        query.order_by(ReturnOrder.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    sku_ids = [row.sku_id for row in rows]
    sku_map = {
        sku.id: sku
        for sku in db.query(Sku).filter(Sku.id.in_(sku_ids)).all()
    } if sku_ids else {}
    staff_ids = (
        {row.created_by_id for row in rows}
        | {row.receiver_id for row in rows if row.receiver_id}
        | {row.resolved_by_id for row in rows if row.resolved_by_id}
    )
    names = map_staff_names(db, staff_ids)
    items = [
        _return_out(
            row,
            names,
            sku_map[row.sku_id].cover_url if row.sku_id in sku_map else None,
            sku_map[row.sku_id].location_images if row.sku_id in sku_map else None,
        )
        for row in rows
    ]
    return ReturnOrderListResponse(items=items, total=total, page=page, size=size)


@router.post("", response_model=ReturnOrderOut, summary="创建退货单")
def create_return(
    body: ReturnOrderCreate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    reason_code = (body.reason_code or "").strip()
    if reason_code not in set(ReturnReasonCode):
        raise HTTPException(status_code=400, detail="无效的退回原因")
    if reason_code == ReturnReasonCode.OTHER and not (body.reason or "").strip():
        raise HTTPException(status_code=400, detail="选择「其他」时请填写具体原因")
    sku = db.query(Sku).filter(Sku.sku_code == body.sku_code.strip()).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status != SkuStatus.SHIPPED:
        raise HTTPException(status_code=400, detail="仅已发货商品可创建退货单")
    active = (
        db.query(ReturnOrder)
        .filter(
            ReturnOrder.sku_id == sku.id,
            ReturnOrder.status.in_((ReturnOrderStatus.RETURNING, ReturnOrderStatus.PENDING_INBOUND)),
        )
        .first()
    )
    if active:
        raise HTTPException(status_code=400, detail="该商品已有进行中的退货单")

    outbound = (
        db.query(SalesOutbound)
        .filter(SalesOutbound.sku_id == sku.id)
        .order_by(SalesOutbound.created_at.desc())
        .first()
    )
    return_no = generate_order_no(db, "RT", ReturnOrder, "return_no")
    row = ReturnOrder(
        return_no=return_no,
        sku_id=sku.id,
        sku_code=sku.sku_code,
        product_name=sku.product_name,
        status=ReturnOrderStatus.RETURNING,
        reason_code=reason_code,
        reason=(body.reason or "").strip() or None,
        listing_snapshot=build_listing_snapshot(db, sku),
        outbound_id=outbound.id if outbound else None,
        created_by_id=user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    names = map_staff_names(db, {user.id})
    return _return_out(row, names, sku.cover_url, sku.location_images)


@router.post("/{return_id}/receive", response_model=ReturnOrderOut, summary="退货收货核对")
def receive_return(
    return_id: str,
    body: ReturnReceiveRequest,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    """收货核对：序列号/商品状态/库位/照片必填；异常件挂起不动库存。"""
    row = db.get(ReturnOrder, return_id)
    if not row:
        raise HTTPException(status_code=404, detail="退货单不存在")
    if row.status not in (ReturnOrderStatus.RETURNING, ReturnOrderStatus.PENDING_INBOUND):
        raise HTTPException(status_code=400, detail="退货单状态不可入库")

    sku = db.get(Sku, row.sku_id)
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")

    condition = (body.condition or "").strip()
    if condition not in set(ReturnCondition):
        raise HTTPException(status_code=400, detail="无效的商品状态")
    location_code = (body.location_code or "").strip()
    if not location_code:
        raise HTTPException(status_code=400, detail="请填写当前库位")

    serial_input = (body.serial_number or "").strip()
    serial_mismatch = bool(sku.serial_number) and _norm_serial(serial_input) != _norm_serial(
        sku.serial_number
    )
    is_abnormal = body.mark_abnormal or condition == ReturnCondition.ABNORMAL
    if serial_mismatch and not body.mark_abnormal:
        raise HTTPException(
            status_code=400,
            detail=f"序列号不符：系统登记为 {sku.serial_number}，可标记异常挂起处理",
        )
    if is_abnormal and not (body.abnormal_reason or "").strip():
        raise HTTPException(status_code=400, detail="请填写异常说明")
    # 退回复验（禅道 WH10-10）：复验发现问题只能挂起；开了开关没复验不能入库
    return_recheck.assert_receivable(db, row, is_abnormal)

    now = datetime.utcnow()
    row.receiver_id = user.id
    row.received_at = now
    row.received_serial = serial_input
    row.received_condition = condition
    row.received_location_code = location_code
    row.received_media = body.media
    row.received_remark = (body.remark or "").strip() or None

    if is_abnormal:
        # 挂起等管理员裁决：SKU 保持已出库，不恢复库存
        row.status = ReturnOrderStatus.ABNORMAL
        row.abnormal_reason = (body.abnormal_reason or "").strip()
    else:
        row.status = ReturnOrderStatus.DONE
        _restore_sku_from_return(
            db,
            row,
            sku,
            user.id,
            now,
            location_code,
            {
                "reason": row.reason,
                "reason_code": row.reason_code,
                "condition": condition,
                "location_code": location_code,
                "serial_checked": True,
            },
        )
    db.commit()
    db.refresh(row)
    names = map_staff_names(db, {row.created_by_id, user.id})
    return _return_out(row, names, sku.cover_url, sku.location_images)


@router.post("/{return_id}/resolve", response_model=ReturnOrderOut, summary="退货异常裁决")
def resolve_abnormal(
    return_id: str,
    body: ReturnResolveRequest,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """异常件裁决：恢复在库 / 报损 / 驳回重新核对。"""
    row = db.get(ReturnOrder, return_id)
    if not row:
        raise HTTPException(status_code=404, detail="退货单不存在")
    if row.status != ReturnOrderStatus.ABNORMAL:
        raise HTTPException(status_code=400, detail="仅退回异常状态可裁决")
    action = (body.action or "").strip()
    if action not in set(ReturnResolution):
        raise HTTPException(status_code=400, detail="无效的裁决动作")

    sku = db.get(Sku, row.sku_id)
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")

    now = datetime.utcnow()
    if action == ReturnResolution.RESTOCK:
        row.status = ReturnOrderStatus.DONE
        row.resolution = action
        row.resolved_by_id = user.id
        row.resolved_at = now
        _restore_sku_from_return(
            db,
            row,
            sku,
            user.id,
            now,
            row.received_location_code,
            {
                "reason": row.abnormal_reason,
                "reason_code": row.reason_code,
                "condition": row.received_condition,
                "location_code": row.received_location_code,
                "resolution": "RESTOCK",
            },
        )
    elif action == ReturnResolution.LOSS:
        row.status = ReturnOrderStatus.DONE
        row.resolution = action
        row.resolved_by_id = user.id
        row.resolved_at = now
        sku.status = SkuStatus.LOSS
        db.add(
            StockEvent(
                purchase_order_id=sku.purchase_order_id,
                sku_id=sku.id,
                event_type=StockEventType.LOSS,
                ref_no=row.return_no,
                operator_id=user.id,
                payload={"resolution": "LOSS", "reason": row.abnormal_reason, "remark": body.remark},
            )
        )
    else:  # REJECT 驳回：退回待入库重新核对，保留已填信息供参考
        row.status = ReturnOrderStatus.PENDING_INBOUND
        row.resolution = None
        row.resolved_by_id = user.id
        row.resolved_at = now
    db.commit()
    db.refresh(row)
    names = map_staff_names(db, {row.created_by_id, row.receiver_id, user.id} - {None})
    return _return_out(row, names, sku.cover_url, sku.location_images)


@router.post("/{return_id}/to-inbound", response_model=ReturnOrderOut, summary="标记退货待入库")
def mark_pending_inbound(
    return_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    """纯状态推进（客户已寄回，等仓库签收），不动库存；权限与建单口径一致，
    不限建单人本人——谁先确认包裹寄回谁标记。"""
    row = db.get(ReturnOrder, return_id)
    if not row:
        raise HTTPException(status_code=404, detail="退货单不存在")
    if row.status != ReturnOrderStatus.RETURNING:
        raise HTTPException(status_code=400, detail="仅退货中状态可推进为待入库")
    row.status = ReturnOrderStatus.PENDING_INBOUND
    db.commit()
    db.refresh(row)
    sku = db.get(Sku, row.sku_id)
    names = map_staff_names(db, {row.created_by_id})
    return _return_out(row, names, sku.cover_url if sku else None, sku.location_images if sku else None)
