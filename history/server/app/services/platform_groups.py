"""平台分组：员工在统一登录里进哪些组。人和角色以 ERP 为准，各系统再按组给角色。

一个员工的组 = 按 ERP 角色自动进的组 + 手工挂上的组 + 按 Frappe HR 员工档案上的部门进的组（四期）。只有在职的真人
员工有组（设备账号不是人，停用、删除的员工一个组都没有，三种来源都一样）。表结构见 models/sso.py，默认分组在迁移
079 里种。

谁进哪个组只在 membership() 里算一遍：登录时发的组、统一登录同步推的组员、Frappe 的角色、能进哪些系统、后台的员工
列表都从它拿，三种来源谁也漏不掉。

# 按部门进组（四期）

HR 在 Frappe HR 的员工档案上填部门，后台「部门 → 分组」配哪个部门进哪些组（frappe_department_map；配在上级部门上，
下级部门的人也算）。档案由 Frappe 同步每一轮读一遍、存在 frappe_employee（services/frappe_departments.py），这里只读
这张表，不现查 Frappe：读不到 Frappe 时用的是上一轮存下的，不会因为一时连不上就把人移出组。只加不减：按角色进的、
手工挂的照旧，部门换了只动按部门进的那部分。

# 发给 Authentik 的组只发「同步对上了的」

Authentik 的登录源按组名把人放进同名组（「组匹配方式」选的是按名字关联，见接入说明）。要是 ERP
随手发一个和统一登录里别人的组重名的组名，员工一登录就进了别人的组。所以 groups_for_staff 默认只发
同步确认过的组：Authentik 里那个组是 ERP 同步建的（打了 erp_managed 标记）、组名也对得上。
新建的组、改了名还没同步的组、撞了名的组，等同步处理完再发。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.orm import Session

from app.enums import HUMAN_ROLES, StaffRole, StaffStatus
from app.models import FrappeDepartmentMap, FrappeEmployee, PlatformGroup, PlatformGroupMember, Staff

# Authentik 自带的组（authentik Admins 就是超级管理员组）都是这个开头，ERP 不许用
RESERVED_PREFIX = "authentik"
NAME_MAX_LEN = 80
# 和后台员工页（admin-web/src/utils/labels.js）同一套叫法
ROLE_LABELS = {
    StaffRole.ADMIN: "管理员",
    StaffRole.PURCHASER: "采购",
    StaffRole.WAREHOUSE: "仓管",
    StaffRole.NEGOTIATOR: "议价员",
    StaffRole.BUSINESS: "业务员",
    StaffRole.SALES: "销售",
    StaffRole.FINANCE: "财务",
}
# 权限大的组：后台「部门 → 分组」上配到部门时提醒一句（HR 把谁调进那个部门，谁就进这个组）
POWERFUL_GROUPS = {
    "ERP管理员": "各系统按它给管理员的权限",
    "工作台老板": "员工工作台按它给老板的权限",
    "工作台管理员": "员工工作台按它给管理员的权限",
}

# 进组的三种来源
BY_ROLE = "role"
BY_HAND = "manual"
BY_DEPARTMENT = "department"
# 员工档案的状态，只有这个算
ACTIVE_EMPLOYEE = "Active"


class GroupNameInvalid(ValueError):
    pass


def clean_group_name(raw: str | None) -> str:
    """组名校验：去掉首尾空白、非空、不超长、不以 authentik 开头、不带控制字符。"""
    name = (raw or "").strip()
    if not name:
        raise GroupNameInvalid("组名不能为空")
    if len(name) > NAME_MAX_LEN:
        raise GroupNameInvalid(f"组名最多 {NAME_MAX_LEN} 个字")
    if name.lower().startswith(RESERVED_PREFIX):
        raise GroupNameInvalid("authentik 开头的组名是统一登录自己的（管理员组就是这个开头），换一个")
    if any(ord(ch) < 32 for ch in name):
        raise GroupNameInvalid("组名里有看不见的字符")
    return name


def is_active_human(staff: Staff | None) -> bool:
    return bool(
        staff
        and not staff.deleted_at
        and staff.status == StaffStatus.ACTIVE
        and staff.role in HUMAN_ROLES
    )


def is_confirmed(group: PlatformGroup) -> bool:
    """同步对上了：Authentik 里有这个组、是 ERP 建的、组名也是现在这个。"""
    return bool(group.authentik_pk) and group.authentik_name == group.name


def power_note(group: PlatformGroup) -> str | None:
    """权限大的组给一句为什么；普通的组回 None。按 ERP 管理员角色进人的组也算（改了名的 ERP管理员）。"""
    if group.name in POWERFUL_GROUPS:
        return POWERFUL_GROUPS[group.name]
    if StaffRole.ADMIN in (group.roles or []):
        return "按 ERP 管理员角色进人的组"
    return None


@dataclass
class EmployeeLink:
    """Frappe 的一份员工档案，User ID 是某个 ERP 员工的占位邮箱（frappe_employee 的一行）。"""
    employee: str            # 档案号（Employee 的主键）
    employee_name: str
    staff_id: str
    department: str | None
    path: list[str]          # 部门和它的各级上级（自己在前），配在上级部门上的也算
    status: str              # Active / Inactive / Suspended / Left
    synced_at: datetime | None = None

    @property
    def counts(self) -> bool:
        """这份档案的部门算不算数：在职（Active）而且填了部门。"""
        return self.status == ACTIVE_EMPLOYEE and bool(self.department)


@dataclass
class Membership:
    """所有分组，和每个人因为什么进组。只读 ERP 自己的表，算一次各处共用。"""
    groups: list[PlatformGroup]                     # 按组名排
    manual: dict[str, set[str]]                     # 分组 → 手工挂的员工
    department_map: dict[str, set[str]]             # Frappe 部门 → 分组
    employees: dict[str, list[EmployeeLink]]        # 员工 → 关联到他的员工档案（含不在职的档案）
    # 分组 → 员工 → 让他进这个组的部门（映射里配的那一级，可能是他的上级部门）
    by_department: dict[str, dict[str, set[str]]] = field(init=False)

    def __post_init__(self) -> None:
        self.by_department = {}
        for links in self.employees.values():
            for e in links:
                if not e.counts:
                    continue
                for dept in e.path:
                    for group_id in self.department_map.get(dept, ()):
                        self.by_department.setdefault(group_id, {}).setdefault(e.staff_id, set()).add(dept)

    def sources(self, staff: Staff | None, group: PlatformGroup) -> list[tuple[str, str | None]]:
        """这个员工因为什么进这个组：[(来源, 说明)]，说明是 ERP 角色或者部门。不在职的一个都没有。"""
        if not is_active_human(staff):
            return []
        out: list[tuple[str, str | None]] = []
        if staff.role in (group.roles or []):
            out.append((BY_ROLE, staff.role))
        if staff.id in self.manual.get(group.id, ()):
            out.append((BY_HAND, None))
        for dept in sorted(self.by_department.get(group.id, {}).get(staff.id, ())):
            out.append((BY_DEPARTMENT, dept))
        return out

    def has(self, staff: Staff | None, group: PlatformGroup) -> bool:
        return bool(self.sources(staff, group))

    def of(self, staff: Staff | None) -> list[PlatformGroup]:
        """这个员工进的组（按组名排）。"""
        return [g for g in self.groups if self.has(staff, g)]

    def departments_of(self, staff_id: str) -> list[str]:
        """这个员工算数的部门（在职档案上填的），排好序。"""
        return sorted({e.department for e in self.employees.get(staff_id, ()) if e.counts})


def load_department_map(db: Session) -> dict[str, set[str]]:
    """Frappe 部门 → 分组。"""
    out: dict[str, set[str]] = {}
    for department, group_id in db.query(FrappeDepartmentMap.department, FrappeDepartmentMap.group_id).all():
        out.setdefault(department, set()).add(group_id)
    return out


def load_employee_links(db: Session) -> list[EmployeeLink]:
    """上一轮 Frappe 同步读到、存下来的员工档案。"""
    return [
        EmployeeLink(employee=row.employee, employee_name=row.employee_name or "", staff_id=row.staff_id,
                     department=row.department, path=list(row.department_path or []), status=row.status,
                     synced_at=row.synced_at)
        for row in db.query(FrappeEmployee).order_by(FrappeEmployee.employee).all()
    ]


def membership(db: Session, *, employees: list[EmployeeLink] | None = None) -> Membership:
    """所有分组，和每个人因为什么进组。

    employees：Frappe 同步这一轮刚读到的员工档案（还没存，预演时也不存）；不给就用上一轮存下的（frappe_employee）。
    """
    groups = db.query(PlatformGroup).order_by(PlatformGroup.name).all()
    manual: dict[str, set[str]] = {g.id: set() for g in groups}
    for group_id, staff_id in db.query(PlatformGroupMember.group_id, PlatformGroupMember.staff_id).all():
        manual.setdefault(group_id, set()).add(staff_id)
    by_staff: dict[str, list[EmployeeLink]] = {}
    for e in load_employee_links(db) if employees is None else employees:
        by_staff.setdefault(e.staff_id, []).append(e)
    return Membership(groups=groups, manual=manual, department_map=load_department_map(db), employees=by_staff)


def names_for(staff: Staff, m: Membership, *, confirmed_only: bool) -> list[str]:
    return sorted(g.name for g in m.of(staff) if not confirmed_only or is_confirmed(g))


def groups_for_staff(db: Session, staff: Staff, *, confirmed_only: bool = True) -> list[str]:
    """这个员工该进的组名（排好序）。发给 Authentik 用 confirmed_only=True。"""
    return names_for(staff, membership(db), confirmed_only=confirmed_only)
