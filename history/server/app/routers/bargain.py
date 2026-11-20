"""采购议价会话（W07）：识别 / 报价 / 还价 / 谈妥。"""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import BargainSession, PurchaseOrder, Staff
from app.schemas._tz import CNDatetime
from app.services import bargain as svc

router = APIRouter(prefix="/api/bargain", tags=["采购议价"])

_ROLES = (StaffRole.PURCHASER, StaffRole.BUSINESS, StaffRole.NEGOTIATOR, StaffRole.ADMIN)


class OpenIn(BaseModel):
    platform: str = Field(default="xianyu", max_length=32)
    platform_item_id: str | None = Field(default=None, max_length=64)
    source_url: str | None = Field(default=None, max_length=1024)
    purchase_account: str | None = Field(default=None, max_length=64)
    seller_name: str | None = Field(default=None, max_length=128)
    gc_conversation_id: str | None = Field(default=None, max_length=36)
    snapshot_id: str | None = Field(default=None, max_length=36)
    listed_price: Decimal | None = None
    title: str | None = Field(default=None, max_length=512)
    note: str | None = None


class TransitionIn(BaseModel):
    action: str = Field(
        description="identify / quote / counter / deal / pause_request / pause_confirm / resume / close（pause=兼容别名）"
    )
    price: Decimal | None = None
    note: str | None = None


class CheckIn(BaseModel):
    key: str = Field(max_length=32, description="问题 key，如 model / condition")
    status: str = Field(description="PENDING / DECLARED / VERIFIED / SKIPPED")
    note: str | None = Field(default=None, description="核对说明或卖家原话")


class BindIn(BaseModel):
    purchase_order_id: str = Field(max_length=36)


class BargainOut(BaseModel):
    id: str
    platform: str
    platform_item_id: str | None = None
    source_url: str | None = None
    purchase_account: str | None = None
    seller_name: str | None = None
    gc_conversation_id: str | None = None
    snapshot_id: str | None = None
    purchase_order_id: str | None = None
    state: str
    paused_from: str | None = None
    our_price: Decimal | None = None
    their_price: Decimal | None = None
    deal_price: Decimal | None = None
    listed_price: Decimal | None = None
    title: str | None = None
    note: str | None = None
    round_no: int = 0
    events: list = Field(default_factory=list)
    checks: list = Field(default_factory=list)
    pending_required: int = 0
    askable: list[str] = Field(default_factory=list)
    identified_at: CNDatetime | None = None
    quoted_at: CNDatetime | None = None
    dealt_at: CNDatetime | None = None
    paused_at: CNDatetime | None = None
    closed_at: CNDatetime | None = None
    created_by_id: str | None = None
    assignee_id: str | None = None
    created_at: CNDatetime | None = None
    updated_at: CNDatetime | None = None

    model_config = {"from_attributes": True}


def _out(row: BargainSession) -> BargainOut:
    return BargainOut(**svc.session_out(row))


def _load(db: Session, session_id: str) -> BargainSession:
    row = db.get(BargainSession, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="议价会话不存在")
    return row


@router.post("/sessions", response_model=BargainOut, summary="开聊 / 复用未结束会话")
def open_session(body: OpenIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_ROLES))):
    row = svc.open_session(db, user_id=user.id, **body.model_dump())
    db.commit()
    db.refresh(row)
    return _out(row)


@router.get("/sessions", summary="议价会话列表")
def list_sessions(
    state: str | None = Query(default=None, description="IDENTIFY/QUOTE/COUNTER/DEAL/PAUSING/PAUSED/CLOSED，逗号分隔"),
    platform_item_id: str | None = None,
    purchase_account: str | None = None,
    purchase_order_id: str | None = Query(default=None, description="已绑的采购单 ID"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(*_ROLES)),
):
    q = db.query(BargainSession)
    if state:
        states = [s.strip().upper() for s in state.split(",") if s.strip()]
        if states:
            q = q.filter(BargainSession.state.in_(states))
    if platform_item_id:
        q = q.filter(BargainSession.platform_item_id == platform_item_id.strip())
    if purchase_account:
        q = q.filter(BargainSession.purchase_account == purchase_account.strip())
    if purchase_order_id:
        q = q.filter(BargainSession.purchase_order_id == purchase_order_id.strip())
    total = q.count()
    rows = q.order_by(BargainSession.updated_at.desc()).offset((page - 1) * size).limit(size).all()
    return {"items": [_out(r) for r in rows], "total": total, "page": page, "size": size}


@router.get("/sessions/{session_id}", response_model=BargainOut, summary="会话详情")
def get_session(session_id: str, db: Session = Depends(get_db), _: Staff = Depends(require_roles(*_ROLES))):
    return _out(_load(db, session_id))


@router.post("/sessions/{session_id}/transition", response_model=BargainOut, summary="推进状态：报价/还价/谈妥/暂停…")
def do_transition(
    session_id: str,
    body: TransitionIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_ROLES)),
):
    row = _load(db, session_id)
    svc.transition(db, row, action=body.action, price=body.price, note=body.note, user_id=user.id)
    db.commit()
    db.refresh(row)
    return _out(row)


@router.post("/sessions/{session_id}/checks", response_model=BargainOut, summary="核对必要问题（PC-090）")
def update_check(
    session_id: str,
    body: CheckIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_ROLES)),
):
    row = _load(db, session_id)
    svc.update_check(row, key=body.key, status=body.status, note=body.note, user_id=user.id)
    db.commit()
    db.refresh(row)
    return _out(row)


@router.post("/sessions/{session_id}/bind-purchase", response_model=BargainOut, summary="谈妥后绑采购单")
def bind_purchase(
    session_id: str,
    body: BindIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_ROLES)),
):
    row = _load(db, session_id)
    if db.get(PurchaseOrder, body.purchase_order_id) is None:
        raise HTTPException(status_code=404, detail="采购单不存在")
    svc.bind_purchase(db, row, body.purchase_order_id)
    db.commit()
    db.refresh(row)
    return _out(row)
