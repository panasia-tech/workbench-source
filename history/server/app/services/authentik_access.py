"""能进哪些系统：谁能从统一登录（Authentik）进哪个系统，以 ERP 的平台分组为准，推到 Authentik 应用的绑定上。

10-19 老板定的：统一登录的权限也从 ERP 管。后台「统一登录」页的「能进哪些系统」卡片配「分组 → 系统」（所有员工一行、
每个平台分组一行，表 platform_access_map，默认值在迁移 081）。统一登录同步（services/authentik_sync.py）每一轮
建完号、组之后接着跑这一段，在各系统的 Authentik 应用上加减绑定，报告里单独一段。开关 AUTHENTIK_ACCESS_SYNC_ENABLED
关着时真跑跳过这一段，预演照样算。接入步骤见 docs/统一登录接入说明.md 第七节。

# Authentik 怎么判能不能进（照 2026.8.3 的源码核对过：policies/engine.py、policies/views.py）

先要登录，再看应用上的绑定：只算启用的；一条都没有 = 谁都能进（租户标志 core_default_app_access，默认开）；
有了就按策略引擎模式算，any = 过一条就能进。组绑定看在不在组里（含子组），策略绑定跑策略，取反的反过来算。

# 同步只碰两种绑定

  1. 绑的是 ERP 建的组（attributes.erp_managed，统一登录同步建的）；
  2. 绑的是两条专用的表达式策略（按名字认，一字不差）：
       「ERP 同步：所有员工」       ERP 同步来的号（路径 erp、带 erp_sub，和工作台那条策略一个口径）；
       「ERP 同步：非 ERP 账号照旧」 不是 ERP 同步来的号（akadmin、服务账号这些）。
别的绑定（别人绑的组、用户、策略）一律不建、不改、不删。

每个管着的应用，同步要的绑定 =
    映射到这个系统的每个分组的组绑定
  ∪ 「所有员工」有这个系统时，「ERP 同步：所有员工」
  ∪ 应用上没有别人的启用绑定时，「ERP 同步：非 ERP 账号照旧」
差多少加多少，多出来的（只在上面两种里找）删掉。跑两遍第二遍什么都不做；预演只算不写。

为什么要「非 ERP 账号照旧」：原来一条绑定都没有的应用谁都能进，ERP 一加绑定，非 ERP 的号就被挡在外面了。这种应用
同步顺手加这一条，非 ERP 的号照旧能进，ERP 的号过不了它，只能按映射进——映射里没有的系统，ERP 的号就回到 10-18
之前（那时统一登录里还没有 ERP 的号）。应用上本来就有别人的绑定（比如只放 PanAsia Administrators），非 ERP 的号
能不能进由那些绑定说了算，同步只添放 ERP 的号的绑定，不加这条；以后那些绑定被删光了，下一轮再加上。

# 两条策略同步不建

表达式策略是在 Authentik 里跑的 Python，能建、能改它就等于能在 Authentik 里执行代码，同步的 token 绝不能有这个
权限。两条策略上线时用 ak shell 建一次（接入说明第七节），同步只按名字找、核对代码（去掉注释和空行逐行比）：找不到，
或者代码和 policy_expressions() 不一样（被人改过，或者 AUTHENTIK_USER_PATH 改了），这一段整个不跑，报失败。

# 其他

  - 员工工作台（应用 workbench）不归这里管：它有自己的策略「PanAsia 只放 ERP 同步来的员工」，页面上固定显示给所有员工。
  - 应用的策略引擎模式不是 any 的不碰、报冲突：在 all 下加一条绑定等于多一道都要过的门。统一登录里没有的应用也报冲突，
    别的照做。
  - 绑定的 order：Authentik 要求同一个应用上「策略 + order」不重复（PolicyBinding 的 unique_together），同步挑这个
    应用上谁都没用的 order（从 100 往上），跟谁都撞不上。
  - 先加后删：加绑定先加「非 ERP 账号照旧」，加完再删多余的；一个应用上有加绑定没成，这个应用这一轮先不删，免得删完
    一条不剩、谁都能进，下一轮接着来。
  - 同步的绑定被人改过（停用、取反、策略出错算过、会到期）：删掉，按原样重建；同一样绑了两条的，删掉多的。
  - 别人的绑定可能把 ERP 的号也放进去（别人绑的策略、取反的绑定、单独绑的 ERP 号、组里有 ERP 号），同步不动，
    在报告里提一句。
  - 已经登进某个系统的人，收回后不会马上被踢出来，等那个系统自己的会话过期。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.config import settings
from app.models import PlatformAccessMap, PlatformGroup, Staff
from app.services.authentik_sync import (
    AkApplication,
    AkBinding,
    AkGroup,
    AkUser,
    AuthentikApi,
    AuthentikError,
    SyncReport,
    _NewGroup,
)
from app.services.platform_groups import Membership, is_active_human

log = logging.getLogger(__name__)

TITLE = "能进哪些系统"
ALL_STAFF_POLICY = "ERP 同步：所有员工"
NON_ERP_POLICY = "ERP 同步：非 ERP 账号照旧"
ORDER_BASE = 100


# ---------------------------------------------------------------- 系统


@dataclass(frozen=True)
class System:
    key: str                 # 存在 platform_access_map.system 里，上线后别改
    name: str
    description: str
    apps: tuple[str, ...]    # Authentik 里对应的应用（slug），一个系统可能有登录用的和网关用的两个
    note: str | None = None  # 页面上的提示


SYSTEMS: tuple[System, ...] = (
    System("frappe", "Frappe", "HR、Learning、CRM（hr.panasia.fun）", ("frappe",)),
    System("portal", "门户", "Homarr，各系统的入口页", ("homarr",)),
    System("paperless", "Paperless", "文档归档", ("paperless-sso", "paperless-gate")),
    System("nocobase", "NocoBase", "数据表（员工、设备、SIM 卡这些台账）", ("nocobase",)),
    System("litellm", "LiteLLM", "大模型网关的后台", ("litellm-sso", "litellm-gate")),
    System("netdata", "Netdata", "服务器监控", ("netdata-health",)),
    System("gatus", "Gatus", "服务状态页", ("gatus-status",)),
    System("plane", "Plane", "项目管理", ("plane-gitea-bridge",),
           note="ERP 的号用不了 Plane 的统一登录：Plane 按邮箱认人，ERP 的号是占位邮箱。员工在工作台里用 Plane"),
    System("custom_consoles", "自研控制台", "股权、项目管理控制台", ("custom-console-sso",)),
    System("budibase", "Budibase", "低代码应用", ("budibase-sso", "budibase")),
    System("rundeck", "Rundeck", "运维作业", ("rundeck",)),
    System("n8n", "n8n", "自动化流程", ("n8n-sso", "n8n")),
    System("twenty", "Twenty", "另一套 CRM", ("panasia-twenty-crm", "panasia-twenty-crm-gate")),
    System("snipeit", "Snipe-IT", "IT 资产管理", ("snipe-it", "snipe-it-provisioning")),
    System("donetick", "Donetick", "待办", ("donetick",)),
    System("homebox", "Homebox", "物品清单", ("homebox-sso", "homebox-gate")),
)
SYSTEM_BY_KEY = {s.key: s for s in SYSTEMS}
# 固定给所有员工、这里不管的（页面上只读显示一行）
FIXED: tuple[System, ...] = (
    System("workbench", "员工工作台", "work.panasia.fun", ("workbench",),
           note="它自己的策略「PanAsia 只放 ERP 同步来的员工」管着，固定给所有员工，这里不改"),
    System("zentao", "禅道", "zentao.panasia.fun，需求和任务", ("zentao",),
           note="绑的也是「PanAsia 只放 ERP 同步来的员工」，固定给所有员工；禅道里是不是管理员按 ERP 角色定"),
)
_RANK = {s.key: i for i, s in enumerate(SYSTEMS)}


def app_slugs() -> list[str]:
    return [slug for s in SYSTEMS for slug in s.apps]


def _ordered(keys) -> list[str]:
    """按页面上系统的顺序排，代码里没有的排最后。"""
    return sorted(set(keys), key=lambda k: (_RANK.get(k, len(_RANK)), k))


def _names(keys) -> str:
    return "、".join(SYSTEM_BY_KEY[k].name if k in SYSTEM_BY_KEY else k for k in _ordered(keys))


def _latin(ch: str) -> bool:
    return ch.isascii() and ch.isalnum()


def _cat(*parts: str) -> str:
    """拼报告里的一行：汉字和英文名挨着时空一格（「进 Frappe」「进门户」），挨着标点不空。"""
    out = ""
    for part in parts:
        if out and part and out[-1].isalnum() and part[0].isalnum() and _latin(out[-1]) != _latin(part[0]):
            out += " "
        out += part
    return out


class SystemInvalid(ValueError):
    pass


def clean_system(raw: str | None) -> str:
    """映射里的系统：只能是 SYSTEMS 里的；固定的（员工工作台）不在这里配。"""
    key = (raw or "").strip()
    fixed = next((s for s in FIXED if s.key == key), None)
    if fixed is not None:
        raise SystemInvalid(f"{fixed.name}固定给所有员工（{fixed.note}）")
    if key not in SYSTEM_BY_KEY:
        raise SystemInvalid(f"没有「{key}」这个系统")
    return key


# ---------------------------------------------------------------- 映射


@dataclass
class AccessMap:
    """映射表读出来的样子：所有员工能进的系统，和每个分组能进的系统（都按页面顺序排好）。"""
    everyone: list[str]
    by_group: dict[str, list[str]]


def load_access_map(db: Session) -> AccessMap:
    everyone: set[str] = set()
    by_group: dict[str, set[str]] = {}
    for group_id, system in db.query(PlatformAccessMap.group_id, PlatformAccessMap.system).all():
        (everyone if group_id is None else by_group.setdefault(group_id, set())).add(system)
    return AccessMap(everyone=_ordered(everyone), by_group={k: _ordered(v) for k, v in by_group.items()})


def systems_for(staff: Staff | None, members: Membership, access_map: AccessMap) -> list[str]:
    """按分组这个员工能进的系统（key，带固定的员工工作台）。不在职的一个都没有。

    members：谁进哪个组（platform_groups.membership，按角色、手工挂、按部门三种都算）。"""
    if not is_active_human(staff):
        return []
    keys = set(access_map.everyone)
    for g in members.of(staff):
        keys |= set(access_map.by_group.get(g.id, ()))
    return [s.key for s in FIXED] + [k for k in _ordered(keys) if k in SYSTEM_BY_KEY]


# ---------------------------------------------------------------- 两条专用策略


class AccessRefused(Exception):
    """前提不对（两条策略没建、被改过），这一段不跑。"""


def policy_expressions(user_path: str) -> dict[str, str]:
    """两条专用策略：名字 → 表达式。上线时照这个建（接入说明第七节的 ak shell），同步按它核对。

    user_path 就是 AUTHENTIK_USER_PATH。request.user 在 Authentik 里一定有（引擎不收空的），没登录时是匿名用户，
    没有 path、attributes，所以全用 getattr 取，匿名的一律不过；应用的门本来就要先登录，这里只是兜底。
    """
    is_erp = (f'getattr(user, "path", None) == {json.dumps(user_path)} '
              f'and isinstance(attrs, dict) and bool(attrs.get("erp_sub"))')
    head = (
        "user = request.user\n"
        "if user is None or not user.is_authenticated:\n"
        "    return False\n"
        'attrs = getattr(user, "attributes", None)\n'
    )
    return {
        ALL_STAFF_POLICY: (
            f"# ERP 同步来的号：路径 {user_path}、带 erp_sub（和工作台那条「PanAsia 只放 ERP 同步来的员工」一个口径）。\n"
            "# ERP 停用的员工，统一登录的号也停了，本来就登不进来。ERP 的同步按名字认这条策略、核对下面的代码，别改\n"
            + head + f"return {is_erp}\n"
        ),
        NON_ERP_POLICY: (
            "# 不是 ERP 同步来的号（akadmin、服务账号这些）。ERP 的同步只把它绑在原来谁都能进的应用上，让这些号照旧能进。\n"
            "# ERP 的同步按名字认这条策略、核对下面的代码，别改\n"
            + head + f"return not ({is_erp})\n"
        ),
    }


def _code_lines(text: str) -> list[str]:
    """比代码时去掉注释行、空行和每行首尾的空白：改注释、换缩进风格不算改。"""
    return [s for s in (line.strip() for line in (text or "").splitlines()) if s and not s.startswith("#")]


def load_policies(api: AuthentikApi, user_path: str) -> dict[str, str]:
    """两条专用策略的名字 → pk。没建、代码和 ERP 要的不一样：抛 AccessRefused。"""
    out: dict[str, str] = {}
    for name, expression in policy_expressions(user_path).items():
        policy = api.find_expression_policy(name)
        if policy is None:
            raise AccessRefused(f"统一登录里没有表达式策略「{name}」，这一段没跑：上线时用 ak shell 建好"
                                f"（接入说明第七节第 3 条），同步自己不建")
        if _code_lines(policy.expression) != _code_lines(expression):
            raise AccessRefused(f"统一登录里策略「{name}」的代码和 ERP 要的不一样（被改过，或者 AUTHENTIK_USER_PATH "
                                f"改了），这一段没跑：照接入说明第七节第 3 条重新跑一遍 ak shell 改回来")
        out[name] = policy.pk
    return out


# ---------------------------------------------------------------- 算差异


@dataclass
class AccessStep:
    kind: str                            # create_binding / delete_binding
    text: str                            # 给人看的一行
    app: str                             # 应用 slug（一个应用上加没成，这个应用就先不删）
    body: dict = field(default_factory=dict)       # 加绑定的请求体
    group: str | _NewGroup | None = None           # 加组绑定时的组，可能是这一轮才建的（执行时换成 pk）
    binding: str | None = None                     # 要删的绑定
    ok: bool | None = None
    error: str | None = None


@dataclass
class AccessPlan:
    steps: list[AccessStep] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def add(self, kind: str, text: str, **kwargs) -> AccessStep:
        step = AccessStep(kind, text, **kwargs)
        self.steps.append(step)
        return step


def _tampered(b: AkBinding) -> str | None:
    """同步建的绑定被人改成了什么样；原样的回 None。"""
    words = []
    if not b.enabled:
        words.append("停用了")
    if b.negate:
        words.append("取反了")
    if b.policy and b.failure_result:
        words.append("策略出错也算过")
    if b.expiring:
        words.append("会到期")
    return "、".join(words) or None


def _foreign_note(b: AkBinding, where: str, erp_users: dict[int, AkUser]) -> str | None:
    """别人的绑定会不会把 ERP 的号也放进去（同步不动它，提一句）。"""
    if b.policy:
        return f"{where}上还有别人绑的策略「{b.label}」，ERP 的号过得了它就能进，不看映射"
    if b.negate:
        return f"{where}上有一条取反的绑定「{b.label}」，不在里面的人（含 ERP 的号）都能进，不看映射"
    if b.user is not None:
        user = erp_users.get(b.user)
        return f"{where}上单独放了 ERP 的号 {user.username}，不看映射" if user else None
    inside = sorted(u.username for u in erp_users.values() if b.group in u.groups)
    if inside:
        return f"{where}上绑着别人的组「{b.label}」，组里的 ERP 的号（{'、'.join(inside)}）也能进，不看映射"
    return None


def build_access_plan(
    access_map: AccessMap,
    erp_groups: list[PlatformGroup],
    group_links: dict[str, tuple],
    ak_users: list[AkUser],
    ak_groups: list[AkGroup],
    apps: dict[str, AkApplication | None],
    bindings: list[AkBinding],
    policies: dict[str, str],
    *,
    user_path: str,
) -> AccessPlan:
    """ERP 的映射 + Authentik 现状 → 要加、要删的绑定。纯计算，不读不写任何外部东西。

    group_links：统一登录同步这一轮算出来的「分组 → (Authentik 组, 组名, 原因)」，组可能是这一轮才建的（_NewGroup），
    没对上是 None；apps：slug → 应用（统一登录里没有是 None）；bindings：这些应用上的全部绑定；
    policies：两条专用策略的名字 → pk。
    """
    plan = AccessPlan()
    all_staff, non_erp = policies[ALL_STAFF_POLICY], policies[NON_ERP_POLICY]
    erp_group_pks = {g.pk for g in ak_groups if g.erp_managed}
    group_names = {g.pk: g.name for g in ak_groups}
    erp_users = {u.pk: u for u in ak_users if u.path == user_path and u.attributes.get("erp_sub")}

    # ---- 映射：每个系统要放哪些 ERP 组 ----
    everyone = {k for k in access_map.everyone if k in SYSTEM_BY_KEY}
    by_system: dict[str, list[tuple[str | _NewGroup, str]]] = {s.key: [] for s in SYSTEMS}
    unknown = set(access_map.everyone)
    for g in erp_groups:
        keys = access_map.by_group.get(g.id, [])
        unknown |= set(keys)
        keys = [k for k in keys if k in SYSTEM_BY_KEY]
        if not keys:
            continue
        ref = group_links.get(g.id, (None, None, None))[0]
        if ref is None:
            plan.conflicts.append(f"分组「{g.name}」在统一登录里还没对上（见上面统一登录同步的冲突），"
                                  f"它能进的{_names(keys)}先没放行")
            continue
        for k in keys:
            by_system[k].append((ref, g.name))
    for key in sorted(unknown - set(SYSTEM_BY_KEY)):
        plan.notes.append(f"映射里的「{key}」代码里已经没有这个系统了，没管（后台「能进哪些系统」随便改一处保存，就清掉了）")

    # ---- 每个应用：要的绑定 vs 已有的同步绑定 ----
    by_target: dict[str, list[AkBinding]] = {}
    for b in bindings:
        by_target.setdefault(b.target, []).append(b)

    def who(key: tuple) -> str:
        kind, value = key
        if kind == "policy":
            return "非 ERP 账号照旧" if value == non_erp else "所有员工"
        return value.name if isinstance(value, _NewGroup) else group_names.get(value, value)

    def is_mine(b: AkBinding) -> bool:
        return b.group in erp_group_pks or b.policy in (all_staff, non_erp)

    for system in SYSTEMS:
        for slug in system.apps:
            app = apps.get(slug)
            where = f"{system.name}（{slug}）"
            if app is None:
                plan.conflicts.append(f"{where}：统一登录里没有这个应用，没管")
                continue
            if app.policy_engine_mode != "any":
                plan.conflicts.append(f"{where}：应用的策略引擎模式是「{app.policy_engine_mode}」，同步只管「any」的"
                                      f"（不是 any 时多一条绑定就多一道都要过的门），没碰")
                continue
            current = by_target.get(app.pk, [])
            mine = [b for b in current if is_mine(b)]
            theirs = [b for b in current if not is_mine(b) and b.enabled]
            for b in theirs:
                if note := _foreign_note(b, where, erp_users):
                    plan.notes.append(note)

            want: list[tuple] = []   # 先「非 ERP 账号照旧」再「所有员工」再各组：加的时候也是这个顺序
            if not theirs:
                want.append(("policy", non_erp))
            if system.key in everyone:
                want.append(("policy", all_staff))
            want += [("group", ref) for ref, _ in sorted(by_system[system.key], key=lambda x: x[1])]

            # 已有的同步绑定：每样留第一条原样的，其余（不要了的、重复的、被改过的）都删
            kept: set[tuple] = set()
            drop: list[tuple[AkBinding, str]] = []
            for b in sorted(mine, key=lambda x: (x.order, x.pk)):
                key = ("policy", b.policy) if b.policy else ("group", b.group)
                if key in want and key not in kept and _tampered(b) is None:
                    kept.add(key)
                    continue
                if key not in want:
                    if key == ("policy", non_erp):
                        text = _cat("去掉", where, "上的「非 ERP 账号照旧」：上面另有别人的绑定，非 ERP 的号能不能进由它们管")
                    elif key == ("policy", all_staff):
                        text = _cat("收回所有员工进", where)
                    else:
                        text = _cat(f"收回「{who(key)}」进", where)
                elif (changed := _tampered(b)) is not None:
                    text = _cat("删掉", where, f"上被改过的「{who(key)}」绑定（{changed}）")
                else:
                    text = _cat("去掉", where, f"上重复的「{who(key)}」绑定")
                drop.append((b, text))

            used = {b.order for b in current}
            order = ORDER_BASE
            for key in want:
                if key in kept:
                    continue
                while order in used:
                    order += 1
                used.add(order)
                kind, value = key
                body = {"target": app.pk, "order": order, "enabled": True, "negate": False, "failure_result": False}
                if kind == "policy":
                    body["policy"] = value
                    text = (_cat("非 ERP 账号照旧能进", where, "：原来谁都能进") if value == non_erp
                            else _cat("放行所有员工进", where))
                    plan.add("create_binding", text, app=slug, body=body)
                else:
                    if isinstance(value, str):
                        body["group"] = value
                    new = "：组这一轮新建" if isinstance(value, _NewGroup) else ""
                    plan.add("create_binding", _cat(f"放行「{who(key)}」进", where, new), app=slug, body=body,
                             group=value)
            for b, text in drop:
                plan.add("delete_binding", text, app=slug, binding=b.pk)
    return plan


# ---------------------------------------------------------------- 执行


def apply_access_plan(api: AuthentikApi, plan: AccessPlan, new_groups: dict[str, str]) -> None:
    """先加后删。一步失败记在这一步上，别的照做；一个应用上有加绑定没成，这个应用先不删（免得删到一条不剩、
    谁都能进）。new_groups：这一轮新建的组（ERP 分组 ID → pk）。"""
    creates = [s for s in plan.steps if s.kind == "create_binding"]
    for step in creates:
        body = dict(step.body)
        if isinstance(step.group, _NewGroup):
            pk = new_groups.get(step.group.erp_group_id)
            if pk is None:
                step.ok, step.error = False, "前面建组没成，跳过"
                continue
            body["group"] = pk
        try:
            api.create_binding(body)
            step.ok = True
        except AuthentikError as exc:
            step.ok, step.error = False, str(exc)
            log.warning("能进哪些系统：%s 没成：%s", step.text, exc)
    stuck = {s.app for s in creates if s.ok is False}
    for step in (s for s in plan.steps if s.kind == "delete_binding"):
        if step.app in stuck:
            step.ok, step.error = False, "这个应用前面加绑定没成，先不删，下一轮再来"
            continue
        try:
            api.delete_binding(step.binding)
            step.ok = True
        except AuthentikError as exc:
            step.ok, step.error = False, str(exc)
            log.warning("能进哪些系统：%s 没成：%s", step.text, exc)


# ---------------------------------------------------------------- 入口


_COUNT_NAMES = {"create_binding": "加绑定", "delete_binding": "删绑定"}


def _not_run(dry_run: bool, why: str) -> SyncReport:
    return SyncReport(dry_run=dry_run, actions=[], conflicts=[], notes=[], errors=[why], counts={},
                      title=TITLE, headline="没同步")


def run(
    db: Session,
    api: AuthentikApi,
    *,
    erp_groups: list[PlatformGroup],
    group_links: dict[str, tuple],
    ak_users: list[AkUser],
    ak_groups: list[AkGroup],
    new_groups: dict[str, str],
    dry_run: bool,
) -> SyncReport | None:
    """统一登录同步每一轮建完号、组之后调。开关关着的真跑返回 None（报告里不出这一段）。

    读写 Authentik 出错、两条策略不对，都记在这一段的「失败」里，不抛：前面号和组已经改完了，报告不能丢。
    """
    enabled = settings.authentik_access_sync_enabled
    if not dry_run and not enabled:
        return None
    user_path = settings.authentik_user_path.strip()
    try:
        policies = load_policies(api, user_path)
        apps = {slug: api.get_application(slug) for slug in app_slugs()}
        bindings = api.list_bindings([a.pk for a in apps.values() if a is not None])
    except AccessRefused as exc:
        return _not_run(dry_run, str(exc))
    except AuthentikError as exc:
        return _not_run(dry_run, f"读统一登录失败：{exc}")
    plan = build_access_plan(load_access_map(db), erp_groups, group_links, ak_users, ak_groups, apps, bindings,
                             policies, user_path=user_path)
    errors: list[str] = []
    if not dry_run:
        apply_access_plan(api, plan, new_groups)
        errors = [f"{s.text}：{s.error}" for s in plan.steps if s.ok is False]
    done = [s for s in plan.steps if dry_run or s.ok]
    notes = list(plan.notes)
    if dry_run and not enabled:
        notes.insert(0, "开关 AUTHENTIK_ACCESS_SYNC_ENABLED 没开：定时器和「立即同步」都跳过这一段，这里只是预演")
    return SyncReport(
        dry_run=dry_run,
        actions=[s.text for s in done],
        conflicts=plan.conflicts,
        notes=notes,
        errors=errors,
        counts={name: sum(1 for s in done if s.kind == kind) for kind, name in _COUNT_NAMES.items()},
        title=TITLE,
    )
