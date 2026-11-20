"""部门 → 分组（统一登录四期）：HR 在 Frappe HR 员工档案上填的部门，自动决定员工进哪些平台分组。

10-19 老板定的：员工档案由 HR 在 Frappe HR（hr.panasia.fun）里管，HR 给员工定的部门自动把人放进平台分组，各系统的
权限跟着走（统一登录的组 → Frappe 角色 → 能进哪些系统 → 工作台角色）。人和账号还是从 ERP 来（ERP 员工 → 统一登录
→ Frappe 的号，都是原来的同步）；部门只是进组的又一个来源，只加不减：按 ERP 角色进的、手工挂的照旧。

# 读什么、怎么认人

Frappe 同步（services/frappe_sync.py）每一轮读一遍员工档案（Employee：档案号、姓名、部门、User ID、状态）和部门
（Department）。档案按 User ID 认人：只认 ERP 的占位邮箱 <员工ID>@staff.panasia.fun（Frappe 同步给员工建的号，HR 在
档案的 User ID 里按姓名搜得到），而且这个员工 ID 在 ERP 里有。别的一律不认：没填 User ID 的、关联到 Frappe 里别的号的
（原来的员工、测试数据）。看着像填错了的（占位域名却对不上 ERP 员工；在配了分组的部门里，却没关联 ERP 的号）在报告里
提一句。状态是 Active 的档案才算，Left、Inactive、Suspended 都不算。Frappe 只许一个号关联一份在职档案（erpnext 的
validate_duplicate_user_id）；万一有两份，两份的部门都算，报告里提一句。

# 下级部门

部门是一棵树（根是「所有部门」）。「部门 → 分组」（frappe_department_map）配在一个部门上，它下面各级部门的人也算。
树按 parent_department 算（Frappe 自己画部门树就是按它），不靠 lft / rgt；万一绕成了圈，走到重复的就停。档案上的
部门在部门列表里找不到（被删了、没权限读）：只按它自己算，报告里提一句。

# 存在 ERP 里

读到的档案存在 frappe_employee（只存对上了 ERP 员工的，什么状态都存，后台看得出他为什么不算），每次读成功整张重写。
读不到 Frappe（连不上、没权限）：这一段报失败，接着用上一轮存下的，不会因为一时读不到就把人移出组；Frappe 同步别的
照做。预演什么都不写。登录、统一登录同步、后台都只读这张表（services/platform_groups.py 的 membership），不现查
Frappe。Frappe 同步关着时，部门停在最后一次读到的样子。

# 多久生效

改映射：保存就算数，统一登录同步下一轮（≤5 分钟）推组员，Frappe 同步下一轮给角色。HR 改了部门：下一轮 Frappe 同步
读到、存下（≤5 分钟），同一轮里 Frappe 的角色就按新的分组给；统一登录同步再下一轮把组员推到 Authentik（≤5 分钟），
能进哪些系统、工作台角色跟着变。两个定时器各跑各的，最长差不多 10 分钟；后台卡片上的「立即同步」两个一起跑。

# 谁能改

能在 Frappe 里改员工档案部门的人（HR Manager、System Manager）从此也能改员工在平台里的权限。权限大的组（ERP管理员、
工作台老板、工作台管理员，platform_groups.POWERFUL_GROUPS）配到部门上之前想清楚，后台卡片上有提醒。

# 报告

Frappe 同步的报告里单独一段「部门 → 分组」：这一轮读到的档案、部门和上一轮存下的比，谁因此进组、出组（同一张映射，
所以改映射引起的进出组不在这里，在统一登录同步的报告里）；映射里的部门 Frappe 里没有了（冲突）；上面那些提一句的。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from app.models import FrappeEmployee, Staff
from app.services.authentik_sync import STAFF_EMAIL_DOMAIN, SyncReport
from app.services.platform_groups import ACTIVE_EMPLOYEE, EmployeeLink, Membership

if TYPE_CHECKING:   # 只拿来标类型：frappe_sync 要导入这里，这里再导入它就绕成圈了
    from app.services.frappe_sync import FrappeApi

TITLE = "部门 → 分组"
# Frappe 的主键（部门名、档案号）最长 140
NAME_MAX_LEN = 140
_EMAIL_SUFFIX = "@" + STAFF_EMAIL_DOMAIN


class DepartmentNameInvalid(ValueError):
    pass


def clean_department_name(raw: str | None) -> str:
    """映射里的部门名：去掉首尾空白、非空、不超长、不带控制字符。不现查 Frappe（连不上也能配）。"""
    name = (raw or "").strip()
    if not name:
        raise DepartmentNameInvalid("部门不能为空")
    if len(name) > NAME_MAX_LEN:
        raise DepartmentNameInvalid(f"部门名最多 {NAME_MAX_LEN} 个字")
    if any(ord(ch) < 32 for ch in name):
        raise DepartmentNameInvalid("部门名里有看不见的字符")
    return name


def _label(staff: Staff) -> str:
    return f"{staff.username}（{staff.name or staff.username}）"


def _who(employee: str, employee_name: str) -> str:
    """报告里的档案：「HR-EMP-00001（张三）」；没姓名的后面空一格，和后面的汉字隔开。"""
    return f"{employee}（{employee_name}）" if employee_name else f"{employee} "


# ---------------------------------------------------------------- 部门树


@dataclass
class Department:
    name: str
    parent: str | None
    disabled: bool

    @classmethod
    def from_api(cls, data: dict) -> Department:
        return cls(name=str(data.get("name") or ""), parent=str(data.get("parent_department") or "") or None,
                   disabled=bool(int(data.get("disabled") or 0)))


class DepartmentTree:
    """Frappe 的部门树。按 parent_department 往上找（Frappe 自己画部门树就是按它）。"""

    def __init__(self, departments: list[Department]):
        self.by_name = {d.name: d for d in departments if d.name}

    @classmethod
    def from_api(cls, rows: list[dict]) -> DepartmentTree:
        return cls([Department.from_api(r) for r in rows])

    def __contains__(self, name: object) -> bool:
        return name in self.by_name

    def path(self, name: str) -> list[str]:
        """部门和它的各级上级（自己在前，一直到根）。不在树里的只有它自己；绕成了圈的，走到重复的就停。"""
        out: list[str] = []
        current: str | None = name
        while current and current not in out:
            out.append(current)
            node = self.by_name.get(current)
            current = node.parent if node else None
        return out

    def ordered(self) -> list[tuple[Department, int]]:
        """先上级后下级、同级按名字排，带深度（后台下拉里缩进用）。上级不在列表里的当根，绕成圈的排在最后。"""
        children: dict[str, list[Department]] = {}
        roots: list[Department] = []
        for d in self.by_name.values():
            if d.parent in self.by_name and d.parent != d.name:
                children.setdefault(d.parent, []).append(d)
            else:
                roots.append(d)
        out: list[tuple[Department, int]] = []
        seen: set[str] = set()

        def walk(start: Department) -> None:
            stack = [(start, 0)]
            while stack:
                d, depth = stack.pop()
                if d.name in seen:
                    continue
                seen.add(d.name)
                out.append((d, depth))
                stack += [(c, depth + 1) for c in sorted(children.get(d.name, []), key=lambda x: x.name, reverse=True)]

        for d in sorted(roots, key=lambda x: x.name) + sorted(self.by_name.values(), key=lambda x: x.name):
            walk(d)
        return out


# ---------------------------------------------------------------- 读档案


@dataclass
class Unlinked:
    """在职的档案，User ID 却不是 ERP 的号（没填、Frappe 里别的号）：部门不算。在配了分组的部门里才提一句。"""
    employee: str
    employee_name: str
    user_id: str
    path: list[str]


@dataclass
class EmployeesRead:
    links: list[EmployeeLink]      # 对上了 ERP 员工的档案（什么状态都有）
    tree: DepartmentTree
    unlinked: list[Unlinked]
    notes: list[str]


def read(api: FrappeApi, staff_rows: list[Staff]) -> EmployeesRead:
    """读 Frappe 的部门和员工档案，挑出 User ID 是 ERP 占位邮箱、对得上 ERP 员工的。读不到抛 FrappeError。"""
    tree = DepartmentTree.from_api(api.list_departments())
    rows = api.list_employees()
    now = datetime.utcnow()
    staff_by_key = {s.id.lower(): s for s in staff_rows}
    links: list[EmployeeLink] = []
    unlinked: list[Unlinked] = []
    notes: list[str] = []
    for row in sorted(rows, key=lambda r: str(r.get("name") or "")):
        name = str(row.get("name") or "")
        if not name:
            continue
        employee_name = str(row.get("employee_name") or "")
        status = str(row.get("status") or "")
        department = str(row.get("department") or "").strip() or None
        user_id = str(row.get("user_id") or "").strip()
        path = tree.path(department) if department else []
        active = status == ACTIVE_EMPLOYEE
        who = _who(name, employee_name)
        key = user_id.lower()
        placeholder = key.endswith(_EMAIL_SUFFIX)
        staff = staff_by_key.get(key[: -len(_EMAIL_SUFFIX)]) if placeholder else None
        if staff is None:
            if active and placeholder:
                notes.append(f"员工档案 {who}的 User ID {user_id} 对不上 ERP 员工，部门不算")
            elif active:
                unlinked.append(Unlinked(name, employee_name, user_id, path))
            continue
        if active and department and department not in tree:
            notes.append(f"员工档案 {who}的部门「{department}」不在 Frappe 的部门列表里，上级部门算不出来，只按它自己算")
        links.append(EmployeeLink(employee=name, employee_name=employee_name[:NAME_MAX_LEN], staff_id=staff.id,
                                  department=department, path=path, status=status[:32], synced_at=now))

    staff_by_id = {s.id: s for s in staff_rows}
    active_links: dict[str, list[EmployeeLink]] = {}
    for e in links:
        if e.status == ACTIVE_EMPLOYEE:
            active_links.setdefault(e.staff_id, []).append(e)
    for staff_id, items in active_links.items():
        if len(items) > 1:
            notes.append(f"{_label(staff_by_id[staff_id])}关联了 {len(items)} 份在职员工档案"
                         f"（{'、'.join(e.employee for e in items)}），几份的部门都算；Frappe 本来不许这样，留一份就好")
    return EmployeesRead(links=links, tree=tree, unlinked=unlinked, notes=notes)


def record(db: Session, links: list[EmployeeLink]) -> None:
    """读成功了：整张换成这一轮读到的（有的改、新的加、没了的删）。"""
    old = {row.employee: row for row in db.query(FrappeEmployee).all()}
    for e in links:
        row = old.pop(e.employee, None)
        if row is None:
            row = FrappeEmployee(employee=e.employee)
            db.add(row)
        row.staff_id, row.employee_name, row.department = e.staff_id, e.employee_name, e.department
        row.department_path, row.status = list(e.path), e.status
        row.synced_at = e.synced_at or datetime.utcnow()
    for row in old.values():
        db.delete(row)
    db.commit()


# ---------------------------------------------------------------- 报告


def _why(before: Membership, after: Membership, staff_id: str) -> str:
    was, now = before.departments_of(staff_id), after.departments_of(staff_id)
    if was == now:
        return f"{'、'.join(now)} 的上级部门变了"
    if not now:
        links = after.employees.get(staff_id, [])
        if not links:
            return "员工档案不再关联他的号"
        off = sorted({e.status for e in links if e.status != ACTIVE_EMPLOYEE and e.department})
        if off:
            return f"员工档案改成了 {'、'.join(off)}"
    return f"部门 {'、'.join(was) or '（无）'}→{'、'.join(now) or '（无）'}"


def section(staff_rows: list[Staff], before: Membership, after: Membership, got: EmployeesRead, *,
            dry_run: bool) -> SyncReport:
    """这一段报告。before：上一轮存下的档案算出来的；after：这一轮读到的算出来的（映射是同一张）。"""
    actions: list[str] = []
    counts = {"按部门进组": 0, "按部门出组": 0}
    for staff in staff_rows:
        old = {g.id: g.name for g in before.of(staff)}
        new = {g.id: g.name for g in after.of(staff)}
        joined = sorted(new[k] for k in set(new) - set(old))
        left = sorted(old[k] for k in set(old) - set(new))
        if not joined and not left:
            continue
        counts["按部门进组"] += len(joined)
        counts["按部门出组"] += len(left)
        words = ([("进" + "".join(f"「{n}」" for n in joined))] if joined else []) + (
            [("出" + "".join(f"「{n}」" for n in left))] if left else [])
        actions.append(f"{_label(staff)}：{'，'.join(words)}（{_why(before, after, staff.id)}）")
    conflicts = [
        f"映射里的部门「{d}」Frappe 里没有（改了名或者删了？），没人按它进组：在「部门 → 分组」卡片上改"
        for d in sorted(after.department_map) if d not in got.tree
    ]
    notes = list(got.notes)
    mapped = set(after.department_map)
    stray = [u for u in got.unlinked if mapped & set(u.path)]
    if stray:
        items = "、".join(f"{u.employee_name}（{u.employee}，{u.user_id or 'User ID 没填'}）" if u.employee_name
                         else f"{u.employee}（{u.user_id or 'User ID 没填'}）" for u in stray)
        notes.append(f"这些在职员工档案在配了分组的部门里，User ID 却不是 ERP 的号，部门不算：{items}")
    return SyncReport(dry_run=dry_run, actions=actions, conflicts=conflicts, notes=notes, errors=[], counts=counts,
                      title=TITLE)


def failed_section(error: str, *, dry_run: bool) -> SyncReport:
    """读不到档案、部门：这一段报失败（定时器退出码 1），部门照上一轮存下的算。"""
    return SyncReport(dry_run=dry_run, actions=[], conflicts=[], notes=[],
                      errors=[f"读 Frappe 的员工档案、部门失败：{error}；部门照上一轮读到的算"], counts={},
                      title=TITLE, headline="没读到")
