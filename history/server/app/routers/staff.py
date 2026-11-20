
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.schemas.auth import StaffCreate, StaffListResponse, StaffOut, StaffUpdate
from app.schemas.sim_card import SimCardOut, SimCardWrite
from app.services import sim_card as sim_card_service
from app.services import staff_account
from app.services.order_no import generate_staff_no
from app.services.password import hash_password

DEFAULT_RESET_PASSWORD = "DEMO_ONLY_REDACTED"
ALLOWED_STAFF_ROLES = {
    StaffRole.PURCHASER,
    StaffRole.WAREHOUSE,
    StaffRole.NEGOTIATOR,
    StaffRole.BUSINESS,
    StaffRole.SALES,
    StaffRole.FINANCE,
    StaffRole.ADMIN,
    StaffRole.RFID_DEVICE,
    StaffRole.CRAWLER,
    StaffRole.MARKET_BOT,
}

router = APIRouter(prefix="/api/staff", tags=["staff"])


def _ensure_editable_staff(staff: Staff | None, current: Staff, *, allow_self: bool = False) -> Staff:
    if not staff or staff.deleted_at:  # 已软删的员工对外等同不存在，不可再改状态/改密/重复删除
        raise HTTPException(status_code=404, detail="员工不存在")
    if staff.id == current.id and not allow_self:
        raise HTTPException(status_code=400, detail="不能操作当前登录账号")
    return staff


def _validate_role(role: str) -> None:
    if role not in ALLOWED_STAFF_ROLES:
        raise HTTPException(status_code=400, detail="无效的员工角色")


def _validate_status(status: str) -> None:
    if status not in {StaffStatus.PENDING, StaffStatus.ACTIVE, StaffStatus.DISABLED}:
        raise HTTPException(status_code=400, detail="无效的员工状态")


@router.get("", response_model=StaffListResponse, summary="员工列表")
def list_staff(
    page: int = Query(1, ge=1),
    size: int = Query(10, ge=1, le=100),
    sort_by: str = Query("staff_no"),
    sort_order: str = Query("asc"),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    if sort_by != "staff_no":
        raise HTTPException(status_code=400, detail="仅支持按工号排序")
    if sort_order not in {"asc", "desc"}:
        raise HTTPException(status_code=400, detail="无效的排序方向")

    query = db.query(Staff).filter(Staff.deleted_at.is_(None))  # 排除软删除的员工
    total = query.count()
    order_col = Staff.staff_no.asc() if sort_order == "asc" else Staff.staff_no.desc()
    items = query.order_by(order_col).offset((page - 1) * size).limit(size).all()
    return StaffListResponse(items=items, total=total, page=page, size=size)


@router.post("", response_model=StaffOut, summary="创建员工")
def create_staff(
    body: StaffCreate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    _validate_role(body.role)
    if db.query(Staff).filter(Staff.username == body.username).first():
        raise HTTPException(status_code=400, detail="用户名已存在")
    staff = Staff(
        staff_no=generate_staff_no(db),
        username=body.username,
        password_hash=hash_password(body.password),
        name=body.name,
        role=body.role,
        shop=body.shop,
        status=StaffStatus.ACTIVE,
    )
    db.add(staff)
    # OA/台账推送：同步员工到 OA（sync_staff_user）
    from app.services import oa_push

    oa_push.on_staff_synced(db, staff)
    db.commit()
    db.refresh(staff)
    return staff


class TitleRoleRule(BaseModel):
    keywords: list[str] = Field(default_factory=list)
    role: str


class TitleRolesIn(BaseModel):
    rules: list[TitleRoleRule]


class DeptRoleRule(BaseModel):
    keywords: list[str] = Field(default_factory=list)
    role: str
    github: bool = False


class DeptRolesIn(BaseModel):
    rules: list[DeptRoleRule]


@router.get("/settings/dingtalk-dept-roles", summary="钉钉部门 → ERP 角色对照（入职自动建号用，比职位先看）")
def get_dept_roles(_: Staff = Depends(require_roles(StaffRole.ADMIN)), db: Session = Depends(get_db)):
    from app.services import dingtalk_sync

    return {"rules": dingtalk_sync.dept_roles(db), "roles": list(dingtalk_sync.DEPT_ROLE_CHOICES)}


@router.put("/settings/dingtalk-dept-roles", summary="保存钉钉部门 → ERP 角色对照")
def put_dept_roles(body: DeptRolesIn, current: Staff = Depends(require_roles(StaffRole.ADMIN)), db: Session = Depends(get_db)):
    import json

    from app.services import dingtalk_sync
    from app.services.app_settings import set_setting

    try:
        rules = dingtalk_sync.clean_dept_roles([r.model_dump() for r in body.rules])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    set_setting(db, dingtalk_sync.DEPT_ROLES_KEY, json.dumps(rules, ensure_ascii=False), current.id)
    return {"rules": rules, "roles": list(dingtalk_sync.DEPT_ROLE_CHOICES)}


@router.get("/settings/dingtalk-title-roles", summary="钉钉职位 → ERP 角色对照（入职自动建号用）")
def get_title_roles(_: Staff = Depends(require_roles(StaffRole.ADMIN)), db: Session = Depends(get_db)):
    from app.services import dingtalk_sync

    return {"rules": dingtalk_sync.title_roles(db), "roles": list(dingtalk_sync.TITLE_ROLE_CHOICES)}


@router.get("/settings/dingtalk-members", summary="钉钉通讯录成员（后台「钉钉关联」下拉用）")
def dingtalk_members(_: Staff = Depends(require_roles(StaffRole.ADMIN))):
    from app.services import dingtalk

    if not dingtalk.configured():
        return {"items": [], "error": "ERP 没配钉钉应用"}
    try:
        users = dingtalk.list_users()
    except dingtalk.DingtalkError as exc:
        return {"items": [], "error": str(exc)}
    return {"items": sorted(({"userid": u["userid"], "name": u.get("name") or "", "title": u.get("title") or ""} for u in users),
                            key=lambda x: x["name"]), "error": None}


@router.put("/settings/dingtalk-title-roles", summary="保存钉钉职位 → ERP 角色对照")
def put_title_roles(body: TitleRolesIn, current: Staff = Depends(require_roles(StaffRole.ADMIN)), db: Session = Depends(get_db)):
    import json

    from app.services import dingtalk_sync
    from app.services.app_settings import set_setting

    try:
        rules = dingtalk_sync.clean_title_roles([r.model_dump() for r in body.rules])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    set_setting(db, dingtalk_sync.TITLE_ROLES_KEY, json.dumps(rules, ensure_ascii=False), current.id)
    return {"rules": rules, "roles": list(dingtalk_sync.TITLE_ROLE_CHOICES)}


@router.patch("/{staff_id}", response_model=StaffOut, summary="更新员工信息")
def update_staff(
    staff_id: str,
    body: StaffUpdate,
    current: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    data = body.model_dump(exclude_unset=True)
    # 自己的企微账号、GitHub 账号可以自己填；角色、状态这些还是不能自己改
    staff = _ensure_editable_staff(db.get(Staff, staff_id), current, allow_self=set(data) <= {"wecom_userid", "github_account"})
    if "wecom_userid" in data:
        data["wecom_userid"] = (data["wecom_userid"] or "").strip() or None
    if "dingtalk_userid" in data:
        # 关联了就是正式关联：通知发到他的钉钉，他在钉钉离职时 ERP 号自动删除（services/dingtalk_sync.py）
        data["dingtalk_userid"] = (data["dingtalk_userid"] or "").strip() or None
        if data["dingtalk_userid"]:
            other = (
                db.query(Staff)
                .filter(Staff.dingtalk_userid == data["dingtalk_userid"], Staff.id != staff.id, Staff.deleted_at.is_(None))
                .first()
            )
            if other:
                raise HTTPException(status_code=400, detail=f"这个钉钉成员已经关联了 {other.staff_no} {other.name}")
    if "github_account" in data:
        from app.services import github_invite

        try:
            data["github_account"] = github_invite.clean_account(data["github_account"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if "role" in data:
        _validate_role(data["role"])
    if "status" in data:
        _validate_status(data["status"])
    if "password" in data:
        staff.password_hash = hash_password(data.pop("password"))
    if "github_account" in data and staff.github_account and staff.github_account != data["github_account"]:
        github_invite.revoke(staff.github_account)
    for k, v in data.items():
        setattr(staff, k, v)
    if "github_account" in data:
        github_invite.invite(staff)
    # OA/台账推送：同步员工变更到 OA（sync_staff_user）
    from app.services import oa_push

    oa_push.on_staff_synced(db, staff)
    db.commit()
    db.refresh(staff)
    return staff


@router.post("/{staff_id}/github-invite", response_model=StaffOut, summary="按员工填的 GitHub 账号重新发代码仓库邀请")
def resend_github_invite(
    staff_id: str,
    current: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    from app.services import github_invite

    staff = _ensure_editable_staff(db.get(Staff, staff_id), current, allow_self=True)
    if not staff.github_account:
        raise HTTPException(status_code=400, detail="这个员工还没填 GitHub 账号")
    github_invite.invite(staff)
    db.commit()
    db.refresh(staff)
    return staff


@router.post("/{staff_id}/reset-password", response_model=StaffOut, summary="重置员工密码")
def reset_staff_password(
    staff_id: str,
    current: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    staff = _ensure_editable_staff(db.get(Staff, staff_id), current)
    staff.password_hash = hash_password(DEFAULT_RESET_PASSWORD)
    # OA/台账推送：密码变更同步到 OA（sync_staff_user）
    from app.services import oa_push

    oa_push.on_staff_synced(db, staff)
    db.commit()
    db.refresh(staff)
    return staff


@router.delete("/{staff_id}", status_code=204, summary="删除员工")
def delete_staff(
    staff_id: str,
    current: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    """软删除，做法见 services/staff_account.soft_delete；不再校验业务引用。"""
    staff = _ensure_editable_staff(db.get(Staff, staff_id), current)
    staff_account.soft_delete(db, staff)
    db.commit()
    return Response(status_code=204)


# ==================== 后台：员工手机卡信息管理（手机号 / ICCID / 空卡序列号）====================
def _require_staff(db: Session, staff_id: str) -> Staff:
    staff = db.get(Staff, staff_id)
    if staff and staff.deleted_at:
        staff = None
    if not staff:
        raise HTTPException(status_code=404, detail="员工不存在")
    return staff


@router.get("/{staff_id}/sim-cards", response_model=list[SimCardOut], summary="员工手机卡列表")
def list_staff_sim_cards(
    staff_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    _require_staff(db, staff_id)
    return sim_card_service.list_cards(db, staff_id)


@router.post("/{staff_id}/sim-cards", response_model=SimCardOut, summary="新增员工手机卡")
def create_staff_sim_card(
    staff_id: str,
    body: SimCardWrite,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    _require_staff(db, staff_id)
    return sim_card_service.create_card(db, staff_id, body.model_dump(exclude_unset=True))


@router.patch("/{staff_id}/sim-cards/{card_id}", response_model=SimCardOut, summary="更新员工手机卡")
def update_staff_sim_card(
    staff_id: str,
    card_id: str,
    body: SimCardWrite,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    _require_staff(db, staff_id)
    return sim_card_service.update_card(db, staff_id, card_id, body.model_dump(exclude_unset=True))


@router.delete("/{staff_id}/sim-cards/{card_id}", status_code=204, summary="删除员工手机卡")
def delete_staff_sim_card(
    staff_id: str,
    card_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    _require_staff(db, staff_id)
    sim_card_service.delete_card(db, staff_id, card_id)
    return Response(status_code=204)
