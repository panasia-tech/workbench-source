from datetime import datetime, timedelta

from decimal import Decimal



from fastapi import APIRouter, Depends, HTTPException, Query

from sqlalchemy import func

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

from app.models import Inspection, PurchaseOrder, Sku, Staff, StockEvent, WarehouseTag

from app.schemas.inspection import (

    InspectionActualAmountUpdate,

    InspectionDetailOut,

    InspectionListItem,

    InspectionListResponse,

    InspectionOut,

    InspectionSubmit,

    RecallItem,

)

from app.services.order_no import calc_suggest_price

from app.services.auto_listing.pipeline import enqueue_on_inbound
from app.services.barcode import enrich_sku_spu

from app.services.query_filters import parse_date_range

from app.services.express import express_summary, map_cached_tracking

from app.services.oss_media import (

    first_image_list_urls,

    first_non_video_url,

    sign_media_payload,

    thumb_url_for_cover,

)

from app.services.inspection_ops import (
    assert_ready_to_submit,
    bind_evidence_to_sku,
    ensure_exception_for_reject,
)

from app.services.staff_lookup import map_staff_names
from app.services import purchase_pieces
router = APIRouter(prefix="/api/inspection", tags=["inspection"])

# 议价成功后提醒仓管召回的时间窗：24h 内置顶到待验货列表上方
RECALL_WINDOW_HOURS = 24


def _recall_items(db: Session) -> list[RecallItem]:
    """议价成功、仍在库的商品，需仓管召回。

    仅返回议价 24h 内、仍在库的商品，置顶并打「请及时召回商品」标签（pinned=True）。
    超 24h 自动从召回列表移除；商品出库后也不再返回。
    """
    pin_since = datetime.utcnow() - timedelta(hours=RECALL_WINDOW_HOURS)
    rows = (
        db.query(Sku, PurchaseOrder)
        .outerjoin(PurchaseOrder, Sku.purchase_order_id == PurchaseOrder.id)
        .filter(
            Sku.status == SkuStatus.IN_STOCK,
            Sku.negotiated_at.isnot(None),
            Sku.negotiated_at >= pin_since,
        )
        .order_by(Sku.negotiated_at.desc())
        .all()
    )
    items: list[RecallItem] = []
    for sku, order in rows:
        payload = sign_media_payload(
            {
                "sku_id": sku.id,
                "sku_code": sku.sku_code,
                "product_name": sku.product_name,
                "brand": sku.brand,
                "model": sku.model,
                "spec": sku.spec,
                "location_code": sku.location_code,
                "cost_price": sku.cost_price,
                "cover_url": sku.cover_url,
                "order_no": order.order_no if order else None,
                "negotiated_at": sku.negotiated_at,
                "pinned": True,
            }
        )
        if payload.get("cover_url"):
            payload["cover_thumb_url"] = thumb_url_for_cover(payload["cover_url"])
        items.append(RecallItem(**payload))
    return items


def _resolve_tag_names(db: Session, tag_names: list[str] | None) -> list[str]:
    if not tag_names:
        return []
    cleaned = [name.strip() for name in tag_names if name and name.strip()]
    if not cleaned:
        return []
    rows = (
        db.query(WarehouseTag.name)
        .filter(WarehouseTag.name.in_(cleaned), WarehouseTag.enabled.is_(True))
        .all()
    )
    valid = {row[0] for row in rows}
    seen = []
    for name in cleaned:
        if name in valid and name not in seen:
            seen.append(name)
    return seen





def _inspection_out(task: Inspection) -> InspectionOut:

    data = InspectionOut.model_validate(task).model_dump()

    return InspectionOut(**sign_media_payload(data))





def _inspection_detail(
    task: Inspection, order: PurchaseOrder | None, operator_name: str | None = None
) -> InspectionDetailOut:

    data = InspectionOut.model_validate(task).model_dump()

    data["operator_name"] = operator_name

    if order:

        data.update(

            {

                "order_no": order.order_no,

                "product_name": order.product_name,

                "brand": order.brand,

                "model": order.model,

                "spec": order.spec,

                "unit_price": purchase_pieces.piece_cost(order, task.piece_no),
                "quantity": order.quantity or 1,
                "piece_label": purchase_pieces.piece_label(order, task),
                "order_status": order.status,

                "tracking_no": order.tracking_no,

                "condition_warning": order.condition_warning,

                "condition_warning_text": order.condition_warning_text,

                **first_image_list_urls(order.product_images),

            }

        )

    return InspectionDetailOut(**sign_media_payload(data))





def _inspection_list_item(

    task: Inspection,

    order: PurchaseOrder | None,

    names: dict[str, str],

    *,

    express_summary_text: str | None = None,

) -> InspectionListItem:

    return InspectionListItem(

        id=task.id,

        inspect_no=task.inspect_no,

        purchase_order_id=task.purchase_order_id,

        order_no=order.order_no if order else None,

        product_name=order.product_name if order else None,

        brand=order.brand if order else None,

        model=order.model if order else None,

        spec=order.spec if order else None,

        unit_price=purchase_pieces.piece_cost(order, task.piece_no) if order else None,
        piece_no=task.piece_no,
        quantity=(order.quantity or 1) if order else 1,
        piece_label=purchase_pieces.piece_label(order, task),

        **(first_image_list_urls(order.product_images) if order else {"product_image": None, "product_image_thumb": None}),

        tracking_no=order.tracking_no if order else None,

        tracking_phone_suffix=order.tracking_phone_suffix if order else None,

        express_summary=express_summary_text,

        action_type=task.action_type,

        inspection_result=task.inspection_result,

        condition_grade=task.condition_grade,

        location_code=task.location_code,

        actual_amount=task.actual_amount,

        status=task.status,

        inspector_id=task.inspector_id,

        inspected_at=task.inspected_at,

        created_at=task.created_at,

        operator_name=names.get(task.inspector_id) if task.inspector_id else None,

        condition_warning=order.condition_warning if order else False,

        condition_warning_text=order.condition_warning_text if order else None,

    )





@router.get("/tasks", summary="查询验货任务列表", response_model=InspectionListResponse)

def list_tasks(

    status: str | None = None,

    action_type: str | None = None,

    q: str | None = None,

    date_from: str | None = None,

    date_to: str | None = None,

    page: int = Query(1, ge=1),

    size: int = Query(20, ge=1, le=100),

    db: Session = Depends(get_db),

    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),

):

    query = db.query(Inspection, PurchaseOrder).join(

        PurchaseOrder, Inspection.purchase_order_id == PurchaseOrder.id

    ).filter(Inspection.deleted_at.is_(None))  # 排除软删除(旧系统迁移占位)的验货单

    if user.role != StaffRole.ADMIN and status != InspectionStatus.PENDING:

        query = query.filter(Inspection.inspector_id == user.id)

    if status:

        query = query.filter(Inspection.status == status)

    if action_type:

        query = query.filter(Inspection.action_type == action_type)

    if q:

        like = f"%{q}%"

        query = query.filter(

            (Inspection.inspect_no.like(like))

            | (PurchaseOrder.order_no.like(like))

            | (PurchaseOrder.product_name.like(like))

            | (PurchaseOrder.brand.like(like))

            | (PurchaseOrder.model.like(like))

            | (PurchaseOrder.tracking_no.like(like))

        )

    start, end = parse_date_range(date_from, date_to)

    if start or end:

        date_col = func.coalesce(Inspection.inspected_at, Inspection.created_at)

        if start:

            query = query.filter(date_col >= start)

        if end:

            query = query.filter(date_col < end)

    total = query.count()

    if status == InspectionStatus.PENDING:

        order_by = (Inspection.created_at.asc(), Inspection.purchase_order_id, Inspection.piece_no)  # 同一单的几件挨着、按第几件排

    else:

        order_by = (func.coalesce(Inspection.inspected_at, Inspection.created_at).desc(),)

    rows = (

        query.order_by(*order_by)

        .offset((page - 1) * size)

        .limit(size)

        .all()

    )

    names = map_staff_names(db, {task.inspector_id for task, _ in rows})

    tracking_map = map_cached_tracking(

        db,

        [

            (order.tracking_no, order.tracking_phone_suffix)

            for _, order in rows

            if order and order.tracking_no

        ],

    )

    items = []

    for task, order in rows:

        cached = tracking_map.get(order.tracking_no) if order and order.tracking_no else None

        items.append(

            _inspection_list_item(

                task,

                order,

                names,

                express_summary_text=express_summary(cached),

            )

        )

    # 待验货首页（PENDING、首页、未搜索）置顶展示议价成功 24h 内待召回商品
    recall_items = (
        _recall_items(db)
        if status == InspectionStatus.PENDING and page == 1 and not q
        else []
    )

    return InspectionListResponse(

        items=items,

        recall_items=recall_items,

        total=total,

        page=page,

        size=size,

    )





@router.get("/tasks/{task_id}", summary="查询验货任务详情", response_model=InspectionDetailOut)

def get_task(

    task_id: str,

    db: Session = Depends(get_db),

    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),

):

    task = db.get(Inspection, task_id)

    if not task:

        raise HTTPException(status_code=404, detail="验货任务不存在")

    if (

        user.role != StaffRole.ADMIN

        and task.status != InspectionStatus.PENDING

        and task.inspector_id != user.id

    ):

        raise HTTPException(status_code=403, detail="无权查看")

    order = db.get(PurchaseOrder, task.purchase_order_id)

    names = map_staff_names(db, {task.inspector_id}) if task.inspector_id else {}

    return _inspection_detail(task, order, names.get(task.inspector_id))





def _submit_reject(

    task: Inspection,

    order: PurchaseOrder,

    body: InspectionSubmit,

    user: Staff,

    db: Session,

    now: datetime,

) -> InspectionOut:

    reason = (body.remark or "").strip()

    if not reason:

        raise HTTPException(status_code=400, detail="请填写拒签原因")

    task.action_type = InspectionActionType.REJECT

    task.reject_images = body.reject_images[:4]

    task.remark = reason

    task.status = InspectionStatus.DONE

    task.inspector_id = user.id

    task.inspected_at = now

    order.status = OrderStatus.CANCELLED

    ensure_exception_for_reject(db, task, order, reason, user.id)
    db.flush()
    purchase_pieces.sync_order_status(db, order)

    db.add(

        StockEvent(

            purchase_order_id=order.id,

            event_type=StockEventType.REJECT,

            ref_no=task.inspect_no,

            operator_id=user.id,

            payload={"reason": reason},

        )

    )

    # OA/台账推送：验货计件（¥5 给验货人；REJECT 也计，与工资单口径一致）
    from app.services import oa_push

    oa_push.on_inspection_done(db, inspection=task)

    db.commit()

    db.refresh(task)

    return _inspection_out(task)





def _submit_inbound(

    task: Inspection,

    order: PurchaseOrder,

    body: InspectionSubmit,

    user: Staff,

    db: Session,

    now: datetime,

) -> InspectionOut:

    if not body.listing_images:

        raise HTTPException(status_code=400, detail="至少 1 张入库图")

    if body.inspection_result not in (InspectionResult.PASSED, InspectionResult.MISMATCH):

        raise HTTPException(status_code=400, detail="请选择验货结果")

    sku_code = (body.sku_code or "").strip().upper()

    if not sku_code:

        raise HTTPException(status_code=400, detail="货号不能为空")

    if db.query(Sku).filter(Sku.sku_code == sku_code).first():

        raise HTTPException(status_code=400, detail="货号已存在")

    serial_number = (body.serial_number or "").strip()

    if not serial_number:

        raise HTTPException(status_code=400, detail="序列号不能为空")

    location_code = (body.location_code or "").strip()

    if not location_code:

        raise HTTPException(status_code=400, detail="库位不能为空")



    cost_price = purchase_pieces.piece_cost(order, task.piece_no)
    if body.actual_amount is not None:

        if body.actual_amount <= 0:

            raise HTTPException(status_code=400, detail="实收金额须大于 0")

        cost_price = body.actual_amount



    task.action_type = InspectionActionType.INBOUND

    task.inspection_result = body.inspection_result

    task.listing_images = body.listing_images[:9]

    task.defect_images = body.defect_images[:4]

    task.defect_videos = body.defect_videos[:2]

    task.condition_grade = body.condition_grade

    task.location_code = location_code

    task.mismatch_remark = (body.mismatch_remark or "").strip() or None

    task.actual_amount = body.actual_amount

    task.remark = (body.remark or "").strip() or None

    task.status = InspectionStatus.DONE

    task.inspector_id = user.id

    task.inspected_at = now



    sku = Sku(

        sku_code=sku_code,

        serial_number=serial_number,

        barcode=(body.barcode or "").strip() or None,

        purchase_order_id=order.id,

        inspection_id=task.id,

        product_name=order.product_name,

        brand=order.brand,

        model=order.model,

        spec=order.spec,

        location_code=location_code,

        condition_grade=body.condition_grade,

        product_type=(body.product_type or "").strip() or None,

        condition_warning=order.condition_warning,

        condition_warning_text=order.condition_warning_text,

        cost_price=cost_price,

        suggest_price=calc_suggest_price(float(cost_price), body.condition_grade),

        status=SkuStatus.IN_STOCK,

        cover_url=(
            first_non_video_url(body.listing_images)
            or first_non_video_url(order.product_images)
            or body.listing_images[0]
        ),

        images=body.listing_images + body.defect_images,

        location_images=body.location_images[:4],

        tags=_resolve_tag_names(db, body.tags),

        inbound_at=now,

    )

    order.status = OrderStatus.IN_STOCK

    db.add(sku)

    db.flush()

    purchase_pieces.sync_order_status(db, order)
    # 有 69码 则自动查询一次条码库，写入 spu（失败不阻断入库）
    enrich_sku_spu(sku)

    bind_evidence_to_sku(db, task.id, sku.id)

    # 入库即登记自动上架（开关关着则不登记；跟入库同一笔事务落库）
    enqueue_on_inbound(db, sku)

    for et, ref in [

        (StockEventType.INSPECT, task.inspect_no),

        (StockEventType.INBOUND, sku_code),

    ]:

        db.add(

            StockEvent(

                purchase_order_id=order.id,

                sku_id=sku.id,

                event_type=et,

                ref_no=ref,

                operator_id=user.id,

            )

        )

    # OA/台账推送：验货计件（¥5 给验货人）
    from app.services import oa_push

    oa_push.on_inspection_done(db, inspection=task)

    db.commit()

    db.refresh(task)

    return _inspection_out(task)





@router.post("/tasks/{task_id}/submit", summary="提交验货结果", response_model=InspectionOut)

def submit_inspection(

    task_id: str,

    body: InspectionSubmit,

    db: Session = Depends(get_db),

    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),

):

    task = db.get(Inspection, task_id)

    if not task or task.status != InspectionStatus.PENDING:

        raise HTTPException(status_code=400, detail="任务不可提交")

    order = db.get(PurchaseOrder, task.purchase_order_id)

    if not order or order.status != OrderStatus.PENDING_INSPECT:

        raise HTTPException(status_code=400, detail="订单状态不正确")

    assert_ready_to_submit(db, task, order)

    now = datetime.utcnow()

    if body.action_type == InspectionActionType.REJECT:

        return _submit_reject(task, order, body, user, db, now)

    return _submit_inbound(task, order, body, user, db, now)


@router.patch("/tasks/{task_id}/actual-amount", summary="修改验货实收金额", response_model=InspectionOut)
def update_actual_amount(
    task_id: str,
    body: InspectionActualAmountUpdate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    task = db.get(Inspection, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="验货任务不存在")
    if task.status != InspectionStatus.DONE or task.action_type != InspectionActionType.INBOUND:
        raise HTTPException(status_code=400, detail="仅入库完成的验货任务可修改实收金额")

    order = db.get(PurchaseOrder, task.purchase_order_id)
    if not order:
        raise HTTPException(status_code=400, detail="采购订单不存在")

    new_amount = body.actual_amount
    if new_amount is not None and new_amount <= 0:
        raise HTTPException(status_code=400, detail="实收金额须大于 0")

    sku = db.query(Sku).filter(Sku.inspection_id == task.id).first()
    if not sku:
        raise HTTPException(status_code=400, detail="未找到对应库存记录")

    old_amount = task.actual_amount
    old_cost = sku.cost_price
    new_cost = new_amount if new_amount is not None else purchase_pieces.piece_cost(order, task.piece_no)

    task.actual_amount = new_amount
    sku.cost_price = new_cost
    sku.suggest_price = Decimal(
        str(calc_suggest_price(float(new_cost), sku.condition_grade))
    )

    db.add(
        StockEvent(
            purchase_order_id=order.id,
            sku_id=sku.id,
            event_type=StockEventType.INSPECT,
            ref_no=task.inspect_no,
            operator_id=user.id,
            payload={
                "action": "update_actual_amount",
                "old_actual_amount": str(old_amount) if old_amount is not None else None,
                "new_actual_amount": str(new_amount) if new_amount is not None else None,
                "old_cost_price": str(old_cost),
                "new_cost_price": str(new_cost),
            },
        )
    )

    db.commit()
    db.refresh(task)
    return _inspection_out(task)
