"""后台「统一登录」：平台分组（按 ERP 角色自动进组、手工挂人）、员工在统一登录里的状态、手动跑同步，
以及平台分组 → Frappe 角色、平台分组 → 能进哪些系统、Frappe 部门 → 平台分组的映射。

只给管理员。组名的规矩见 services/platform_groups.py，同步见 services/authentik_sync.py、
services/frappe_sync.py、services/authentik_access.py、services/frappe_departments.py，接入步骤见
docs/统一登录接入说明.md。后台的请求拦截器把 403 当成「登录失效」，所以这里参数不对一律回 400。
"""
import logging
from contextlib import ExitStack

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import require_roles
from app.enums import HUMAN_ROLES, StaffRole
from app.models import (
    AuthentikAccount,
    FrappeAccount,
    FrappeDepartmentMap,
    FrappeRoleMap,
    PlatformAccessMap,
    PlatformGroup,
    PlatformGroupMember,
    Staff,
)
from app.schemas.sso import (
    AccessMapOut,
    AccessMapWrite,
    AccessRowOut,
    AccessSystemOut,
    DepartmentMapRowOut,
    DepartmentMapWrite,
    DepartmentOptionOut,
    DepartmentOptionsOut,
    FrappeRoleMapWrite,
    FrappeRoleOptionsOut,
    FrappeRoleRowOut,
    PlatformGroupOut,
    PlatformGroupWrite,
    SsoAccountOut,
    SsoEmployeeOut,
    SsoGroupSourceOut,
    SsoMemberOut,
    SsoStaffOut,
    SsoStatusOut,
    SyncRequest,
)
from app.services import (
    authentik_access,
    authentik_sync,
    frappe_departments,
    frappe_sync,
    oidc_provider,
    platform_groups,
)
from app.services.platform_groups import GroupNameInvalid

router = APIRouter(prefix="/api/sso", tags=["sso"])
log = logging.getLogger(__name__)
_admin = require_roles(StaffRole.ADMIN)


@router.get("/status", summary="统一登录的配置状态", response_model=SsoStatusOut)
def status(_: Staff = Depends(_admin)):
    problem = None
    cfg = None
    try:
        cfg = oidc_provider.load_config()
    except oidc_provider.OidcDisabled:
        pass
    except oidc_provider.OidcMisconfigured as exc:
        problem = str(exc)
    return SsoStatusOut(
        oidc_enabled=settings.oidc_enabled,
        oidc_problem=problem,
        issuer=cfg.issuer if cfg else None,
        discovery_url=f"{cfg.issuer}/.well-known/openid-configuration" if cfg else None,
        jwks_url=f"{cfg.issuer}/jwks" if cfg else None,
        redirect_uris=sorted(cfg.redirect_uris) if cfg else [],
        kid=cfg.kid if cfg else None,
        sync_enabled=settings.authentik_sync_enabled,
        sync_problem=authentik_sync.why_not(dry_run=True),
        authentik_url=settings.authentik_url,
        user_path=settings.authentik_user_path,
        frappe_enabled=settings.frappe_sync_enabled,
        frappe_problem=frappe_sync.why_not(dry_run=True),
        frappe_url=settings.frappe_sync_url,
        access_enabled=settings.authentik_access_sync_enabled,
    )


# ---------------------------------------------------------------- 平台分组


def _clean_name(raw: str | None) -> str:
    try:
        return platform_groups.clean_group_name(raw)
    except GroupNameInvalid as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _clean_roles(roles: list[str]) -> list[str]:
    out: list[str] = []
    for role in roles:
        if role not in HUMAN_ROLES:
            raise HTTPException(status_code=400, detail=f"{role} 不能进统一登录的分组（设备账号不是人）")
        if role not in out:
            out.append(role)
    return out


def _clean_members(db: Session, staff_ids: list[str]) -> list[str]:
    ids = list(dict.fromkeys(staff_ids))
    if not ids:
        return []
    found = {
        s.id for s in db.query(Staff).filter(
            Staff.id.in_(ids), Staff.deleted_at.is_(None), Staff.role.in_(HUMAN_ROLES)
        )
    }
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(status_code=400, detail="有员工不存在、已删除，或者是设备账号，挂不进分组")
    return ids


def _clean_description(raw: str | None) -> str | None:
    text = (raw or "").strip()
    if len(text) > 255:
        raise HTTPException(status_code=400, detail="说明最多 255 个字")
    return text or None


def _group_out(group: PlatformGroup, member_ids: set[str], staff_by_id: dict[str, Staff],
               departments: list[str]) -> PlatformGroupOut:
    members = sorted((staff_by_id[i] for i in member_ids if i in staff_by_id), key=lambda s: s.staff_no)
    return PlatformGroupOut(
        id=group.id,
        name=group.name,
        description=group.description,
        roles=list(group.roles or []),
        members=[SsoMemberOut(id=s.id, username=s.username, name=s.name, staff_no=s.staff_no) for s in members],
        synced=platform_groups.is_confirmed(group),
        authentik_note=group.authentik_note,
        authentik_synced_at=group.authentik_synced_at,
        departments=departments,
        powerful=platform_groups.power_note(group),
    )


def _departments_by_group(department_map: dict[str, set[str]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for department in sorted(department_map):
        for group_id in department_map[department]:
            out.setdefault(group_id, []).append(department)
    return out


def _one(db: Session, group: PlatformGroup) -> PlatformGroupOut:
    ids = {m.staff_id for m in db.query(PlatformGroupMember).filter(PlatformGroupMember.group_id == group.id)}
    staff_by_id = {s.id: s for s in db.query(Staff).filter(Staff.id.in_(ids))} if ids else {}
    departments = [d for (d,) in db.query(FrappeDepartmentMap.department)
                   .filter(FrappeDepartmentMap.group_id == group.id).order_by(FrappeDepartmentMap.department)]
    return _group_out(group, ids, staff_by_id, departments)


def _commit(db: Session, name: str) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"已经有叫「{name}」的分组了") from exc


def _name_taken(db: Session, name: str, exclude_id: str | None = None) -> bool:
    q = db.query(PlatformGroup).filter(PlatformGroup.name == name)
    if exclude_id:
        q = q.filter(PlatformGroup.id != exclude_id)
    return q.first() is not None


@router.get("/groups", summary="平台分组列表", response_model=list[PlatformGroupOut])
def list_groups(_: Staff = Depends(_admin), db: Session = Depends(get_db)):
    members = platform_groups.membership(db)
    manual = members.manual
    ids = set().union(*manual.values()) if manual else set()
    staff_by_id = {s.id: s for s in db.query(Staff).filter(Staff.id.in_(ids))} if ids else {}
    by_group = _departments_by_group(members.department_map)
    return [_group_out(g, manual.get(g.id, set()), staff_by_id, by_group.get(g.id, [])) for g in members.groups]


@router.post("/groups", summary="新建平台分组", response_model=PlatformGroupOut)
def create_group(body: PlatformGroupWrite, _: Staff = Depends(_admin), db: Session = Depends(get_db)):
    # 先全部校验完再写：中途报错不留半截数据
    name = _clean_name(body.name)
    if _name_taken(db, name):
        raise HTTPException(status_code=400, detail=f"已经有叫「{name}」的分组了")
    description = _clean_description(body.description)
    roles = _clean_roles(body.roles or [])
    members = _clean_members(db, body.member_ids or [])
    group = PlatformGroup(name=name, description=description, roles=roles)
    db.add(group)
    db.flush()
    for staff_id in members:
        db.add(PlatformGroupMember(group_id=group.id, staff_id=staff_id))
    _commit(db, name)
    return _one(db, group)


@router.patch("/groups/{group_id}", summary="修改平台分组", response_model=PlatformGroupOut)
def update_group(group_id: str, body: PlatformGroupWrite, _: Staff = Depends(_admin), db: Session = Depends(get_db)):
    group = db.get(PlatformGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="分组不存在")
    data = body.model_dump(exclude_unset=True)
    # 先全部校验完再改：中途报错不留半截数据
    name = _clean_name(data["name"]) if "name" in data else group.name
    if name != group.name and _name_taken(db, name, exclude_id=group.id):
        raise HTTPException(status_code=400, detail=f"已经有叫「{name}」的分组了")
    description = _clean_description(data["description"]) if "description" in data else group.description
    roles = _clean_roles(data["roles"] or []) if "roles" in data else None
    wanted = _clean_members(db, data["member_ids"] or []) if "member_ids" in data else None
    # 改名后 authentik_name 还是旧名字：登录时先不发这个组，等同步把统一登录里的组也改过来
    group.name = name
    group.description = description
    if roles is not None:
        group.roles = roles
    if wanted is not None:
        db.query(PlatformGroupMember).filter(
            PlatformGroupMember.group_id == group.id, PlatformGroupMember.staff_id.notin_(wanted or [""])
        ).delete(synchronize_session=False)
        have = {m.staff_id for m in db.query(PlatformGroupMember).filter(PlatformGroupMember.group_id == group.id)}
        for staff_id in wanted:
            if staff_id not in have:
                db.add(PlatformGroupMember(group_id=group.id, staff_id=staff_id))
    _commit(db, group.name)
    return _one(db, group)


@router.delete("/groups/{group_id}", summary="删除平台分组", status_code=204)
def delete_group(group_id: str, _: Staff = Depends(_admin), db: Session = Depends(get_db)):
    """统一登录里那个组不删，下一轮同步把 ERP 的号移出去（组本身要删在统一登录里删）。

    这个组映射的 Frappe 角色、能进的系统、按部门进这个组的配置一起删：同步加上去的角色下一轮从组里的人身上撤掉，
    这个组在各系统上的绑定下一轮删掉。"""
    group = db.get(PlatformGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="分组不存在")
    db.query(PlatformGroupMember).filter(PlatformGroupMember.group_id == group.id).delete(synchronize_session=False)
    db.query(FrappeRoleMap).filter(FrappeRoleMap.group_id == group.id).delete(synchronize_session=False)
    db.query(PlatformAccessMap).filter(PlatformAccessMap.group_id == group.id).delete(synchronize_session=False)
    db.query(FrappeDepartmentMap).filter(FrappeDepartmentMap.group_id == group.id).delete(synchronize_session=False)
    db.delete(group)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------- 员工 / 同步


@router.get("/staff", summary="员工在统一登录里的状态（进哪些组、能不能登录）", response_model=list[SsoStaffOut])
def list_staff(_: Staff = Depends(_admin), db: Session = Depends(get_db)):
    rows = (
        db.query(Staff)
        .filter(Staff.deleted_at.is_(None), Staff.role.in_(HUMAN_ROLES))
        .order_by(Staff.staff_no)
        .all()
    )
    members = platform_groups.membership(db)
    accounts = {a.staff_id: a for a in db.query(AuthentikAccount).all()}
    role_map = frappe_sync.load_role_map(db)
    frappe_users = {a.staff_id: a.frappe_user for a in db.query(FrappeAccount).all()}
    access_map = authentik_access.load_access_map(db)
    out = []
    for staff in rows:
        confirmed = platform_groups.names_for(staff, members, confirmed_only=True)
        wanted = platform_groups.names_for(staff, members, confirmed_only=False)
        account = accounts.get(staff.id)
        reason = oidc_provider.refusal(db, staff)
        out.append(SsoStaffOut(
            id=staff.id, staff_no=staff.staff_no, username=staff.username, name=staff.name,
            role=staff.role, status=staff.status,
            groups=confirmed,
            groups_pending=[g for g in wanted if g not in confirmed],
            account=SsoAccountOut(authentik_username=account.authentik_username, synced_at=account.synced_at)
            if account else None,
            can_login=reason is None,
            reason=reason,
            frappe_roles=sorted(frappe_sync.roles_for(staff, members, role_map)),
            frappe_user=frappe_users.get(staff.id),
            systems=authentik_access.systems_for(staff, members, access_map),
            group_sources={
                g.name: [SsoGroupSourceOut(kind=kind, detail=detail) for kind, detail in members.sources(staff, g)]
                for g in members.of(staff)
            },
            frappe_employees=[
                SsoEmployeeOut(employee=e.employee, employee_name=e.employee_name, department=e.department,
                               path=e.path, status=e.status, synced_at=e.synced_at)
                for e in members.employees.get(staff.id, [])
            ],
        ))
    return out


@router.post("/authentik-sync", summary="手动跑一轮统一登录同步（默认只预演，含能进哪些系统）")
def run_authentik_sync(body: SyncRequest, user: Staff = Depends(_admin), db: Session = Depends(get_db)):
    why = authentik_sync.why_not(dry_run=body.dry_run)
    if why:
        raise HTTPException(status_code=400, detail=why)
    with authentik_sync.sync_lock(db) as got:
        if not got:
            raise HTTPException(status_code=409, detail="上一轮同步还在跑，等一会儿再点")
        log.info("统一登录同步：%s 在后台手动%s", user.username, "预演" if body.dry_run else "执行")
        api = authentik_sync.make_api()
        try:
            report = authentik_sync.run_sync(db, api, dry_run=body.dry_run)
        except authentik_sync.AuthentikError as exc:
            raise HTTPException(status_code=502, detail=f"读统一登录失败：{exc}") from exc
        finally:
            api.close()
    for line in report.lines():
        log.info("%s", line)
    return report.to_dict()


# ---------------------------------------------------------------- Frappe


def _frappe_rows(db: Session) -> list[FrappeRoleRowOut]:
    """所有员工一行，每个分组一行（没配角色的也列出来，页面上直接改）。"""
    role_map = frappe_sync.load_role_map(db)
    rows = [FrappeRoleRowOut(group_id=None, group_name=None, roles=role_map.everyone)]
    for g in db.query(PlatformGroup).order_by(PlatformGroup.name):
        rows.append(FrappeRoleRowOut(group_id=g.id, group_name=g.name, roles=role_map.by_group.get(g.id, [])))
    return rows


@router.get("/frappe/roles", summary="平台分组 → Frappe 角色", response_model=list[FrappeRoleRowOut])
def get_frappe_roles(_: Staff = Depends(_admin), db: Session = Depends(get_db)):
    return _frappe_rows(db)


@router.put("/frappe/roles", summary="改平台分组 → Frappe 角色（整张覆盖）", response_model=list[FrappeRoleRowOut])
def put_frappe_roles(body: FrappeRoleMapWrite, user: Staff = Depends(_admin), db: Session = Depends(get_db)):
    """角色名只查格式和 Frappe 自己管的那几个，不现查 Frappe：Frappe 连不上也能改，写错了同步预演会报出来。"""
    group_ids = {gid for (gid,) in db.query(PlatformGroup.id)}
    wanted: dict[str | None, set[str]] = {}
    # 先全部校验完再写：中途报错不留半截数据
    for row in body.rows:
        if row.group_id is not None and row.group_id not in group_ids:
            raise HTTPException(status_code=400, detail="有分组不存在（可能刚被删了），刷新页面再改")
        roles = wanted.setdefault(row.group_id, set())
        for raw in row.roles:
            try:
                roles.add(frappe_sync.clean_role_name(raw))
            except frappe_sync.RoleNameInvalid as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.query(FrappeRoleMap).delete(synchronize_session=False)
    for group_id, roles in wanted.items():
        for role in sorted(roles):
            db.add(FrappeRoleMap(group_id=group_id, role=role))
    db.commit()
    log.info("Frappe 角色映射：%s 改成 %s", user.username,
             {gid or "所有员工": sorted(r) for gid, r in wanted.items() if r})
    return _frappe_rows(db)


@router.get("/frappe/role-options", summary="Frappe 里能选的角色（现查 Frappe）", response_model=FrappeRoleOptionsOut)
def frappe_role_options(_: Staff = Depends(_admin)):
    """读不到不算错：页面照样能手填角色名，只是没有下拉可选。"""
    why = frappe_sync.why_not(dry_run=True)
    if why:
        return FrappeRoleOptionsOut(roles=[], problem=why)
    api = frappe_sync.make_api()
    try:
        roles = api.list_roles()
    except frappe_sync.FrappeError as exc:
        return FrappeRoleOptionsOut(roles=[], problem=f"读 Frappe 失败：{exc}")
    finally:
        api.close()
    usable = sorted(r for r, disabled in roles.items() if not disabled and r not in frappe_sync.BLOCKED_ROLES)
    return FrappeRoleOptionsOut(roles=usable)


@router.post("/frappe/sync", summary="手动跑一轮 Frappe 同步（默认只预演）")
def run_frappe_sync(body: SyncRequest, user: Staff = Depends(_admin), db: Session = Depends(get_db)):
    why = frappe_sync.why_not(dry_run=body.dry_run)
    if why:
        raise HTTPException(status_code=400, detail=why)
    with frappe_sync.sync_lock(db) as got:
        if not got:
            raise HTTPException(status_code=409, detail="上一轮 Frappe 同步还在跑，等一会儿再点")
        log.info("Frappe 同步：%s 在后台手动%s", user.username, "预演" if body.dry_run else "执行")
        api = frappe_sync.make_api()
        try:
            report = frappe_sync.run_sync(db, api, dry_run=body.dry_run)
        except frappe_sync.FrappeRefused as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except frappe_sync.FrappeError as exc:
            raise HTTPException(status_code=502, detail=f"读 Frappe 失败：{exc}") from exc
        finally:
            api.close()
    for line in report.lines():
        log.info("%s", line)
    return report.to_dict()


# ---------------------------------------------------------------- 能进哪些系统


def _system_out(system: authentik_access.System) -> AccessSystemOut:
    return AccessSystemOut(key=system.key, name=system.name, description=system.description,
                           apps=list(system.apps), note=system.note)


def _access_out(db: Session) -> AccessMapOut:
    """所有员工一行，每个分组一行（没配系统的也列出来，页面上直接改）。代码里已经没有的系统不列。"""
    access_map = authentik_access.load_access_map(db)

    def known(keys: list[str]) -> list[str]:
        return [k for k in keys if k in authentik_access.SYSTEM_BY_KEY]

    rows = [AccessRowOut(group_id=None, group_name=None, systems=known(access_map.everyone))]
    for g in db.query(PlatformGroup).order_by(PlatformGroup.name):
        rows.append(AccessRowOut(group_id=g.id, group_name=g.name, systems=known(access_map.by_group.get(g.id, []))))
    return AccessMapOut(
        systems=[_system_out(s) for s in authentik_access.SYSTEMS],
        fixed=[_system_out(s) for s in authentik_access.FIXED],
        rows=rows,
    )


@router.get("/access", summary="平台分组 → 能进哪些系统", response_model=AccessMapOut)
def get_access(_: Staff = Depends(_admin), db: Session = Depends(get_db)):
    return _access_out(db)


@router.put("/access", summary="改平台分组 → 能进哪些系统（整张覆盖）", response_model=AccessMapOut)
def put_access(body: AccessMapWrite, user: Staff = Depends(_admin), db: Session = Depends(get_db)):
    """只存 ERP 这边，统一登录里下一轮同步才生效（开关 AUTHENTIK_ACCESS_SYNC_ENABLED 开着时）。"""
    group_ids = {gid for (gid,) in db.query(PlatformGroup.id)}
    wanted: dict[str | None, set[str]] = {}
    # 先全部校验完再写：中途报错不留半截数据
    for row in body.rows:
        if row.group_id is not None and row.group_id not in group_ids:
            raise HTTPException(status_code=400, detail="有分组不存在（可能刚被删了），刷新页面再改")
        systems = wanted.setdefault(row.group_id, set())
        for raw in row.systems:
            try:
                systems.add(authentik_access.clean_system(raw))
            except authentik_access.SystemInvalid as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.query(PlatformAccessMap).delete(synchronize_session=False)
    for group_id, systems in wanted.items():
        for system in sorted(systems):
            db.add(PlatformAccessMap(group_id=group_id, system=system))
    db.commit()
    log.info("能进哪些系统：%s 改成 %s", user.username,
             {gid or "所有员工": sorted(v) for gid, v in wanted.items() if v})
    return _access_out(db)


# ---------------------------------------------------------------- 部门 → 分组


def _department_rows(db: Session) -> list[DepartmentMapRowOut]:
    """配了的部门一行（按部门名排），每行的分组按组名排。"""
    rank = {gid: i for i, (gid,) in enumerate(db.query(PlatformGroup.id).order_by(PlatformGroup.name))}
    return [
        DepartmentMapRowOut(department=d, group_ids=sorted(gids, key=lambda g: rank.get(g, len(rank))))
        for d, gids in sorted(platform_groups.load_department_map(db).items())
    ]


@router.get("/frappe/departments", summary="Frappe 部门 → 平台分组", response_model=list[DepartmentMapRowOut])
def get_departments(_: Staff = Depends(_admin), db: Session = Depends(get_db)):
    return _department_rows(db)


@router.put("/frappe/departments", summary="改 Frappe 部门 → 平台分组（整张覆盖）",
            response_model=list[DepartmentMapRowOut])
def put_departments(body: DepartmentMapWrite, user: Staff = Depends(_admin), db: Session = Depends(get_db)):
    """部门名只查格式，不现查 Frappe：Frappe 连不上也能改，部门名对不上 Frappe 同步预演会报出来。

    保存就算数：登录时发的组、员工列表马上按新的算，统一登录同步下一轮推组员，Frappe 同步下一轮给角色。"""
    groups = {gid: name for gid, name in db.query(PlatformGroup.id, PlatformGroup.name)}
    wanted: dict[str, set[str]] = {}
    # 先全部校验完再写：中途报错不留半截数据
    for row in body.rows:
        try:
            department = frappe_departments.clean_department_name(row.department)
        except frappe_departments.DepartmentNameInvalid as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if any(gid not in groups for gid in row.group_ids):
            raise HTTPException(status_code=400, detail="有分组不存在（可能刚被删了），刷新页面再改")
        wanted.setdefault(department, set()).update(row.group_ids)
    db.query(FrappeDepartmentMap).delete(synchronize_session=False)
    for department, group_ids in wanted.items():
        for group_id in sorted(group_ids):
            db.add(FrappeDepartmentMap(department=department, group_id=group_id))
    try:
        db.commit()
    except IntegrityError as exc:
        # MySQL 比部门名不分大小写：只差大小写的两行算同一个部门
        db.rollback()
        raise HTTPException(status_code=400, detail="有两行是同一个部门（只差大小写），合成一行再保存") from exc
    log.info("部门 → 分组：%s 改成 %s", user.username,
             {d: sorted(groups[g] for g in gids) for d, gids in sorted(wanted.items()) if gids})
    return _department_rows(db)


@router.get("/frappe/department-options", summary="Frappe 里的部门（现查 Frappe）", response_model=DepartmentOptionsOut)
def department_options(_: Staff = Depends(_admin)):
    """读不到不算错：页面照样能手填部门名，只是没有下拉可选。"""
    why = frappe_sync.why_not(dry_run=True)
    if why:
        return DepartmentOptionsOut(departments=[], problem=why)
    api = frappe_sync.make_api()
    try:
        rows = api.list_departments()
    except frappe_sync.FrappeError as exc:
        return DepartmentOptionsOut(departments=[], problem=f"读 Frappe 失败：{exc}")
    finally:
        api.close()
    return DepartmentOptionsOut(departments=[
        DepartmentOptionOut(name=d.name, parent=d.parent, depth=depth, disabled=d.disabled)
        for d, depth in frappe_departments.DepartmentTree.from_api(rows).ordered()
    ])


def _not_run(title: str, dry_run: bool, why: str, *, failed: bool = False) -> authentik_sync.SyncReport:
    return authentik_sync.SyncReport(dry_run=dry_run, actions=[], conflicts=[], notes=[] if failed else [why],
                                     errors=[why] if failed else [], counts={}, title=title, headline="没跑")


@router.post("/frappe/departments/sync",
             summary="部门 → 分组：先跑 Frappe 同步（读部门、给角色），接着跑统一登录同步（推组员）；默认只预演")
def run_department_sync(body: SyncRequest, user: Staff = Depends(_admin), db: Session = Depends(get_db)):
    """部门在 Frappe 同步里读、存，组员由统一登录同步推到 Authentik：卡片上点一次两个都跑，不用等两个定时器。

    统一登录同步用的是 Frappe 同步这一轮按刚读到的部门算的分组，预演时两边对得上。统一登录同步跑不了（没配好、
    开关没开）就只跑 Frappe 这一个，报告最后说一句；它读写出错也只记在它那一段，Frappe 这边已经改了的报告照给。"""
    why = frappe_sync.why_not(dry_run=body.dry_run)
    if why:
        raise HTTPException(status_code=400, detail=why)
    ak_why = authentik_sync.why_not(dry_run=body.dry_run)
    with ExitStack() as stack:
        # 和两个定时器、两张卡片上的按钮用同两把锁，先 Frappe 后统一登录
        if not stack.enter_context(frappe_sync.sync_lock(db)):
            raise HTTPException(status_code=409, detail="上一轮 Frappe 同步还在跑，等一会儿再点")
        if ak_why is None and not stack.enter_context(authentik_sync.sync_lock(db)):
            raise HTTPException(status_code=409, detail="上一轮统一登录同步还在跑，等一会儿再点")
        log.info("部门 → 分组：%s 在后台手动%s", user.username, "预演" if body.dry_run else "执行")
        api = frappe_sync.make_api()
        try:
            result = frappe_sync.run_round(db, api, dry_run=body.dry_run)
        except frappe_sync.FrappeRefused as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except frappe_sync.FrappeError as exc:
            raise HTTPException(status_code=502, detail=f"读 Frappe 失败：{exc}") from exc
        finally:
            api.close()
        report = result.report
        if ak_why is not None:
            report.sections.append(_not_run("统一登录同步", body.dry_run, ak_why))
        else:
            ak_api = authentik_sync.make_api()
            try:
                report.sections.append(
                    authentik_sync.run_sync(db, ak_api, dry_run=body.dry_run, members=result.members))
            except authentik_sync.AuthentikError as exc:
                report.sections.append(_not_run("统一登录同步", body.dry_run, f"读统一登录失败：{exc}", failed=True))
            finally:
                ak_api.close()
    for line in report.lines():
        log.info("%s", line)
    return report.to_dict()
