from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import StaffRole
from app.models import AnonymousFeedback, Staff
from app.schemas.feedback import (
    AnonymousFeedbackCreate,
    AnonymousFeedbackItem,
    AnonymousFeedbackUpdate,
)

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

ALLOWED_CATEGORIES = {"REWORK", "FEEDBACK", "COMPLAINT"}
ALLOWED_STATUSES = {"OPEN", "IN_PROGRESS", "CLOSED"}


def _serialize(item: AnonymousFeedback) -> AnonymousFeedbackItem:
    # 方案 B：序列化刻意不带 created_by_id / 提交人，保证对外匿名
    return AnonymousFeedbackItem(
        id=item.id,
        category=item.category,
        title=item.title,
        target=item.target,
        content=item.content,
        attachments=item.attachments or [],
        status=item.status,
        handled_note=item.handled_note,
        handled_at=item.handled_at,
        handled_by_name=item.handled_by_name,
        source=item.source,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


@router.post("/anonymous", summary="提交匿名反馈", response_model=AnonymousFeedbackItem)
def create_anonymous_feedback(
    payload: AnonymousFeedbackCreate,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    category = (payload.category or "").strip().upper()
    title = (payload.title or "").strip()
    content = (payload.content or "").strip()
    if category not in ALLOWED_CATEGORIES:
        raise HTTPException(status_code=400, detail="反馈类型不支持")
    if not title:
        raise HTTPException(status_code=400, detail="标题不能为空")
    if not content:
        raise HTTPException(status_code=400, detail="反馈内容不能为空")
    item = AnonymousFeedback(
        category=category,
        title=title,
        target=(payload.target or "").strip() or None,
        content=content,
        attachments=[u for u in (payload.attachments or []) if u],
        status="OPEN",
        # 方案 B：留痕供受限审计；响应里不回传
        created_by_id=user.id,
        source="MINIPROGRAM",
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return _serialize(item)


@router.get("/anonymous", summary="查询匿名反馈列表", response_model=list[AnonymousFeedbackItem])
def list_anonymous_feedback(
    q: str | None = None,
    category: str | None = None,
    status: str | None = None,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    query = db.query(AnonymousFeedback)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            (AnonymousFeedback.title.like(like))
            | (AnonymousFeedback.target.like(like))
            | (AnonymousFeedback.content.like(like))
            | (AnonymousFeedback.handled_note.like(like))
        )
    if category:
        normalized = category.strip().upper()
        if normalized not in ALLOWED_CATEGORIES:
            raise HTTPException(status_code=400, detail="反馈类型不支持")
        query = query.filter(AnonymousFeedback.category == normalized)
    if status:
        normalized = status.strip().upper()
        if normalized not in ALLOWED_STATUSES:
            raise HTTPException(status_code=400, detail="处理状态不支持")
        query = query.filter(AnonymousFeedback.status == normalized)
    rows = query.order_by(AnonymousFeedback.created_at.desc()).all()
    return [_serialize(row) for row in rows]


@router.patch("/anonymous/{feedback_id}", summary="处理匿名反馈", response_model=AnonymousFeedbackItem)
def update_anonymous_feedback(
    feedback_id: str,
    payload: AnonymousFeedbackUpdate,
    db: Session = Depends(get_db),
    current_user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    item = db.get(AnonymousFeedback, feedback_id)
    if not item:
        raise HTTPException(status_code=404, detail="反馈不存在")
    normalized = (payload.status or "").strip().upper()
    if normalized not in ALLOWED_STATUSES:
        raise HTTPException(status_code=400, detail="处理状态不支持")
    item.status = normalized
    item.handled_note = (payload.handled_note or "").strip() or None
    if normalized == "OPEN":
        item.handled_at = None
        item.handled_by_id = None
        item.handled_by_name = None
    else:
        item.handled_at = datetime.utcnow()
        item.handled_by_id = current_user.id
        item.handled_by_name = current_user.name or current_user.username
    # OA/台账推送：处理说明作为回复记录（仅在有处理人+处理说明时）
    from app.services import oa_push

    oa_push.on_feedback_handled(db, feedback=item, handler_role=current_user.role)
    db.commit()
    db.refresh(item)
    return _serialize(item)
