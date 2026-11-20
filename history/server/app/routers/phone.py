from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.enums import StaffRole
from app.models.phone import PhoneNumber
from app.schemas.phone import (
    PhoneNumberCreate,
    PhoneNumberListResponse,
    PhoneNumberOut,
    PhoneNumberUpdate,
)

router = APIRouter(prefix="/api/phone", tags=["phone"])

# 权限口径：员工各自登记/查看/管理自己的号码(owner_id=本人)，管理员看/管全部。
# 历史数据 owner_id 为空的仅管理员可见。


def _is_admin(staff) -> bool:
    return staff.role == StaffRole.ADMIN


def _get_owned_phone(db: Session, staff, phone_id: str) -> PhoneNumber:
    phone = db.query(PhoneNumber).filter(PhoneNumber.id == phone_id).first()
    if not phone or (not _is_admin(staff) and phone.owner_id != staff.id):
        raise HTTPException(status_code=404, detail="手机号不存在")
    return phone


@router.get("/numbers", response_model=PhoneNumberListResponse, summary="手机号列表")
def list_numbers(
    q: str | None = Query(None, description="搜索关键词(姓名/号码/闲鱼会员名)"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    query = db.query(PhoneNumber)
    if not _is_admin(staff):
        query = query.filter(PhoneNumber.owner_id == staff.id)
    if q:
        like = f"%{q}%"
        query = query.filter(
            PhoneNumber.name.like(like)
            | PhoneNumber.phone_number.like(like)
            | PhoneNumber.xianyu_member_name.like(like)
        )
    total = query.count()
    items = (
        query.order_by(PhoneNumber.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    return {"items": items, "total": total, "page": page, "size": size}


@router.get("/numbers/{phone_id}", response_model=PhoneNumberOut, summary="手机号详情")
def get_number(
    phone_id: str,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    return _get_owned_phone(db, staff, phone_id)


@router.post("/numbers", response_model=PhoneNumberOut, summary="登记手机号")
def create_number(
    body: PhoneNumberCreate,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    existing = db.query(PhoneNumber).filter(PhoneNumber.phone_number == body.phone_number).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"号码 {body.phone_number} 已存在")
    phone = PhoneNumber(**body.model_dump())
    if not _is_admin(staff):
        phone.owner_id = staff.id
    db.add(phone)
    db.commit()
    db.refresh(phone)
    return phone


@router.put("/numbers/{phone_id}", response_model=PhoneNumberOut, summary="更新手机号")
def update_number(
    phone_id: str,
    body: PhoneNumberUpdate,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    phone = _get_owned_phone(db, staff, phone_id)
    updates = body.model_dump(exclude_unset=True)
    if updates.get("phone_number"):
        dup = (
            db.query(PhoneNumber)
            .filter(PhoneNumber.phone_number == updates["phone_number"], PhoneNumber.id != phone_id)
            .first()
        )
        if dup:
            raise HTTPException(status_code=409, detail=f"号码 {updates['phone_number']} 已存在")
    for key, val in updates.items():
        setattr(phone, key, val)
    db.commit()
    db.refresh(phone)
    return phone


@router.delete("/numbers/{phone_id}", summary="删除手机号")
def delete_number(
    phone_id: str,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    phone = _get_owned_phone(db, staff, phone_id)
    db.delete(phone)
    db.commit()
    return {"detail": "ok"}
