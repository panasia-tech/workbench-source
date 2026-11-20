from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.account_profile import GcAccountProfile
from app.schemas.account_profile import (
    GcAccountProfileListResponse,
    GcAccountProfileOut,
    GcAccountProfileUpdate,
)
from app.services.gc_bridge.account_profile_sync import sync_gc_account_profiles

router = APIRouter(prefix="/api/account-profiles", tags=["account-profile"])

# 账号档案是公司运营资产(谁有空谁补全),登录员工即可见可填——不做 owner 隔离。
# 必填手填项:运营商/套餐资费/法人名称/账号种类。全部填齐 → COMPLETE。
_REQUIRED_FIELDS = ("carrier", "plan_details", "legal_person", "account_type")


@router.get("", response_model=GcAccountProfileListResponse, summary="账号档案列表")
def list_profiles(
    status: str | None = Query(None, description="PENDING 待完善 / COMPLETE 已初始化"),
    q: str | None = Query(None, description="搜索(昵称/会员名/手机号/SN/IMEI)"),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    query = db.query(GcAccountProfile)
    if status:
        query = query.filter(GcAccountProfile.status == status)
    if q:
        like = f"%{q}%"
        query = query.filter(
            GcAccountProfile.nick.like(like)
            | GcAccountProfile.member_name.like(like)
            | GcAccountProfile.phone_number.like(like)
            | GcAccountProfile.device_serial.like(like)
            | GcAccountProfile.imei1.like(like)
            | GcAccountProfile.imei2.like(like)
        )
    total = query.count()
    items = (
        # 待完善排前,同状态按创建时间倒序
        query.order_by(GcAccountProfile.status.desc(), GcAccountProfile.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    return {"items": items, "total": total, "page": page, "size": size}


@router.get("/{profile_id}", response_model=GcAccountProfileOut, summary="账号档案详情")
def get_profile(
    profile_id: str,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    profile = db.get(GcAccountProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="档案不存在")
    return profile


@router.put("/{profile_id}", response_model=GcAccountProfileOut, summary="补全账号档案")
def update_profile(
    profile_id: str,
    body: GcAccountProfileUpdate,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    profile = db.get(GcAccountProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="档案不存在")
    for key, val in body.model_dump(exclude_unset=True).items():
        setattr(profile, key, val)
    # 必填手填项齐 → COMPLETE(记录完成人与时间);缺项回 PENDING(允许改回)
    if all(getattr(profile, f) for f in _REQUIRED_FIELDS):
        if profile.status != "COMPLETE":
            profile.status = "COMPLETE"
            profile.completed_at = datetime.now()
            profile.completed_by_id = staff.id
    else:
        profile.status = "PENDING"
        profile.completed_at = None
        profile.completed_by_id = None
    db.commit()
    db.refresh(profile)
    return profile


@router.post("/sync", summary="手动同步 gc 账号档案")
async def sync_profiles(
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    """从 gc 服务器拉最新账号/设备采集信息:新账号建档、空字段补齐、SN 匹配资产。"""
    try:
        result = await sync_gc_account_profiles(db)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"gc 服务器同步失败:{e}") from e
    return {"ok": True, **result}
