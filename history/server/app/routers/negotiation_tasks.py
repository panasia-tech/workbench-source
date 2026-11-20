"""历史议价单处理：关闭 或 转为在库商品（免议价，进入上架流程）。"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import (
    InspectionActionType,
    InspectionResult,
    InspectionStatus,
    OrderStatus,
    SkuStatus,
    StaffRole,
    StockEventType,
)
from app.models import Inspection, NegotiationTask, PurchaseOrder, Sku, Staff, StockEvent
from app.schemas.negotiation import (
    NegotiationTaskClose,
    NegotiationTaskConvert,
    NegotiationTaskConvertResult,
    NegotiationTaskOut,
)
from app.services.auto_listing.pipeline import enqueue_on_inbound
from app.services.order_no import calc_suggest_price, generate_order_no, generate_sku_code
from app.services.oss_media import sign_media_payload

router = APIRouter(prefix="/api/negotiation-tasks", tags=["negotiation-tasks"])

TASK_STATUS_OPEN = "OPEN"
TASK_STATUS_CLOSED = "CLOSED"
TASK_STATUS_CONVERTED = "CONVERTED"


def _task_out(task: NegotiationTask) -> NegotiationTaskOut:
    payload = {
        "id": task.id,
        "order_no": task.order_no,
        "purchase_no": task.purchase_no,
        "goods_code": task.goods_code,
        "serial_no": task.serial_no,
        "seller_nickname": task.seller_nickname,
        "product_name": task.product_name,
        "location": task.location,
        "inspection_result": task.inspection_result,
        "inspection_result_text": task.inspection_result_text,
        "inspection_description": task.inspection_description,
        "purchase_price": task.purchase_price,
        "product_images": sign_media_payload(task.product_images or []),
        "defect_images": sign_media_payload(task.defect_images or []),
        "defect_videos": sign_media_payload(task.defect_videos or []),
        "status": task.status,
        "close_note": task.close_note,
        "closed_at": task.closed_at,
        "closed_by_name": task.closed_by_name,
        "created_at": task.created_at,
    }
    return NegotiationTaskOut(**payload)


def _get_open_task(task_id: str, db: Session) -> NegotiationTask:
    task = db.query(NegotiationTask).filter(NegotiationTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="议价单不存在")
    if task.status != TASK_STATUS_OPEN:
        raise HTTPException(status_code=400, detail="议价单不在待处理状态")
    return task


@router.get("", response_model=list[NegotiationTaskOut], summary="历史议价单列表")
def list_tasks(
    status: str | None = None,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    q = db.query(NegotiationTask).filter(NegotiationTask.deleted_at.is_(None))  # 排除软删除（老系统回填占位）
    if status:
        q = q.filter(NegotiationTask.status == status)
    rows = q.order_by(NegotiationTask.created_at.desc()).all()
    return [_task_out(t) for t in rows]


@router.post("/{task_id}/close", response_model=NegotiationTaskOut, summary="关闭议价单")
def close_task(
    task_id: str,
    body: NegotiationTaskClose,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    task = _get_open_task(task_id, db)
    now = datetime.utcnow()
    task.status = TASK_STATUS_CLOSED
    task.close_note = (body.close_note or "").strip() or None
    task.closed_at = now
    task.closed_by_id = user.id
    task.closed_by_name = user.name
    db.commit()
    db.refresh(task)
    return _task_out(task)


@router.post("/{task_id}/convert", response_model=NegotiationTaskConvertResult, summary="议价单转为在库商品")
def convert_task(
    task_id: str,
    body: NegotiationTaskConvert,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    task = _get_open_task(task_id, db)
    now = datetime.utcnow()

    cost_price = body.cost_price if body.cost_price is not None else task.purchase_price
    if cost_price is None or cost_price <= 0:
        raise HTTPException(status_code=400, detail="缺少成本价，请填写")

    sku_code = (body.sku_code or task.goods_code or "").strip().upper()
    if not sku_code:
        sku_code = generate_sku_code(db)
    if db.query(Sku).filter(Sku.sku_code == sku_code).first():
        raise HTTPException(status_code=400, detail=f"货号 {sku_code} 已存在")

    product_name = (task.product_name or "").strip() or "历史商品"
    serial_number = (body.serial_number or task.serial_no or "").strip() or None
    location_code = (body.location_code or task.location or "").strip() or None
    product_images = list(task.product_images or [])
    defect_images = list(task.defect_images or [])
    remark = (body.remark or "").strip() or None

    order = PurchaseOrder(
        order_no=generate_order_no(db, "PO", PurchaseOrder, "order_no"),
        status=OrderStatus.IN_STOCK,
        product_name=product_name,
        unit_price=cost_price,
        external_order_no=task.order_no,
        transaction_no=task.trade_no,
        tracking_no=task.logistics_tracking_no,
        seller_name=task.seller_nickname,
        remark=f"历史议价单转入（原采购号 {task.purchase_no or '-'}）",
        product_images=product_images,
        created_by_id=user.id,
    )
    db.add(order)
    db.flush()

    inspection = Inspection(
        inspect_no=generate_order_no(db, "IN", Inspection, "inspect_no"),
        purchase_order_id=order.id,
        action_type=InspectionActionType.INBOUND,
        inspection_result=InspectionResult.PASSED,
        listing_images=product_images,
        defect_images=defect_images,
        defect_videos=list(task.defect_videos or []),
        condition_grade=body.condition_grade,
        location_code=location_code,
        remark=remark or task.inspection_description,
        status=InspectionStatus.DONE,
        inspector_id=user.id,
        inspected_at=now,
    )
    db.add(inspection)
    db.flush()

    sku = Sku(
        sku_code=sku_code,
        serial_number=serial_number,
        purchase_order_id=order.id,
        inspection_id=inspection.id,
        product_name=product_name,
        location_code=location_code,
        condition_grade=body.condition_grade,
        cost_price=cost_price,
        suggest_price=calc_suggest_price(float(cost_price), body.condition_grade),
        status=SkuStatus.IN_STOCK,
        cover_url=product_images[0] if product_images else None,
        images=product_images + defect_images,
        location_images=list(body.location_images or []),
        inbound_at=now,
        negotiated_at=now,
        negotiation_remark="历史议价单转入，免议价",
    )
    db.add(sku)
    db.flush()

    # 入库即登记自动上架（开关关着则不登记；跟入库同一笔事务落库）
    enqueue_on_inbound(db, sku)

    for et, ref in [
        (StockEventType.INSPECT, inspection.inspect_no),
        (StockEventType.INBOUND, sku_code),
    ]:
        db.add(
            StockEvent(
                purchase_order_id=order.id,
                sku_id=sku.id,
                event_type=et,
                ref_no=ref,
                operator_id=user.id,
                payload={"source": "negotiation_task_convert", "task_id": task.id},
            )
        )

    task.status = TASK_STATUS_CONVERTED
    task.close_note = f"转为在库商品 {sku_code}"
    task.closed_at = now
    task.closed_by_id = user.id
    task.closed_by_name = user.name
    db.commit()

    return NegotiationTaskConvertResult(
        task_id=task.id,
        sku_code=sku_code,
        purchase_order_no=order.order_no,
    )
