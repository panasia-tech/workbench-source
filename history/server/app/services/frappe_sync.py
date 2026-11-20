"""ERP 员工 → Frappe（hr.panasia.fun）的同步：开号、按平台分组给角色、停用，都从 ERP 推过去。

hr.panasia.fun 一个站点装着 HR（hrms，连带 erpnext）、Learning（lms）、Frappe CRM，同一套用户和角色。由
scripts/run_frappe_sync.py（systemd timer，每 5 分钟）定时跑，后台「统一登录」页也能手动点；开关
FRAPPE_SYNC_ENABLED 关着时只能预演。接入步骤见 docs/统一登录接入说明.md。

# 为什么要先建号

Frappe 从统一登录登录（Social Login Key）时只按邮箱认人：邮箱就是 Frappe 用户的主键，找到就登进去，找不到
又关了注册（sign_ups=Deny）就拒绝（frappe/utils/oauth.py 的 login_oauth_user）。所以人要先在 Frappe 里建好。
邮箱是统一登录同步写进 Authentik 的占位邮箱 <员工ID>@staff.panasia.fun（authentik_sync.staff_email，为什么
用员工 ID 见那里）。Frappe 也没有「按统一登录的组给角色」，角色在这里按 ERP 的平台分组给。

只给「能用 ERP 账号登录统一登录」的在职员工开号（统一登录的号开好了，见 oidc_provider.refusal）：号没开好的人
从统一登录过不来，Frappe 里给他建了号也用不上。停号只看 ERP：统一登录那边一时没对上，不会把 Frappe 的号停了
又开、把人踢下线。

# 只碰同步建的号

「同步建的」= 邮箱是 @staff.panasia.fun 的占位邮箱，而且 Frappe 里这个号的创建人（owner）就是同步用的 API
用户。Frappe 记创建人用的是当时登录的人，接口里改不了。所以：
  - Frappe 里现有的人（Administrator、工作台服务账号、原来的员工）邮箱不是占位域名，一律不碰；
  - 占位域名但不是这个 API 用户建的（有人手工建的、改名过来的）：报冲突，不碰；
  - API 用户不能是 Administrator：Administrator 手工建的号也会被当成同步建的。换 key 要在同一个 API 用户上
    重新生成，换了用户，之前建的号就都成了「不是同步建的」。

# 角色

映射表 frappe_role_map：平台分组 → Frappe 角色，分组为空 = 所有员工。一个人该有的角色 = 他进的分组（按 ERP
角色自动进 + 手工挂 + 按 Frappe 部门进，platform_groups.membership）在映射里对应的角色。

给：映射里该有、Frappe 里还没有的，加上。撤：只撤同步自己加上去的（记在 frappe_account.roles）——换了分组、
映射里删掉了某个角色，当初由同步给的就撤掉。别人给的一律不动：HR 在 Frappe 里手工给的、CRM 里经理拉人给的、
各 app 自己加的，哪怕是映射里有的角色名也不撤。frappe_account 丢了，同步只会少撤，不会多撤。

只补不撤的角色（ADD_ONLY_ROLES）：LMS Student 是 Learning 给每个新号自动加的学员身份，员工进 Learning 靠它，
映射里有就补，从不撤。

映射里的角色在 Frappe 里没有或者停用了：报冲突、先不给，也不因此停号——写错一个角色名不该把人都停掉。
有几个角色 Frappe 自己管，不能写进映射（BLOCKED_ROLES）：同步给了会被 Frappe 自己删掉或加回来，每轮都要改一遍。

改角色时先重新读一遍这个人现在的角色，在它上面增删，再整张写回（Frappe 的接口只能整张写子表），读和写之间
只隔几十毫秒，人工刚加的角色不会被冲掉。写完对一遍 Frappe 返回的结果：被 Frappe 自己的规则改回去了就报失败，
好让人看见、把那个角色从映射里拿掉。

# 停用

不在职了（停用、删除、改成设备账号），或者不再属于任何给 Frappe 角色的分组：enabled=0（Frappe 会顺手踢掉他的
登录会话；停用的号从统一登录、密码都登不进去）。角色不动、号不删：HR 的历史记录挂在上面。恢复了再启用，
角色按那时的分组对一遍。

# 部门 → 分组（四期）

每一轮顺带读一遍 Frappe HR 的员工档案和部门（services/frappe_departments.py），存进 ERP，按部门进组就按它算；
同一轮里给角色用的就是刚读到的部门。报告里单独一段。档案、部门读不到不拖累别的：那一段报失败，部门照上一轮存下的算。

# 幂等

每一轮都是「读 ERP + 读 Frappe → 算差异 → 只改有差异的」，跑两遍第二遍什么都不做；中途失败了下一轮接着补。
预演只读 Frappe、打印要改什么，Frappe 和 ERP 都不写。
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import quote, urlsplit

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.enums import HUMAN_ROLES, StaffStatus
from app.models import AuthentikAccount, FrappeAccount, FrappeRoleMap, Staff
from app.services import authentik_sync, frappe_departments, oidc_provider, platform_groups
from app.services.authentik_sync import STAFF_EMAIL_DOMAIN, SyncReport, staff_email
from app.services.platform_groups import Membership, is_active_human

log = logging.getLogger(__name__)

LOCK_NAME = "frappe_sync"
ROLE_MAX_LEN = 140
_EMAIL_SUFFIX = "@" + STAFF_EMAIL_DOMAIN
_TAG_RE = re.compile(r"<[^>]+>")
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

_AUTO = "Frappe 按用户类型自动给"
# Frappe 自己管的角色，不能写进映射。值是给人看的原因，后台保存映射时原样报出来
BLOCKED_ROLES = {
    "Administrator": "只属于 Frappe 的 Administrator",
    "Guest": _AUTO,
    "All": _AUTO,
    "Desk User": _AUTO,
    # erpnext/setup/doctype/employee/employee.py 的 validate_employee_role（erpnext 和 hrms 都挂在 User 的
    # validate 上）：没有员工档案关联到这个号就删掉。HR 建档时填上 User ID，Frappe 自己就加上 Employee
    "Employee": "跟着 Frappe 的员工档案走：HR 建档时填上 User ID，Frappe 自己就给了",
    "Employee Self Service": "跟着 Frappe 的员工档案走：没有员工档案的号，Frappe 保存时会自己删掉",
    # hrms/overrides/employee_master.py 的 update_approver_user_roles：谁是审批人，每次保存都给他加回来
    "Leave Approver": "Frappe 按审批人自动给：员工档案里设成请假审批人就有",
    "Expense Approver": "Frappe 按审批人自动给：员工档案里设成报销审批人就有",
}
# 只补不撤：lms/lms/user.py 的 add_lms_student_role 给每个新号都加 LMS Student，员工进 Learning 靠它
ADD_ONLY_ROLES = frozenset({"LMS Student"})


class FrappeError(Exception):
    """调 Frappe 的 API 失败（连不上、没权限、参数不对）。"""


class FrappeRefused(FrappeError):
    """配置不对，同步不跑（key 不认、API 用户是 Administrator）。"""


# ---------------------------------------------------------------- 映射


class RoleNameInvalid(ValueError):
    pass


def clean_role_name(raw: str | None) -> str:
    """映射里的角色名：去掉首尾空白、非空、不超长、不带控制字符、不是 Frappe 自己管的角色。"""
    name = (raw or "").strip()
    if not name:
        raise RoleNameInvalid("角色名不能为空")
    if len(name) > ROLE_MAX_LEN:
        raise RoleNameInvalid(f"角色名最多 {ROLE_MAX_LEN} 个字")
    if any(ord(ch) < 32 for ch in name):
        raise RoleNameInvalid("角色名里有看不见的字符")
    if name in BLOCKED_ROLES:
        raise RoleNameInvalid(f"「{name}」不能在这里配：{BLOCKED_ROLES[name]}")
    return name


@dataclass
class RoleMap:
    """映射表读出来的样子：所有员工都给的角色，和每个分组给的角色。"""
    everyone: list[str]
    by_group: dict[str, list[str]]

    def all_roles(self) -> set[str]:
        out = set(self.everyone)
        for roles in self.by_group.values():
            out |= set(roles)
        return out


def load_role_map(db: Session) -> RoleMap:
    everyone: set[str] = set()
    by_group: dict[str, set[str]] = {}
    for group_id, role in db.query(FrappeRoleMap.group_id, FrappeRoleMap.role).all():
        (everyone if group_id is None else by_group.setdefault(group_id, set())).add(role)
    return RoleMap(everyone=sorted(everyone), by_group={k: sorted(v) for k, v in by_group.items()})


def roles_for(staff: Staff | None, members: Membership, role_map: RoleMap) -> set[str]:
    """按 ERP 分组这个员工该有的 Frappe 角色（不管 Frappe 里有没有这个角色）。不在职的一个都没有。"""
    if not is_active_human(staff):
        return set()
    out = set(role_map.everyone)
    for g in members.of(staff):
        out |= set(role_map.by_group.get(g.id, ()))
    return out


# ---------------------------------------------------------------- Frappe 那边的数据


@dataclass
class FrUser:
    name: str
    enabled: bool
    full_name: str
    owner: str
    roles: list[str]   # 照 Frappe 里的顺序，写回时不打乱

    @classmethod
    def from_api(cls, data: dict) -> FrUser:
        return cls(
            name=data.get("name") or "",
            enabled=bool(int(data.get("enabled") or 0)),
            full_name=data.get("full_name") or "",
            owner=data.get("owner") or "",
            roles=[r["role"] for r in (data.get("roles") or []) if isinstance(r, dict) and r.get("role")],
        )


def _messages(data: dict) -> list[str]:
    """Frappe 的提示（msgprint）：_server_messages 是个 JSON 串，里面每一条又是一个 JSON 串。"""
    raw = data.get("_server_messages")
    if not raw:
        return []
    try:
        items = json.loads(raw) if isinstance(raw, str) else list(raw)
    except (TypeError, ValueError):
        return []
    out = []
    for item in items:
        try:
            msg = (json.loads(item) if isinstance(item, str) else item).get("message")
        except (AttributeError, TypeError, ValueError):
            msg = item if isinstance(item, str) else None
        text = _TAG_RE.sub("", str(msg or "")).strip()
        if text:
            out.append(text)
    return out


def _error_text(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except ValueError:
        return resp.text[:300]
    if not isinstance(data, dict):
        return resp.text[:300]
    text = "；".join(_messages(data)) or str(data.get("exception") or "") or resp.text
    kind = data.get("exc_type")
    return (f"{kind}：{text}" if kind and kind not in text else text)[:300]


class FrappeApi:
    """只用到的那几个接口（/api/resource、/api/method，token key:secret）。transport 留给测试换成假的 Frappe。"""

    def __init__(self, base_url: str, api_key: str, api_secret: str, *, timeout: float = 20.0,
                 transport: httpx.BaseTransport | None = None):
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"token {api_key}:{api_secret}", "Accept": "application/json"},
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    def _call(self, method: str, path: str, **kwargs) -> dict:
        try:
            resp = self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise FrappeError(f"{method} {path} 连不上 Frappe：{exc}") from exc
        if resp.status_code >= 400:
            raise FrappeError(f"{method} {path} → HTTP {resp.status_code}：{_error_text(resp)}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise FrappeError(f"{method} {path} 回的不是 JSON") from exc
        if not isinstance(data, dict):
            raise FrappeError(f"{method} {path} 回的不是对象")
        return data

    def whoami(self) -> str:
        """这把 key 是哪个 Frappe 用户的。"""
        return str(self._call("GET", "/api/method/frappe.auth.get_logged_user").get("message") or "")

    def list_roles(self) -> dict[str, bool]:
        """Frappe 里所有角色 → 停用没有。limit_page_length=0 是不分页、全给（工作台读 Frappe 也是这么取的）。"""
        rows = self._call("GET", "/api/resource/Role", params={
            "fields": json.dumps(["name", "disabled"]), "limit_page_length": 0,
        }).get("data") or []
        return {r["name"]: bool(int(r.get("disabled") or 0)) for r in rows if r.get("name")}

    def list_departments(self) -> list[dict]:
        """部门（一棵树）。字段要 *：「停用」这一项各版本 ERPNext 不一定有，点名要没有的字段 Frappe 会报错；
        部门就几十个，全取回来在本地挑。"""
        return self._call("GET", "/api/resource/Department", params={
            "fields": json.dumps(["*"]), "limit_page_length": 0,
        }).get("data") or []

    def list_employees(self) -> list[dict]:
        """员工档案：档案号、姓名、部门、关联的号（User ID）、状态。只要这几项，档案里的生日、证件这些不取。"""
        return self._call("GET", "/api/resource/Employee", params={
            "fields": json.dumps(["name", "employee_name", "department", "user_id", "status"]),
            "limit_page_length": 0,
        }).get("data") or []

    def list_user_names(self) -> list[str]:
        """Frappe 里所有用户名（就是邮箱）。人就几十个，全取回来在本地挑，不依赖列表筛选。"""
        rows = self._call("GET", "/api/resource/User", params={
            "fields": json.dumps(["name"]), "limit_page_length": 0,
        }).get("data") or []
        return [r["name"] for r in rows if r.get("name")]

    def get_user(self, name: str) -> FrUser:
        return FrUser.from_api(self._call("GET", _user_path(name)).get("data") or {})

    def create_user(self, body: dict) -> tuple[FrUser, list[str]]:
        data = self._call("POST", "/api/resource/User", json=body)
        return FrUser.from_api(data.get("data") or {}), _messages(data)

    def update_user(self, name: str, body: dict) -> tuple[FrUser, list[str]]:
        data = self._call("PUT", _user_path(name), json=body)
        return FrUser.from_api(data.get("data") or {}), _messages(data)


def _user_path(name: str) -> str:
    return "/api/resource/User/" + quote(name, safe="")


def why_not(*, dry_run: bool) -> str | None:
    """这一轮跑不了的原因；None = 能跑。预演也要读 Frappe，所以也要 key。"""
    url = settings.frappe_sync_url.strip()
    if not url:
        return "没配 FRAPPE_SYNC_URL"
    parts = urlsplit(url)
    if not parts.netloc or parts.scheme not in ("https", "http") or (
        parts.scheme == "http" and parts.hostname not in _LOCAL_HOSTS
    ):
        return f"FRAPPE_SYNC_URL 要是 https 地址（key 跟着请求走）：{url}"
    if not settings.frappe_sync_api_key.strip() or not settings.frappe_sync_api_secret.strip():
        return "没配 FRAPPE_SYNC_API_KEY / FRAPPE_SYNC_API_SECRET"
    if not dry_run and not settings.frappe_sync_enabled:
        return "同步开关没开（FRAPPE_SYNC_ENABLED），只能预演"
    return None


def make_api(transport: httpx.BaseTransport | None = None) -> FrappeApi:
    return FrappeApi(settings.frappe_sync_url.strip(), settings.frappe_sync_api_key.strip(),
                     settings.frappe_sync_api_secret.strip(), timeout=settings.frappe_sync_timeout_seconds,
                     transport=transport)


def sync_lock(db: Session):
    """和统一登录同步同一套写法、另一把锁：Frappe 同步自己不会两轮同时跑，和统一登录同步互不等。"""
    return authentik_sync.sync_lock(db, LOCK_NAME)


# ---------------------------------------------------------------- 算差异


@dataclass
class Step:
    kind: str                 # create_user / update_user / disable_user
    text: str                 # 给人看的一行
    user: str                 # Frappe 用户名（邮箱）
    who: str                  # 给人看的「谁」
    staff_id: str | None = None
    body: dict = field(default_factory=dict)   # 角色以外要改的字段；建号时是整个请求体
    add: set[str] = field(default_factory=set)
    remove: set[str] = field(default_factory=set)
    ok: bool | None = None
    error: str | None = None
    after: FrUser | None = None                # 写完 Frappe 返回的样子
    messages: list[str] = field(default_factory=list)


@dataclass
class Plan:
    steps: list[Step] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    # 写回 ERP 的：员工 → (Frappe 用户名, 同步给他、维护着的角色, 启用没有)
    accounts: dict[str, tuple[str, list[str], bool]] = field(default_factory=dict)

    def add(self, kind: str, text: str, **kwargs) -> Step:
        step = Step(kind, text, **kwargs)
        self.steps.append(step)
        return step


def _label(staff: Staff) -> str:
    return f"{staff.username}（{staff.name or staff.username}）"


def _why_off(staff: Staff | None) -> str:
    if staff is None:
        return "ERP 里找不到这个员工"
    if staff.deleted_at:
        return "ERP 里删了"
    if staff.role not in HUMAN_ROLES:
        return "改成了设备账号"
    if staff.status != StaffStatus.ACTIVE:
        return "ERP 里停用了"
    return "不再属于给 Frappe 角色的分组"


def _join(roles) -> str:
    return "、".join(sorted(roles))


def build_plan(
    staff_rows: list[Staff],
    ready: set[str],
    members: Membership,
    role_map: RoleMap,
    granted: dict[str, list[str]],
    me: str,
    fr_roles: dict[str, bool],
    fr_users: list[FrUser],
) -> Plan:
    """ERP 现状 + Frappe 现状 → 要做的事。纯计算，不读不写任何外部东西。

    ready：统一登录的号开好了的员工 ID；members：谁进哪个组（platform_groups.membership）；
    granted：同步加上去、归它撤的角色（frappe_account.roles）；me：同步用的 API 用户；
    fr_roles：Frappe 的角色 → 停用没有；fr_users：Frappe 里占位邮箱域名下的号。
    """
    plan = Plan()

    # ---- 映射里的角色，Frappe 里得有、没停用、不归 Frappe 自己管 ----
    usable: set[str] = set()
    for role in sorted(role_map.all_roles()):
        if role in BLOCKED_ROLES:
            plan.conflicts.append(f"映射里的「{role}」同步不管（{BLOCKED_ROLES[role]}），没给")
        elif role not in fr_roles:
            plan.conflicts.append(f"映射里的「{role}」Frappe 里没有这个角色，先没给（看看是不是写错了）")
        elif fr_roles[role]:
            plan.conflicts.append(f"映射里的「{role}」在 Frappe 里停用了，先没给")
        else:
            usable.add(role)

    staff_by_key = {s.id.lower(): s for s in staff_rows}
    handled: set[str] = set()

    # ---- Frappe 里已有的占位邮箱号 ----
    for u in sorted(fr_users, key=lambda x: x.name):
        staff = staff_by_key.get(u.name[: -len(_EMAIL_SUFFIX)])
        if staff is not None:
            handled.add(staff.id)
        if u.owner != me:
            if staff is not None:
                plan.conflicts.append(f"{_label(staff)}：Frappe 里已经有 {u.name}，不是同步建的，没碰")
            else:
                plan.notes.append(f"Frappe 里的 {u.name} 不是同步建的，也对不上 ERP 员工，没碰")
            continue
        wanted = roles_for(staff, members, role_map)
        want_enabled = bool(wanted)
        mine = set(granted.get(staff.id, ())) if staff else set()
        current = set(u.roles)
        if want_enabled:
            target = wanted & usable
            add = target - current
            # 只撤同步自己加的；只补不撤的、Frappe 自己管的不撤
            remove = (current & mine) - target - ADD_ONLY_ROLES - set(BLOCKED_ROLES)
            mine = ((mine | add) & target) - ADD_ONLY_ROLES
        else:
            add, remove = set(), set()   # 停号不动角色，恢复了再对
        who = _label(staff) if staff else u.name
        body: dict = {}
        words: list[str] = []
        if u.enabled != want_enabled:
            body["enabled"] = 1 if want_enabled else 0
            if want_enabled:
                words.append("启用")
        if staff is not None:
            want_name = staff.name or staff.username
            if u.full_name != want_name:
                body.update(first_name=want_name, middle_name=None, last_name=None)
                words.append(f"姓名 {u.full_name or '（空）'}→{want_name}")
        if add:
            words.append(f"加 {_join(add)}")
        if remove:
            words.append(f"去 {_join(remove)}")
        if staff is not None:
            plan.accounts[staff.id] = (u.name, sorted(mine), want_enabled)
        if not words and "enabled" not in body:
            continue
        if body.get("enabled") == 0:
            kind, text = "disable_user", f"停号 {who}：{_why_off(staff)}" + "".join(f"；{w}" for w in words)
        else:
            kind, text = "update_user", f"改号 {who}：{'；'.join(words)}"
        plan.add(kind, text, user=u.name, who=who, staff_id=staff.id if staff else None,
                 body=body, add=add, remove=remove)

    # ---- 还没有号的：统一登录的号开好了才建 ----
    pending: list[str] = []
    for staff in staff_rows:
        if staff.id in handled:
            continue
        target = roles_for(staff, members, role_map) & usable
        if not target:
            continue
        if staff.id not in ready:
            pending.append(staff.username)
            continue
        email = staff_email(staff.id)
        plan.add("create_user", f"建号 {_label(staff)}：{_join(target)}", user=email, who=_label(staff),
                 staff_id=staff.id, add=set(target), body={
                     "email": email,
                     "first_name": staff.name or staff.username,
                     # 只在建号时给一次，好认；撞了别人的 Frappe 会自己另起一个，不算错
                     "username": staff.username,
                     "enabled": 1,
                     # Frappe 会按角色自己改：有一个能进后台的角色就是 System User，只有 LMS Student 就是 Website User
                     "user_type": "System User",
                     "send_welcome_email": 0,
                     "roles": [{"role": r} for r in sorted(target)],
                 })
        plan.accounts[staff.id] = (email, sorted(target - ADD_ONLY_ROLES), True)
    if pending:
        plan.notes.append(f"统一登录的号还没开好，Frappe 先不建号：{'、'.join(pending)}")
    return plan


# ---------------------------------------------------------------- 执行


_ORDER = ["disable_user", "update_user", "create_user"]


def _check(step: Step, user: FrUser) -> list[str]:
    """写完对一遍：Frappe 自己的规则（各 app 挂在 User 上的钩子）可能把我们要的改回去。"""
    problems = []
    if "enabled" in step.body and user.enabled != bool(step.body["enabled"]):
        problems.append("还是启用的" if user.enabled else "还是停用的")
    have = set(user.roles)
    if missing := step.add - have:
        problems.append(f"没有 {_join(missing)}")
    if back := step.remove & have:
        problems.append(f"{_join(back)} 还在")
    if "first_name" in step.body and user.full_name != step.body["first_name"]:
        problems.append(f"姓名成了 {user.full_name or '（空）'}")
    return problems


def apply_plan(api: FrappeApi, plan: Plan) -> None:
    """按 停号 → 改号 → 建号 的顺序执行（先撤后给）。一步失败记在这一步上，别的照做。"""
    for kind in _ORDER:
        for step in (s for s in plan.steps if s.kind == kind):
            try:
                if kind == "create_user":
                    user, step.messages = api.create_user(step.body)
                else:
                    # 现读现改：在 Frappe 现在的角色上增删，人工刚加的角色不会被冲掉
                    fresh = api.get_user(step.user)
                    roles = [r for r in fresh.roles if r not in step.remove]
                    roles += sorted(step.add - set(roles))
                    body = dict(step.body)
                    if roles != fresh.roles:
                        body["roles"] = [{"role": r} for r in roles]
                    if not body:
                        step.ok, step.after = True, fresh
                        continue
                    user, step.messages = api.update_user(step.user, body)
                step.after = user
                problems = _check(step, user)
                if problems:
                    step.ok = False
                    step.error = f"Frappe 保存后{'，'.join(problems)}（多半是 Frappe 自己的规则在管它，把它从映射里拿掉）"
                else:
                    step.ok = True
            except FrappeError as exc:
                step.ok, step.error = False, str(exc)
            if step.ok is False:
                log.warning("Frappe 同步：%s 没成：%s", step.text, step.error)


def _record(db: Session, plan: Plan) -> None:
    """把这一轮的结果写回 ERP：每个员工在 Frappe 的号、同步给他维护着的角色（后台员工列表和撤角色都看它）。"""
    now = datetime.utcnow()
    by_staff = {s.staff_id: s for s in plan.steps if s.staff_id}
    for staff_id, (user, roles, enabled) in plan.accounts.items():
        step = by_staff.get(staff_id)
        account = db.get(FrappeAccount, staff_id)
        if step is not None and step.ok is False:
            if step.after is None:
                continue   # 没写进去：上一轮的记录原样留着（建号没成就还没有记录）
            # 写进去了、但 Frappe 改回去一部分：按实际有的记
            roles, enabled = sorted(set(roles) & set(step.after.roles)), step.after.enabled
        if account is None:
            account = FrappeAccount(staff_id=staff_id)
            db.add(account)
        account.frappe_user, account.roles, account.enabled, account.synced_at = user, roles, enabled, now
    db.query(FrappeAccount).filter(FrappeAccount.staff_id.notin_(list(plan.accounts) or [""])).delete(
        synchronize_session=False
    )
    db.commit()


# ---------------------------------------------------------------- 入口


_COUNT_NAMES = {"create_user": "建号", "update_user": "改号", "disable_user": "停号"}


@dataclass
class Round:
    """一轮的结果：报告，和这一轮按什么算的分组（部门是这一轮读到的；没读到就是上一轮存下的）。"""
    report: SyncReport
    members: Membership


def run_sync(db: Session, api: FrappeApi, *, dry_run: bool) -> SyncReport:
    """跑一轮。调用方负责 why_not() 和 sync_lock()。读 Frappe 失败直接抛 FrappeError（配置不对抛 FrappeRefused）。

    员工档案、部门读不到不抛：报告里「部门 → 分组」那一段报失败，部门照上一轮存下的算，别的照做。
    """
    return run_round(db, api, dry_run=dry_run).report


def run_round(db: Session, api: FrappeApi, *, dry_run: bool) -> Round:
    """同 run_sync，另外交出这一轮的分组：后台「部门 → 分组」卡片接着跑统一登录同步时，预演也按这一轮读到的部门算。"""
    me = api.whoami()
    if not me or me == "Guest":
        raise FrappeRefused("Frappe 不认这把 key（登录成了访客），检查 FRAPPE_SYNC_API_KEY / FRAPPE_SYNC_API_SECRET")
    if me == "Administrator":
        raise FrappeRefused("FRAPPE_SYNC_API_KEY 是 Administrator 的：同步靠「号是谁建的」认自己建的号，"
                            "要给同步单独建一个 API 用户（见接入说明）")
    fr_roles = api.list_roles()
    if not fr_roles:
        raise FrappeError("读到的 Frappe 角色是空的（API 用户没有读 Role 的权限？）")
    names = sorted({n for n in api.list_user_names() if n.lower().endswith(_EMAIL_SUFFIX)})
    fr_users = [api.get_user(n) for n in names]

    staff_rows = db.query(Staff).order_by(Staff.staff_no).all()
    db.query(AuthentikAccount).all()   # 先整表读进会话，下面 refusal 里的 db.get 就不再一个个查
    ready = {s.id for s in staff_rows if oidc_provider.refusal(db, s) is None}

    # 部门：读到了就按这一轮的算（给角色也按它），读不到照上一轮存下的
    before = platform_groups.membership(db)
    try:
        got = frappe_departments.read(api, staff_rows)
    except FrappeError as exc:
        log.warning("Frappe 同步：读员工档案、部门失败，部门照上一轮的算：%s", exc)
        got, members = None, before
        departments = frappe_departments.failed_section(str(exc), dry_run=dry_run)
    else:
        members = platform_groups.membership(db, employees=got.links)
        departments = frappe_departments.section(staff_rows, before, members, got, dry_run=dry_run)

    granted = {a.staff_id: list(a.roles or []) for a in db.query(FrappeAccount).all()}
    plan = build_plan(staff_rows, ready, members, load_role_map(db), granted, me, fr_roles, fr_users)
    errors: list[str] = []
    if not dry_run:
        if got is not None:
            frappe_departments.record(db, got.links)
        apply_plan(api, plan)
        errors = [f"{s.text}：{s.error}" for s in plan.steps if s.ok is False]
        _record(db, plan)
    done = [s for s in plan.steps if dry_run or s.ok]
    counts = {name: sum(1 for s in done if s.kind == kind) for kind, name in _COUNT_NAMES.items()}
    notes = plan.notes + [f"Frappe 对 {s.who} 的提示：{m}" for s in plan.steps for m in s.messages]
    report = SyncReport(
        dry_run=dry_run,
        actions=[s.text for s in done],
        conflicts=plan.conflicts,
        notes=notes,
        errors=errors,
        counts=counts,
        title="Frappe 同步",
        sections=[departments],
    )
    return Round(report=report, members=members)
