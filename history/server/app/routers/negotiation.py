from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import SkuStatus, StaffRole, StockEventType
from app.models import PurchaseOrder, Sku, StockEvent, Staff
from app.models.inspection import Inspection
from app.schemas.negotiation import (
    NegotiationDetail,
    NegotiationHistoryDetail,
    NegotiationHistoryItem,
    NegotiationHistoryList,
    NegotiationItem,
    NegotiationSubmit,
    RecallSubmit,
)
from app.services.oss_media import sign_media_payload, thumb_url_for_cover
from app.services.query_filters import parse_date_range
from app.services.staff_lookup import map_staff_names

router = APIRouter(prefix="/api/negotiation", tags=["negotiation"])


def _base_sku_dict(sku: Sku) -> dict:
    return {
        "sku_id": sku.id,
        "sku_code": sku.sku_code,
        "product_name": sku.product_name,
        "brand": sku.brand,
        "model": sku.model,
        "spec": sku.spec,
        "condition_grade": sku.condition_grade,
        "cost_price": sku.cost_price,
        "suggest_price": sku.suggest_price,
        "cover_url": sku.cover_url,
        "location_images": sku.location_images or [],
        "inbound_at": sku.inbound_at,
        "location_code": sku.location_code,
        "condition_warning": sku.condition_warning,
        "condition_warning_text": sku.condition_warning_text,
    }


def _item_out(sku: Sku) -> NegotiationItem:
    payload = sign_media_payload(_base_sku_dict(sku))
    if payload.get("cover_url"):
        payload["cover_thumb_url"] = thumb_url_for_cover(payload["cover_url"])
    return NegotiationItem(**payload)


def _detail_out(sku: Sku, inspection: Inspection | None = None) -> NegotiationDetail:
    data = _base_sku_dict(sku)
    data["images"] = sku.images or []
    data["negotiation_remark"] = sku.negotiation_remark
    data["negotiation_media"] = sku.negotiation_media or []
    # 验货环节上传的图片/视频，供议价时核对货况（入库图 + 瑕疵图 + 瑕疵视频）
    if inspection is not None:
        inspection_media = (
            list(inspection.listing_images or [])
            + list(inspection.defect_images or [])
            + list(inspection.defect_videos or [])
        )
    else:
        inspection_media = list(sku.images or [])
    data["inspection_media"] = [u for u in inspection_media if u]
    payload = sign_media_payload(data)
    if payload.get("cover_url"):
        payload["cover_thumb_url"] = thumb_url_for_cover(payload["cover_url"])
    return NegotiationDetail(**payload)


def _load_inspection(db: Session, sku: Sku) -> Inspection | None:
    if not sku.inspection_id:
        return None
    return db.query(Inspection).filter(Inspection.id == sku.inspection_id).first()


def _negotiate_events(db: Session, sku_ids: list[str]) -> dict[str, StockEvent]:
    """批量取每个 SKU 的议价事件（NEGOTIATE）留痕，用于回显原始成本/操作人。"""
    if not sku_ids:
        return {}
    rows = (
        db.query(StockEvent)
        .filter(
            StockEvent.event_type == StockEventType.NEGOTIATE,
            StockEvent.sku_id.in_(sku_ids),
        )
        .order_by(StockEvent.created_at.asc())
        .all()
    )
    # 同一 SKU 只会议价一次；若有多条留痕取最新一条
    return {ev.sku_id: ev for ev in rows}


def _history_item_payload(sku: Sku, event: StockEvent | None, names: dict) -> dict:
    payload = sign_media_payload(
        {
            "sku_id": sku.id,
            "sku_code": sku.sku_code,
            "product_name": sku.product_name,
            "spec": sku.spec,
            "condition_grade": sku.condition_grade,
            "location_code": sku.location_code,
            "cover_url": sku.cover_url,
            "location_images": sku.location_images or [],
            "status": sku.status,
            "final_price": sku.cost_price,
            "negotiation_remark": sku.negotiation_remark,
            "negotiated_at": sku.negotiated_at,
            "recalled_at": sku.recalled_at,
        }
    )
    if payload.get("cover_url"):
        payload["cover_thumb_url"] = thumb_url_for_cover(payload["cover_url"])
    if event is not None:
        ep = event.payload or {}
        old_cost = ep.get("old_cost")
        payload["old_cost"] = old_cost if old_cost not in (None, "") else None
        payload["negotiator_name"] = names.get(event.operator_id)
    return payload


@router.get("/pending", response_model=list[NegotiationItem], summary="待议价列表")
def pending_negotiations(
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.NEGOTIATOR, StaffRole.ADMIN)),
):
    query = db.query(Sku).filter(
        Sku.status == SkuStatus.IN_STOCK,
        Sku.negotiated_at.is_(None),
        # 排除老系统期初库存占位SKU（方案A迁移），它们永不议价，不应堵在待办里
        # coalesce 兜底 tags 为 NULL 的行（JSON_CONTAINS(NULL,..) 返回 NULL，会误排除）
        func.coalesce(func.JSON_CONTAINS(Sku.tags, func.JSON_QUOTE("LEGACY_IMPORT")), 0) == 0,
    )
    if q:
        like = f"%{q.strip()}%"
        # 关联采购单以便按采购单号/闲鱼订单号反查对应订单
        query = query.outerjoin(PurchaseOrder, Sku.purchase_order_id == PurchaseOrder.id).filter(
            (Sku.sku_code.like(like))
            | (Sku.serial_number.like(like))
            | (Sku.product_name.like(like))
            | (Sku.brand.like(like))
            | (Sku.model.like(like))
            | (Sku.location_code.like(like))
            | (PurchaseOrder.order_no.like(like))
            | (PurchaseOrder.external_order_no.like(like))
        )
    # 按入库时间（北京日期区间换算）筛选：今天/昨天/近7天/自定义都由前端折算成 date_from/date_to
    start, end = parse_date_range(date_from, date_to)
    if start:
        query = query.filter(Sku.inbound_at >= start)
    if end:
        query = query.filter(Sku.inbound_at < end)
    rows = query.order_by(Sku.inbound_at.desc(), Sku.created_at.desc()).all()
    return [_item_out(sku) for sku in rows]


@router.get("/skus/{sku_code}", response_model=NegotiationDetail, summary="待议价商品详情")
def negotiation_detail(
    sku_code: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.NEGOTIATOR, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status != SkuStatus.IN_STOCK or sku.negotiated_at is not None:
        raise HTTPException(status_code=400, detail="商品不在待议价状态")
    return _detail_out(sku, _load_inspection(db, sku))


@router.get("/history", response_model=NegotiationHistoryList, summary="历史议价列表")
def negotiation_history(
    q: str | None = None,
    status: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.NEGOTIATOR, StaffRole.ADMIN)),
):
    # 历史议价只收已闭环（已召回快递）的；待召回快递的单子留在「待召回」待办里
    query = db.query(Sku).filter(Sku.negotiated_at.isnot(None), Sku.recalled_at.isnot(None))
    if q:
        like = f"%{q.strip()}%"
        # 与待议价搜索同口径：含序列号，并 join 采购单支持按采购单号/闲鱼订单号反查
        query = query.outerjoin(PurchaseOrder, Sku.purchase_order_id == PurchaseOrder.id).filter(
            (Sku.sku_code.like(like))
            | (Sku.serial_number.like(like))
            | (Sku.product_name.like(like))
            | (Sku.brand.like(like))
            | (Sku.model.like(like))
            | (Sku.location_code.like(like))
            | (PurchaseOrder.order_no.like(like))
            | (PurchaseOrder.external_order_no.like(like))
        )
    if status:
        query = query.filter(Sku.status == status)
    # 按议价时间（北京日期区间）筛选，negotiated_at 为 naive UTC
    start, end = parse_date_range(date_from, date_to)
    if start:
        query = query.filter(Sku.negotiated_at >= start)
    if end:
        query = query.filter(Sku.negotiated_at < end)
    total = query.count()
    rows = (
        query.order_by(Sku.negotiated_at.desc(), Sku.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    events = _negotiate_events(db, [s.id for s in rows])
    names = map_staff_names(db, {ev.operator_id for ev in events.values()})
    items = [
        NegotiationHistoryItem(**_history_item_payload(sku, events.get(sku.id), names))
        for sku in rows
    ]
    return NegotiationHistoryList(items=items, total=total, page=page, size=size)


def _build_history_detail(db: Session, sku: Sku) -> NegotiationHistoryDetail:
    """议价详情（历史/待召回共用）：商品信息 + 议价结果 + 改派凭证 + 验货素材。"""
    event = _negotiate_events(db, [sku.id]).get(sku.id)
    names = map_staff_names(db, {event.operator_id} if event else set())
    data = _history_item_payload(sku, event, names)
    data["brand"] = sku.brand
    data["model"] = sku.model
    data["inbound_at"] = sku.inbound_at
    data["images"] = sku.images or []
    data["negotiation_media"] = sku.negotiation_media or []
    data["redispatch_media"] = sku.redispatch_media or []
    if event is not None:
        data["need_transfer"] = bool((event.payload or {}).get("need_transfer"))
    inspection = _load_inspection(db, sku)
    if inspection is not None:
        inspection_media = (
            list(inspection.listing_images or [])
            + list(inspection.defect_images or [])
            + list(inspection.defect_videos or [])
        )
    else:
        inspection_media = list(sku.images or [])
    data["inspection_media"] = [u for u in inspection_media if u]
    payload = sign_media_payload(data)
    return NegotiationHistoryDetail(**payload)


@router.get("/history/{sku_code}", response_model=NegotiationHistoryDetail, summary="历史议价详情")
def negotiation_history_detail(
    sku_code: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.NEGOTIATOR, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.negotiated_at is None:
        raise HTTPException(status_code=400, detail="该商品尚未议价")
    return _build_history_detail(db, sku)


@router.get("/recall-pending", response_model=NegotiationHistoryList, summary="待召回快递列表")
def recall_pending(
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.NEGOTIATOR, StaffRole.ADMIN)),
):
    """待召回快递：议价已提交、改派凭证未补传（negotiated_at 有值且 recalled_at 为空）。"""
    query = db.query(Sku).filter(
        Sku.negotiated_at.isnot(None),
        Sku.recalled_at.is_(None),
        # 与待议价同口径排除老系统期初占位 SKU（它们由迁移直接置 recalled_at，理论上不会进这里，兜底）
        func.coalesce(func.JSON_CONTAINS(Sku.tags, func.JSON_QUOTE("LEGACY_IMPORT")), 0) == 0,
    )
    if q:
        like = f"%{q.strip()}%"
        query = query.outerjoin(PurchaseOrder, Sku.purchase_order_id == PurchaseOrder.id).filter(
            (Sku.sku_code.like(like))
            | (Sku.serial_number.like(like))
            | (Sku.product_name.like(like))
            | (Sku.brand.like(like))
            | (Sku.model.like(like))
            | (Sku.location_code.like(like))
            | (PurchaseOrder.order_no.like(like))
            | (PurchaseOrder.external_order_no.like(like))
        )
    start, end = parse_date_range(date_from, date_to)
    if start:
        query = query.filter(Sku.negotiated_at >= start)
    if end:
        query = query.filter(Sku.negotiated_at < end)
    total = query.count()
    rows = (
        query.order_by(Sku.negotiated_at.desc(), Sku.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    events = _negotiate_events(db, [s.id for s in rows])
    names = map_staff_names(db, {ev.operator_id for ev in events.values()})
    items = [
        NegotiationHistoryItem(**_history_item_payload(sku, events.get(sku.id), names))
        for sku in rows
    ]
    return NegotiationHistoryList(items=items, total=total, page=page, size=size)


@router.get("/recall/{sku_code}", response_model=NegotiationHistoryDetail, summary="召回快递补传详情")
def recall_detail(
    sku_code: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.NEGOTIATOR, StaffRole.ADMIN)),
):
    """召回快递补传页详情：回显商品 + 议价结果，供业务员补传顺丰改派凭证。"""
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.negotiated_at is None:
        raise HTTPException(status_code=400, detail="该商品尚未议价")
    if sku.recalled_at is not None:
        raise HTTPException(status_code=400, detail="该商品已召回快递")
    return _build_history_detail(db, sku)


@router.post("/skus/{sku_code}/recall", response_model=NegotiationHistoryDetail, summary="提交召回快递凭证")
def submit_recall(
    sku_code: str,
    body: RecallSubmit,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.NEGOTIATOR, StaffRole.ADMIN)),
):
    """召回快递闭环：业务员补传顺丰改派/再次派件凭证，议价流程完成、进历史议价。"""
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.negotiated_at is None:
        raise HTTPException(status_code=400, detail="该商品尚未议价")
    if sku.recalled_at is not None:
        raise HTTPException(status_code=400, detail="该商品已召回快递")
    media = [u for u in (body.redispatch_media or []) if u]
    if not media:
        raise HTTPException(status_code=400, detail="请上传顺丰改派/再次派件凭证")
    now = datetime.utcnow()
    sku.redispatch_media = media
    sku.recalled_at = now
    db.add(
        StockEvent(
            purchase_order_id=sku.purchase_order_id,
            sku_id=sku.id,
            event_type=StockEventType.EXPRESS_RECALL,
            ref_no=sku.sku_code,
            operator_id=user.id,
            payload={"media_count": len(media)},
        )
    )
    db.commit()
    db.refresh(sku)
    return _build_history_detail(db, sku)


@router.post("/skus/{sku_code}/submit", response_model=NegotiationDetail, summary="提交议价")
def submit_negotiation(
    sku_code: str,
    body: NegotiationSubmit,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.PURCHASER, StaffRole.NEGOTIATOR, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status != SkuStatus.IN_STOCK or sku.negotiated_at is not None:
        raise HTTPException(status_code=400, detail="商品不在待议价状态")
    now = datetime.utcnow()
    old_cost = sku.cost_price
    # 议价即修正实际采购价（与卖家议定的最终成交价），suggest_price 仅保留同值兼容
    sku.cost_price = body.suggest_price
    sku.suggest_price = body.suggest_price
    sku.negotiation_remark = (body.remark or "").strip() or None
    sku.negotiation_media = [u for u in (body.evidence or []) if u]
    sku.negotiated_at = now
    db.add(
        StockEvent(
            purchase_order_id=sku.purchase_order_id,
            sku_id=sku.id,
            event_type=StockEventType.NEGOTIATE,
            ref_no=sku.sku_code,
            operator_id=user.id,
            payload={
                "price": str(body.suggest_price),
                "old_cost": str(old_cost) if old_cost is not None else None,
                "remark": sku.negotiation_remark,
                "evidence_count": len(sku.negotiation_media),
                # 转账功能暂未实现，先记录采购员的开关意向
                "need_transfer": bool(body.need_transfer),
            },
        )
    )
    db.commit()
    db.refresh(sku)
    return _detail_out(sku, _load_inspection(db, sku))
