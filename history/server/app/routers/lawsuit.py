from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import Lawsuit, PurchaseOrder, Staff
from app.schemas.lawsuit import (
    LawsuitCreate,
    LawsuitDetail,
    LawsuitListItem,
    LawsuitListResponse,
    LawsuitUpdate,
)
from app.services.oss_media import first_image_list_urls, sign_media_payload
from app.services.order_no import generate_order_no
from app.services.query_filters import parse_date_range
from app.services.staff_lookup import map_staff_names

router = APIRouter(prefix="/api/lawsuits", tags=["lawsuit"])

# 仅采购与管理员可见；起诉流程为全员协作（任一采购/管理员都可接力整理）
_roles = require_roles(StaffRole.PURCHASER, StaffRole.ADMIN)


def _clean_urls(urls: list[str] | None) -> list[str]:
    return [u for u in (urls or []) if u]


def _name_ids(suit: Lawsuit) -> set[str]:
    return {i for i in (suit.created_by_id, suit.last_action_by_id) if i}


def _list_item(suit: Lawsuit, order: PurchaseOrder | None, names: dict[str, str]) -> LawsuitListItem:
    return LawsuitListItem(
        id=suit.id,
        lawsuit_no=suit.lawsuit_no,
        status=suit.status,
        purchase_order_id=suit.purchase_order_id,
        order_no=order.order_no if order else None,
        product_name=order.product_name if order else None,
        brand=order.brand if order else None,
        model=order.model if order else None,
        spec=order.spec if order else None,
        unit_price=order.unit_price if order else None,
        **(first_image_list_urls(order.product_images) if order else {"product_image": None, "product_image_thumb": None}),
        created_at=suit.created_at,
        created_by_name=names.get(suit.created_by_id),
    )


def _detail(suit: Lawsuit, order: PurchaseOrder | None, names: dict[str, str]) -> LawsuitDetail:
    data = {
        "id": suit.id,
        "lawsuit_no": suit.lawsuit_no,
        "status": suit.status,
        "purchase_order_id": suit.purchase_order_id,
        "order_no": order.order_no if order else None,
        "product_name": order.product_name if order else None,
        "brand": order.brand if order else None,
        "model": order.model if order else None,
        "spec": order.spec if order else None,
        "unit_price": order.unit_price if order else None,
        "seller_name": order.seller_name if order else None,
        "tracking_no": order.tracking_no if order else None,
        "evidence_media": list(suit.evidence_media or []),
        "lawyer_media": list(suit.lawyer_media or []),
        "court_media": list(suit.court_media or []),
        "judgment_media": list(suit.judgment_media or []),
        "created_at": suit.created_at,
        "created_by_name": names.get(suit.created_by_id),
        "last_action_by_name": names.get(suit.last_action_by_id) if suit.last_action_by_id else None,
        "last_action_at": suit.last_action_at,
    }
    if order:
        data.update(first_image_list_urls(order.product_images))
    else:
        data.update({"product_image": None, "product_image_thumb": None})
    return LawsuitDetail(**sign_media_payload(data))


@router.get("", summary="诉讼单列表", response_model=LawsuitListResponse)
def list_lawsuits(
    q: str | None = None,
    status: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(_roles),
):
    # 全员协作：采购与管理员都可看到全部起诉单（不按 created_by 过滤）
    query = db.query(Lawsuit, PurchaseOrder).outerjoin(
        PurchaseOrder, Lawsuit.purchase_order_id == PurchaseOrder.id
    )
    if status:
        query = query.filter(Lawsuit.status == status)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            (Lawsuit.lawsuit_no.like(like)) | (PurchaseOrder.order_no.like(like))
        )
    start, end = parse_date_range(date_from, date_to)
    if start:
        query = query.filter(Lawsuit.created_at >= start)
    if end:
        query = query.filter(Lawsuit.created_at < end)
    total = query.count()
    rows = (
        query.order_by(Lawsuit.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    names = map_staff_names(db, {suit.created_by_id for suit, _ in rows})
    items = [_list_item(suit, order, names) for suit, order in rows]
    return LawsuitListResponse(items=items, total=total, page=page, size=size)


@router.post("", summary="创建诉讼单", response_model=LawsuitDetail)
def create_lawsuit(
    body: LawsuitCreate,
    db: Session = Depends(get_db),
    user: Staff = Depends(_roles),
):
    order = db.get(PurchaseOrder, body.purchase_order_id)
    if not order:
        raise HTTPException(status_code=404, detail="采购单不存在")
    # 一个采购单只能有一张起诉单
    existing = db.query(Lawsuit).filter(Lawsuit.purchase_order_id == order.id).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"该采购单已有起诉单 {existing.lawsuit_no}")
    evidence_media = _clean_urls(body.evidence_media)
    # 证据优先：建单第一步必须先有证据材料，律师回复等后续补传
    if not evidence_media:
        raise HTTPException(status_code=400, detail="请先上传证据材料")
    now = datetime.utcnow()
    suit = Lawsuit(
        lawsuit_no=generate_order_no(db, "QS", Lawsuit, "lawsuit_no"),
        purchase_order_id=order.id,
        evidence_media=evidence_media,
        lawyer_media=_clean_urls(body.lawyer_media),
        court_media=_clean_urls(body.court_media),
        judgment_media=_clean_urls(body.judgment_media),
        created_by_id=user.id,
        last_action_by_id=user.id,
        last_action_at=now,
    )
    suit.status = suit.compute_status()
    db.add(suit)
    db.commit()
    db.refresh(suit)
    names = map_staff_names(db, _name_ids(suit))
    return _detail(suit, order, names)


def _get_accessible(db: Session, lawsuit_id: str, user: Staff) -> Lawsuit:
    # 全员协作：采购/管理员均可读写任意起诉单（不再校验创建人归属）
    suit = db.get(Lawsuit, lawsuit_id)
    if not suit:
        raise HTTPException(status_code=404, detail="起诉单不存在")
    return suit


@router.get("/{lawsuit_id}", summary="诉讼单详情", response_model=LawsuitDetail)
def get_lawsuit(
    lawsuit_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(_roles),
):
    suit = _get_accessible(db, lawsuit_id, user)
    order = db.get(PurchaseOrder, suit.purchase_order_id)
    names = map_staff_names(db, _name_ids(suit))
    return _detail(suit, order, names)


@router.patch("/{lawsuit_id}", summary="更新诉讼材料", response_model=LawsuitDetail)
def update_lawsuit(
    lawsuit_id: str,
    body: LawsuitUpdate,
    db: Session = Depends(get_db),
    user: Staff = Depends(_roles),
):
    suit = _get_accessible(db, lawsuit_id, user)
    touched = False
    if body.evidence_media is not None:
        evidence_media = _clean_urls(body.evidence_media)
        # 起诉单恒有证据材料，禁止删光导致状态回退到草稿
        if not evidence_media:
            raise HTTPException(status_code=400, detail="证据材料不能为空")
        suit.evidence_media = evidence_media
        touched = True
    if body.lawyer_media is not None:
        suit.lawyer_media = _clean_urls(body.lawyer_media)
        touched = True
    if body.court_media is not None:
        suit.court_media = _clean_urls(body.court_media)
        touched = True
    if body.judgment_media is not None:
        suit.judgment_media = _clean_urls(body.judgment_media)
        touched = True
    if touched:
        suit.last_action_by_id = user.id
        suit.last_action_at = datetime.utcnow()
    suit.status = suit.compute_status()
    db.commit()
    db.refresh(suit)
    order = db.get(PurchaseOrder, suit.purchase_order_id)
    names = map_staff_names(db, _name_ids(suit))
    return _detail(suit, order, names)


@router.delete("/{lawsuit_id}", summary="删除诉讼单", status_code=204)
def delete_lawsuit(
    lawsuit_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(_roles),
):
    suit = _get_accessible(db, lawsuit_id, user)
    db.delete(suit)
    db.commit()
