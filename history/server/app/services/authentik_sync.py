"""ERP 员工 → Authentik（统一登录）的同步：建号、改名、停用、组成员，都从 ERP 推过去。

由 scripts/run_authentik_sync.py（systemd timer）定时跑，后台「统一登录」页也能手动点；开关
AUTHENTIK_SYNC_ENABLED 关着时只能预演。

# 账号怎么对上

主键是 ERP 员工 ID（Staff.id，也就是 OIDC 的 sub），存在 Authentik 用户的 attributes.erp_sub；同步建的号
都放在 path=erp（AUTHENTIK_USER_PATH）下。同步只认「path 是 erp、而且带 erp_sub」的号，别的号（现有的
两个真人、服务账号、outpost）一律只读不改。用户名 = ERP 登录账号，但它不当主键：员工删除时 ERP 会把用户名
改写成 xxx__del_xxxxxxxx 腾给新人用，同步跟着改名。

为什么同步要先建号，而不是等员工第一次登录时让 Authentik 自己建：那样还没登录过的人停不了、组也要等人登录
了才有。可 Authentik 的 API 不让外部替用户建「源连接」（那个 user 字段只读），没法事先告诉它「这个号是 ERP
的谁」。所以同步先建好号，员工第一次从 ERP 登录时，Authentik 按用户名认领这个号（登录源的「用户匹配方式」
选按用户名关联）；认领后 Authentik 自己记下 sub，以后就按 sub 认，跟用户名无关了。

按用户名认领怕的是认到统一登录里别人的同名号上（比如 ERP 里有人建了个 akadmin）。三道挡住：
  1. 用户名已经被别的号占着（不是 ERP 同步建的），同步不建、不碰，报「冲突」；
  2. ERP 登录页只给同步开好号的员工签发身份（authentik_account 有这一行、用户名对得上，见
     services/oidc_provider.py 的 refusal），Authentik 能认领到的只可能是 ERP 建的那个号；
  3. 登录源不配注册流程：万一对不上，Authentik 直接报错，不会自己另建一个号。

# 组

ERP 的平台分组（services/platform_groups.py）在 Authentik 里建同名组，打 attributes.erp_managed=true。
同步只在这些组里加减 ERP 同步来的号，组里别的成员、别的组都不碰。统一登录里已经有同名组但不是 ERP 建的：
报冲突、不碰，ERP 登录时也不发这个组名。ERP 里删掉的分组，Authentik 里那个组留着，只把 ERP 的号移出去。
谁进哪个组按 platform_groups.membership 算：按角色进的、手工挂的、按 Frappe 部门进的三种都算（部门用的是
Frappe 同步上一轮存下的，这里不读 Frappe）。

# 邮箱

ERP 员工表没有邮箱，可 Frappe 从统一登录登录时只按邮箱认人（邮箱就是 Frappe 用户的主键）。所以同步给
ERP 的号写一个占位邮箱 <员工ID>@staff.panasia.fun（staff_email），Frappe 那边的号也由同步按它建
（services/frappe_sync.py）。

用员工 ID 不用登录账号：ERP 删员工时会把登录账号改写成 xxx__del_xxxxxxxx 腾给新人。邮箱要是跟着账号走，
新人就会拿到老员工的邮箱、从统一登录直接进了老员工的 Frappe 号（工资条、请假都在里面）；要避开就得先在
Frappe 里给老号改主键，还得保证改完之前新人登不进去。员工 ID 不变也不回收，这些事就都不存在。登录账号里
还可能有中文、空格，当不了邮箱。代价是邮箱不好认，Frappe 里认人看姓名。

ERP 的号邮箱以 ERP 为准：被手工改了，下一轮改回来（Frappe 按邮箱认人，邮箱被改成别人的就能进别人的 Frappe）。
别人的号照旧不碰。

# 停用

ERP 停用、删除了的员工，或者角色改成了设备账号：Authentik 的号 is_active=false（Authentik 会顺手清掉他的
登录会话），移出所有 ERP 管的组。员工恢复了就再启用、再进组。号不删：各系统里可能还挂着他的历史。

# 幂等

每一轮都是「读 ERP 全量 + 读 Authentik 全量 → 算差异 → 只改有差异的」：跑两遍，第二遍什么都不做；上一轮
中途失败了，下一轮接着补。预演只算差异、打印要改什么，Authentik 和 ERP 都不写。

# 能进哪些系统

号和组都同步完，同一轮接着按「分组 → 系统」在 Authentik 的应用上加减绑定（services/authentik_access.py），
报告里单独一段。它有自己的开关 AUTHENTIK_ACCESS_SYNC_ENABLED，关着时真跑跳过、预演照样算。
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import quote

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.models import AuthentikAccount, PlatformGroup, Staff
from app.services import platform_groups
from app.services.platform_groups import GroupNameInvalid, is_active_human

log = logging.getLogger(__name__)

GROUP_MARK = "erp_managed"
_LOCK_NAME = "authentik_sync"
_MAX_PAGES = 200
# 占位邮箱的域名。Frappe 的号以邮箱为主键，上线后改它等于给所有人换一个 Frappe 号，别改
STAFF_EMAIL_DOMAIN = "staff.panasia.fun"


def staff_email(staff_id: str) -> str:
    """员工在统一登录里的邮箱（Frappe 按它认人），为什么用员工 ID 见开头。"""
    return f"{staff_id}@{STAFF_EMAIL_DOMAIN}".lower()


class AuthentikError(Exception):
    """调 Authentik 的 API 失败（连不上、没权限、参数不对）。"""


class AuthentikNotFound(AuthentikError):
    """404：要找的东西 Authentik 里没有。"""


# ---------------------------------------------------------------- Authentik 那边的数据


@dataclass
class AkUser:
    pk: int
    username: str
    name: str
    email: str
    is_active: bool
    path: str
    type: str
    attributes: dict
    groups: set[str]

    @classmethod
    def from_api(cls, data: dict) -> AkUser:
        return cls(
            pk=int(data["pk"]),
            username=data.get("username") or "",
            name=data.get("name") or "",
            email=data.get("email") or "",
            is_active=bool(data.get("is_active")),
            path=data.get("path") or "",
            type=data.get("type") or "",
            attributes=dict(data.get("attributes") or {}),
            groups={str(g) for g in (data.get("groups") or [])},
        )


@dataclass
class AkGroup:
    pk: str
    name: str
    attributes: dict

    @classmethod
    def from_api(cls, data: dict) -> AkGroup:
        return cls(pk=str(data["pk"]), name=data.get("name") or "", attributes=dict(data.get("attributes") or {}))

    @property
    def erp_managed(self) -> bool:
        return self.attributes.get(GROUP_MARK) is True


@dataclass
class AkApplication:
    pk: str                   # pbm_uuid，绑定的 target 就是它
    slug: str
    name: str
    policy_engine_mode: str   # any / all

    @classmethod
    def from_api(cls, data: dict) -> AkApplication:
        return cls(pk=str(data.get("pbm_uuid") or data["pk"]), slug=data.get("slug") or "",
                   name=data.get("name") or "", policy_engine_mode=data.get("policy_engine_mode") or "")


@dataclass
class AkPolicy:
    pk: str
    name: str
    expression: str

    @classmethod
    def from_api(cls, data: dict) -> AkPolicy:
        return cls(pk=str(data["pk"]), name=data.get("name") or "", expression=data.get("expression") or "")


@dataclass
class AkBinding:
    """应用上的一条绑定：绑的是策略、组、用户三样之一。"""
    pk: str
    target: str
    order: int
    enabled: bool
    negate: bool
    failure_result: bool   # 策略出错时算过还是不过
    expiring: bool         # 会到期（Authentik 的「申请访问」批下来的那种）
    policy: str | None
    group: str | None
    user: int | None
    label: str             # 给人看：策略名 / 组名 / 用户名

    @classmethod
    def from_api(cls, data: dict) -> AkBinding:
        policy, group, user = data.get("policy"), data.get("group"), data.get("user")
        obj = data.get("policy_obj") or data.get("group_obj") or data.get("user_obj") or {}
        return cls(
            pk=str(data["pk"]),
            target=str(data.get("target") or ""),
            order=int(data.get("order") or 0),
            enabled=bool(data.get("enabled")),
            negate=bool(data.get("negate")),
            failure_result=bool(data.get("failure_result")),
            expiring=bool(data.get("expiring")),
            policy=str(policy) if policy else None,
            group=str(group) if group else None,
            user=int(user) if user is not None else None,
            label=str(obj.get("name") or obj.get("username") or policy or group or user or ""),
        )


class AuthentikApi:
    """只用到的那几个接口（/api/v3，Bearer token）。transport 留给测试换成假的 Authentik。"""

    def __init__(self, base_url: str, token: str, *, timeout: float = 15.0, transport: httpx.BaseTransport | None = None):
        self._http = httpx.Client(
            base_url=base_url.rstrip("/") + "/api/v3",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    def _call(self, method: str, path: str, *, need: str | None = None, **kwargs):
        """need：这个接口要服务账号有的权限，403 时写进报错，一眼看出该补哪条。"""
        try:
            resp = self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise AuthentikError(f"{method} {path} 连不上 Authentik：{exc}") from exc
        if resp.status_code == 403 and need:
            raise AuthentikError(f"{method} {path} → HTTP 403：同步用的服务账号缺权限 {need}"
                                 f"（见接入说明第七节第 4 条）：{resp.text[:200]}")
        if resp.status_code == 404:
            raise AuthentikNotFound(f"{method} {path} → HTTP 404：{resp.text[:300]}")
        if resp.status_code >= 400:
            raise AuthentikError(f"{method} {path} → HTTP {resp.status_code}：{resp.text[:300]}")
        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError as exc:
            raise AuthentikError(f"{method} {path} 回的不是 JSON") from exc

    def _list(self, path: str, params: dict, *, need: str | None = None) -> list[dict]:
        out: list[dict] = []
        page = 1
        for _ in range(_MAX_PAGES):
            data = self._call("GET", path, params={**params, "page": page, "page_size": 100}, need=need) or {}
            out += data.get("results") or []
            nxt = int((data.get("pagination") or {}).get("next") or 0)
            if nxt <= page:
                return out
            page = nxt
        raise AuthentikError(f"GET {path} 翻了 {_MAX_PAGES} 页还没完")

    def list_users(self) -> list[AkUser]:
        rows = self._list("/core/users/", {"include_groups": "false", "include_roles": "false"})
        return [AkUser.from_api(u) for u in rows]

    def list_groups(self) -> list[AkGroup]:
        return [AkGroup.from_api(g) for g in self._list("/core/groups/", {"include_users": "false"})]

    def create_user(self, body: dict) -> AkUser:
        return AkUser.from_api(self._call("POST", "/core/users/", json=body))

    def update_user(self, pk: int, body: dict) -> None:
        self._call("PATCH", f"/core/users/{pk}/", json=body)

    def create_group(self, body: dict) -> AkGroup:
        return AkGroup.from_api(self._call("POST", "/core/groups/", json=body))

    def update_group(self, pk: str, body: dict) -> None:
        self._call("PATCH", f"/core/groups/{pk}/", json=body)

    def add_member(self, group_pk: str, user_pk: int) -> None:
        self._call("POST", f"/core/groups/{group_pk}/add_user/", json={"pk": user_pk})

    def remove_member(self, group_pk: str, user_pk: int) -> None:
        self._call("POST", f"/core/groups/{group_pk}/remove_user/", json={"pk": user_pk})

    # ---- 能进哪些系统（services/authentik_access.py）用的 ----

    def get_application(self, slug: str) -> AkApplication | None:
        """按 slug 取应用，没有回 None。不用列表接口：它只列出调用的人自己能进的应用（照策略算），不是全部。"""
        try:
            data = self._call("GET", f"/core/applications/{quote(slug, safe='')}/",
                              need="authentik_core.view_application")
        except AuthentikNotFound:
            return None
        return AkApplication.from_api(data)

    def find_expression_policy(self, name: str) -> AkPolicy | None:
        """按名字（全名、一字不差）找表达式策略，没有回 None。"""
        rows = self._list("/policies/expression/", {"name": name},
                          need="authentik_policies_expression.view_expressionpolicy")
        hits = [r for r in rows if r.get("name") == name]
        return AkPolicy.from_api(hits[0]) if hits else None

    def list_bindings(self, targets: list[str]) -> list[AkBinding]:
        """这些应用（pbm_uuid）上的全部绑定，含停用的。一次最多查 20 个，免得地址太长。"""
        out: list[AkBinding] = []
        for i in range(0, len(targets), 20):
            rows = self._list("/policies/bindings/", {"target_in": targets[i:i + 20]},
                              need="authentik_policies.view_policybinding")
            out += [AkBinding.from_api(b) for b in rows]
        return out

    def create_binding(self, body: dict) -> AkBinding:
        return AkBinding.from_api(self._call("POST", "/policies/bindings/", json=body,
                                             need="authentik_policies.add_policybinding"))

    def delete_binding(self, pk: str) -> None:
        try:
            self._call("DELETE", f"/policies/bindings/{pk}/", need="authentik_policies.delete_policybinding")
        except AuthentikNotFound:
            pass   # 读完到删之间被人删了，结果一样


def why_not(*, dry_run: bool) -> str | None:
    """这一轮跑不了的原因；None = 能跑。预演也要读 Authentik，所以也要 token。"""
    if not settings.authentik_url.strip():
        return "没配 AUTHENTIK_URL"
    if not settings.authentik_api_token.strip():
        return "没配 AUTHENTIK_API_TOKEN"
    path = settings.authentik_user_path.strip()
    if not path or path.startswith("/") or path.endswith("/") or "//" in path:
        return f"AUTHENTIK_USER_PATH 不对（不能空、首尾不带 /）：{path!r}"
    if not dry_run and not settings.authentik_sync_enabled:
        return "同步开关没开（AUTHENTIK_SYNC_ENABLED），只能预演"
    return None


def make_api(transport: httpx.BaseTransport | None = None) -> AuthentikApi:
    return AuthentikApi(settings.authentik_url, settings.authentik_api_token,
                        timeout=settings.authentik_timeout_seconds, transport=transport)


@contextmanager
def sync_lock(db: Session, name: str = _LOCK_NAME):
    """两个 worker + 定时器，同一时间只跑一轮。拿不到锁 yield False。测试用的 SQLite 没有 GET_LOCK，直接放行。

    锁挂在单独借出来的一条连接上，整轮都不还给连接池。不能用 db 自己的连接：同步中途 commit 会把连接
    还回池子，RELEASE_LOCK 就落到另一条连接上、放不掉——脚本跑完进程退出还好，接口所在的 worker 常驻，
    锁会一直挂在池子里那条连接上，之后每次点「立即同步」都是「上一轮还在跑」（本机实测踩到过）。
    Frappe 的同步用的是另一把（name 不同），两边互不等。
    """
    engine = db.get_bind()
    if engine.dialect.name != "mysql":
        yield True
        return
    with engine.connect() as conn:
        got = conn.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": name}).scalar() == 1
        try:
            yield got
        finally:
            if got:
                conn.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": name})


# ---------------------------------------------------------------- 算差异


@dataclass(frozen=True)
class _NewGroup:
    """这一轮要建的组（建完才有 pk），进组时按它找。"""
    erp_group_id: str
    name: str


@dataclass(frozen=True)
class _NewUser:
    staff_id: str
    username: str


@dataclass
class Step:
    kind: str           # create_group / rename_group / update_user / create_user / add_member / remove_member
    text: str           # 给人看的一行
    group: str | _NewGroup | None = None
    user: int | _NewUser | None = None
    body: dict = field(default_factory=dict)
    ok: bool | None = None
    error: str | None = None


@dataclass
class Plan:
    steps: list[Step] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    # ERP 侧要回写的：分组 → (Authentik 组, 当时的组名, 原因)；员工 → Authentik 的号（None = 关门）
    group_links: dict[str, tuple[str | _NewGroup | None, str | None, str | None]] = field(default_factory=dict)
    account_links: dict[str, tuple[int | _NewUser, str] | None] = field(default_factory=dict)

    def add(self, kind: str, text: str, **kwargs) -> Step:
        step = Step(kind, text, **kwargs)
        self.steps.append(step)
        return step


def _desc(staff: Staff) -> str:
    return f"{staff.name or staff.username}，{platform_groups.ROLE_LABELS.get(staff.role, staff.role)}"


def build_plan(
    staff_rows: list[Staff],
    members: platform_groups.Membership,
    ak_users: list[AkUser],
    ak_groups: list[AkGroup],
    *,
    user_path: str,
) -> Plan:
    """ERP 现状 + Authentik 现状 → 要做的事。纯计算，不读不写任何外部东西。

    members：谁进哪个组（platform_groups.membership，按角色、手工挂、按部门三种都在里面）。
    """
    plan = Plan()
    erp_groups = members.groups

    # ---- 组：ERP 的每个分组对上 Authentik 的一个 ERP 组（没有就建）----
    managed_groups = {g.pk: g for g in ak_groups if g.erp_managed}
    group_by_name = {g.name: g for g in ak_groups}
    names_taken = set(group_by_name)
    group_target: dict[str, str | _NewGroup] = {}   # ERP 分组 id → Authentik 组
    group_names = {pk: g.name for pk, g in managed_groups.items()}   # 打印用，改名的按新名字
    used_pks: set[str] = set()
    for eg in erp_groups:
        try:
            platform_groups.clean_group_name(eg.name)
        except GroupNameInvalid as exc:
            plan.conflicts.append(f"分组「{eg.name}」：{exc}，没同步")
            plan.group_links[eg.id] = (None, None, str(exc))
            continue
        linked = managed_groups.get(eg.authentik_pk or "")
        if linked is None or linked.pk in used_pks:
            same_name = group_by_name.get(eg.name)
            # 记的 pk 丢了，但同名组正是 ERP 建的：接着用
            linked = same_name if same_name is not None and same_name.erp_managed and same_name.pk not in used_pks else None
        if linked is not None:
            used_pks.add(linked.pk)
            group_target[eg.id] = linked.pk
            if linked.name == eg.name:
                plan.group_links[eg.id] = (linked.pk, eg.name, None)
            elif eg.name in names_taken:
                note = f"统一登录里已有叫「{eg.name}」的组，「{linked.name}」改不了名"
                plan.conflicts.append(f"分组「{eg.name}」：{note}")
                plan.group_links[eg.id] = (linked.pk, linked.name, note)
            else:
                plan.add("rename_group", f"组改名「{linked.name}」→「{eg.name}」", group=linked.pk, body={"name": eg.name})
                names_taken.discard(linked.name)
                names_taken.add(eg.name)
                group_names[linked.pk] = eg.name
                plan.group_links[eg.id] = (linked.pk, eg.name, None)
        elif eg.name in group_by_name:
            note = "统一登录里已有同名组（不是 ERP 建的），没碰；换个组名，或在统一登录里处理掉那个组"
            plan.conflicts.append(f"分组「{eg.name}」：{note}")
            plan.group_links[eg.id] = (None, None, note)
        else:
            new = _NewGroup(eg.id, eg.name)
            plan.add("create_group", f"建组「{eg.name}」", group=new,
                     body={"name": eg.name, "is_superuser": False, "attributes": {GROUP_MARK: True}})
            names_taken.add(eg.name)
            group_target[eg.id] = new
            plan.group_links[eg.id] = (new, eg.name, None)
    orphan_groups = {pk for pk in managed_groups if pk not in used_pks}

    def wanted_groups(staff: Staff | None) -> set:
        # 不在职的一个组都没有（members.of 里查）
        return {group_target[g.id] for g in members.of(staff) if g.id in group_target}

    def group_label(ref) -> str:
        return ref.name if isinstance(ref, _NewGroup) else group_names.get(ref, ref)

    def sync_members(user_ref, username: str, current: set[str], staff: Staff | None) -> None:
        want = wanted_groups(staff)
        have = current & set(managed_groups)
        for ref in sorted(want - have, key=group_label):
            plan.add("add_member", f"进组 {username} →「{group_label(ref)}」", group=ref, user=user_ref)
        for pk in sorted(have - want, key=group_label):
            plan.add("remove_member", f"出组 {username} ←「{group_label(pk)}」", group=pk, user=user_ref)

    # ---- 号 ----
    staff_by_id = {s.id: s for s in staff_rows}
    owner_by_username = {u.username: u for u in ak_users}
    taken = set(owner_by_username)
    managed = [u for u in ak_users if u.path == user_path and u.attributes.get("erp_sub")]
    by_sub: dict[str, list[AkUser]] = {}
    for u in managed:
        by_sub.setdefault(str(u.attributes["erp_sub"]), []).append(u)

    handled: set[str] = set()
    # 先处理不在职的（删除的人要先改名把用户名腾出来），再处理在职的
    for sub, users in sorted(by_sub.items(), key=lambda kv: is_active_human(staff_by_id.get(kv[0]))):
        staff = staff_by_id.get(sub)
        handled.add(sub)
        if len(users) > 1:
            names = "、".join(u.username for u in users)
            plan.conflicts.append(f"统一登录里 {names} 都标着同一个 ERP 员工（{sub}），都没碰；留一个、另一个去掉 erp_sub")
            plan.account_links[sub] = None
            continue
        u = users[0]
        if staff is None:
            changes = {"is_active": False} if u.is_active else {}
            if changes:
                plan.add("update_user", f"停用 {u.username}（ERP 里找不到这个员工）", user=u.pk, body=changes)
            sync_members(u.pk, u.username, u.groups, None)
            continue
        active = is_active_human(staff)
        changes: dict = {}
        words: list[str] = []
        final_username = u.username
        if u.username != staff.username:
            holder = owner_by_username.get(staff.username)
            if staff.username in taken and holder is not u:
                plan.conflicts.append(f"{u.username} 要改名成 {staff.username}，但统一登录里这个用户名已经有号了，没改")
            else:
                changes["username"] = staff.username
                words.append(f"用户名 {u.username}→{staff.username}")
                taken.discard(u.username)
                taken.add(staff.username)
                final_username = staff.username
        want_name = staff.name or staff.username
        if u.name != want_name:
            changes["name"] = want_name
            words.append(f"姓名 {u.name or '（空）'}→{want_name}")
        want_email = staff_email(staff.id)
        if u.email != want_email:
            changes["email"] = want_email
            words.append(f"邮箱 {u.email or '（空）'}→{want_email}")
        if u.is_active != active:
            changes["is_active"] = active
            words.append("启用" if active else "停用")
        attrs = {**u.attributes, "erp_sub": staff.id, "erp_staff_no": staff.staff_no, "erp_role": staff.role}
        if attrs != u.attributes:
            changes["attributes"] = attrs
            words.append("更新 ERP 标记")
        if changes:
            plan.add("update_user", f"改号 {u.username}：{'；'.join(words)}", user=u.pk, body=changes)
        if active:
            plan.account_links[staff.id] = (u.pk, final_username) if final_username == staff.username else None
        sync_members(u.pk, final_username, u.groups, staff)

    for staff in staff_rows:
        if staff.id in handled or not is_active_human(staff):
            continue
        if staff.username in taken:
            holder = owner_by_username.get(staff.username)
            whose = "是另一个 ERP 员工的" if holder is not None and holder in managed else "不是 ERP 同步来的"
            plan.conflicts.append(f"{staff.username}（{_desc(staff)}）：统一登录里已有同名账号（{whose}），没建也没碰")
            plan.account_links[staff.id] = None
            continue
        new = _NewUser(staff.id, staff.username)
        plan.add("create_user", f"建号 {staff.username}（{_desc(staff)}）", user=new, body={
            "username": staff.username,
            "name": staff.name or staff.username,
            "email": staff_email(staff.id),
            "is_active": True,
            "path": user_path,
            "type": "internal",
            "attributes": {"erp_sub": staff.id, "erp_staff_no": staff.staff_no, "erp_role": staff.role},
        })
        taken.add(staff.username)
        plan.account_links[staff.id] = (new, staff.username)
        sync_members(new, staff.username, set(), staff)

    leaving = {s.group for s in plan.steps if s.kind == "remove_member"} & orphan_groups
    for pk in sorted(leaving, key=group_label):
        plan.notes.append(f"统一登录里的组「{group_label(pk)}」是 ERP 建的，ERP 里已经没有这个分组了：ERP 的号移出去，"
                          f"组本身要删请在统一登录里删")
    return plan


# ---------------------------------------------------------------- 执行


_ORDER = ["create_group", "rename_group", "update_user", "create_user", "add_member", "remove_member"]


def apply_plan(api: AuthentikApi, plan: Plan) -> tuple[dict[str, str], dict[str, int]]:
    """按 建组 → 组改名 → 改号（先腾用户名）→ 建号 → 进组 → 出组 的顺序执行。

    一步失败记在这一步上，别的照做（建号失败的那个人，后面的进组也跳过）。
    返回这一轮新建出来的 组 pk、号 pk。
    """
    new_groups: dict[str, str] = {}
    new_users: dict[str, int] = {}

    def resolve_group(ref):
        return new_groups.get(ref.erp_group_id) if isinstance(ref, _NewGroup) else ref

    def resolve_user(ref):
        return new_users.get(ref.staff_id) if isinstance(ref, _NewUser) else ref

    for kind in _ORDER:
        for step in (s for s in plan.steps if s.kind == kind):
            try:
                if kind == "create_group":
                    new_groups[step.group.erp_group_id] = api.create_group(step.body).pk
                elif kind == "rename_group":
                    api.update_group(step.group, step.body)
                elif kind == "update_user":
                    api.update_user(step.user, step.body)
                elif kind == "create_user":
                    new_users[step.user.staff_id] = api.create_user(step.body).pk
                else:
                    group_pk, user_pk = resolve_group(step.group), resolve_user(step.user)
                    if group_pk is None or user_pk is None:
                        step.ok, step.error = False, "前面建组或建号没成，跳过"
                        continue
                    if kind == "add_member":
                        api.add_member(group_pk, user_pk)
                    else:
                        api.remove_member(group_pk, user_pk)
                step.ok = True
            except AuthentikError as exc:
                step.ok, step.error = False, str(exc)
                log.warning("统一登录同步：%s 没成：%s", step.text, exc)
    return new_groups, new_users


def _record(db: Session, plan: Plan, new_groups: dict[str, str], new_users: dict[str, int]) -> None:
    """把这一轮的结果写回 ERP：分组对上了哪个 Authentik 组，员工的号（ERP 登录页凭它放行）。"""
    now = datetime.utcnow()
    failed_renames = {s.group: s for s in plan.steps if s.kind == "rename_group" and not s.ok}
    failed_updates = {s.user: s for s in plan.steps if s.kind == "update_user" and not s.ok}
    for group in db.query(PlatformGroup).all():
        if group.id not in plan.group_links:
            continue
        ref, name, note = plan.group_links[group.id]
        if isinstance(ref, _NewGroup):
            ref = new_groups.get(group.id)
            if ref is None:
                name, note = None, "建组没成，下一轮再试"
        elif ref in failed_renames:
            # 改名没成：组还叫原来的名字，ERP 登录时先不发它
            name, note = None, "组改名没成，下一轮再试"
        group.authentik_pk, group.authentik_name, group.authentik_note = ref, name, note
        group.authentik_synced_at = now
    for staff_id, link in plan.account_links.items():
        account = db.get(AuthentikAccount, staff_id)
        if link is not None:
            ref, username = link
            if isinstance(ref, _NewUser):
                ref = new_users.get(staff_id)
            elif ref in failed_updates and "username" in failed_updates[ref].body:
                ref = None   # 改名没成，用户名还没对上：先关门
            if ref is None:
                link = None
        if link is None:
            if account is not None:
                db.delete(account)
            continue
        if account is None:
            account = AuthentikAccount(staff_id=staff_id, authentik_pk=ref, authentik_username=username, synced_at=now)
            db.add(account)
        account.authentik_pk, account.authentik_username, account.synced_at = ref, username, now
    db.commit()


# ---------------------------------------------------------------- 入口


@dataclass
class SyncReport:
    dry_run: bool
    actions: list[str]
    conflicts: list[str]
    notes: list[str]
    errors: list[str]
    counts: dict[str, int]
    title: str = "统一登录同步"   # Frappe 同步（services/frappe_sync.py）也用这份报告
    headline: str | None = None   # 顶替「建号 3，进组 2」那一截，比如这一段没跑时写「没同步」
    # 同一轮里接着跑的其他段（能进哪些系统，services/authentik_access.py），各自一段打印
    sections: list[SyncReport] = field(default_factory=list)

    def lines(self) -> list[str]:
        head = f"{self.title}预演（只看不改）" if self.dry_run else self.title
        summary = self.headline or "，".join(f"{k} {v}" for k, v in self.counts.items() if v) or "没有要改的"
        out = [f"{head}：{summary}"]
        out += [f"  {a}" for a in self.actions]
        out += [f"  冲突：{c}" for c in self.conflicts]
        out += [f"  注意：{n}" for n in self.notes]
        out += [f"  失败：{e}" for e in self.errors]
        for section in self.sections:
            out += section.lines()
        return out

    def has_errors(self) -> bool:
        """这一轮（连同后面几段）有没有失败的，定时器据此给退出码。"""
        return bool(self.errors) or any(s.has_errors() for s in self.sections)

    def to_dict(self) -> dict:
        return {
            "dry_run": self.dry_run, "actions": self.actions, "conflicts": self.conflicts,
            "notes": self.notes, "errors": self.errors, "counts": self.counts,
            "sections": [s.to_dict() for s in self.sections], "lines": self.lines(),
        }


_COUNT_NAMES = {
    "create_group": "建组", "rename_group": "组改名", "create_user": "建号", "update_user": "改号",
    "add_member": "进组", "remove_member": "出组",
}


def run_sync(db: Session, api: AuthentikApi, *, dry_run: bool,
             members: platform_groups.Membership | None = None) -> SyncReport:
    """跑一轮。调用方负责 why_not() 和 sync_lock()。读 Authentik 失败直接抛 AuthentikError。

    号和组同步完，接着跑「能进哪些系统」（组建好了才能往应用上绑），结果作为报告里单独的一段。那一段读写
    Authentik 出错只记在它自己那段里，不抛：前面号和组已经改了，报告不能丢。

    members：谁进哪个组，不给就现算（部门用上一轮存下的）。后台「部门 → 分组」卡片先跑 Frappe 同步再跑这里，
    传的是 Frappe 同步这一轮刚读到部门算的，预演时两边对得上。
    """
    from app.services import authentik_access   # 它要用这里的 AuthentikApi、SyncReport，放这儿免得循环导入

    staff_rows = db.query(Staff).order_by(Staff.staff_no).all()
    if members is None:
        members = platform_groups.membership(db)
    ak_users = api.list_users()
    ak_groups = api.list_groups()
    plan = build_plan(staff_rows, members, ak_users, ak_groups, user_path=settings.authentik_user_path.strip())
    errors: list[str] = []
    new_groups: dict[str, str] = {}
    if not dry_run:
        new_groups, new_users = apply_plan(api, plan)
        errors = [f"{s.text}：{s.error}" for s in plan.steps if s.ok is False]
        _record(db, plan, new_groups, new_users)
    done = [s for s in plan.steps if dry_run or s.ok]
    counts = {name: sum(1 for s in done if s.kind == kind) for kind, name in _COUNT_NAMES.items()}
    report = SyncReport(
        dry_run=dry_run,
        actions=[s.text for s in done],
        conflicts=plan.conflicts,
        notes=plan.notes,
        errors=errors,
        counts=counts,
    )
    access = authentik_access.run(db, api, erp_groups=members.groups, group_links=plan.group_links,
                                  ak_users=ak_users, ak_groups=ak_groups, new_groups=new_groups, dry_run=dry_run)
    if access is not None:
        report.sections.append(access)
    return report
