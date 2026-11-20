"""能进哪些系统：按平台分组在统一登录（Authentik）的应用上加减绑定（services/authentik_access.py）。

Authentik 是假的（tests/fake_authentik.py），起手是 10-19 线上读到的那一套：非 ERP 的号（akadmin、QQ 邮箱那位、
outpost 和 erp-sync 两个服务账号）、PanAsia 的两个组、24 个应用和它们的绑定（工作台那条策略也在），两条专用策略
照接入说明建好了。fake.can_enter() 照 Authentik 的引擎判能不能进，策略绑定真的跑表达式。

# 这里钉死的

  1. 默认映射（迁移 081）在线上那套应用上加出来的正好是那 22 条绑定；工作台、别人的绑定一条不碰；
  2. 谁能进哪个系统：非 ERP 的号一个不变；ERP 的号只进映射里的（加上工作台），别的回到 10-18 之前；
     两条策略对匿名、空用户都不放；
  3. 原来谁都能进的应用加「非 ERP 账号照旧」，有别人绑定的不加；别人后来加了绑定就去掉，删光了再加回来；
     停用的别人的绑定不算；
  4. 改映射、删分组：只删同步自己的绑定；跑第二遍什么都不做；预演一个写请求都没有；
  5. 同步的绑定被改过（停用、取反）删掉重建，重复的删掉；挑的 order 跟谁都不撞；加没成的应用这一轮不删；
  6. 两条策略没建、代码被改过：这一段不跑、报失败，号和组照常同步；改注释不算改；
  7. 统一登录里没有的应用、策略引擎模式不是 any 的应用：报冲突，别的照做；分组没对上：它的系统先不放行；
  8. 缺哪条权限就报哪条；开关关着真跑不出这一段，预演照样算；
  9. ERP 的组绑在不归这里管的应用上不碰；别人的组里混进了 ERP 的号：提一句、不动；
 10. 后台：改映射（整张覆盖、校验）、员工列表带能进的系统、状态带开关、删分组连映射一起删、手动触发带这一段；
 11. 迁移 081 种的默认映射、按名字找分组；接入说明里的 ak shell 就是代码里那两段表达式。
"""

import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text

from app.config import settings
from app.database import get_db
from app.deps import create_access_token
from app.enums import StaffRole, StaffStatus
from app.models import AuthentikAccount, PlatformAccessMap, PlatformGroup, Staff
from app.routers import sso as sso_router
from app.services import authentik_access, authentik_sync
from app.services.authentik_access import ALL_STAFF_POLICY, NON_ERP_POLICY, policy_expressions
from app.services.password import hash_password
from fake_authentik import TOKEN, FakeAuthentik, run_expression

_PW_HASH = hash_password("pw")   # bcrypt 慢，一个模块算一次
ROOT = Path(__file__).resolve().parents[2]
VERSIONS = ROOT / "server" / "alembic" / "versions"

ALL = f"策略 {ALL_STAFF_POLICY}"
NON_ERP = f"策略 {NON_ERP_POLICY}"
ADMINS = "组 PanAsia Administrators"
EMPLOYEES = "组 PanAsia Employees"
ERP_ADMIN = "组 ERP管理员"
WORKBENCH_POLICY = "PanAsia 只放 ERP 同步来的员工"

# 10-19 线上读到的：应用 → 别人绑的组（工作台另有一条策略）
LIVE_APPS = {
    "budibase-sso": [], "budibase": [], "custom-console-sso": [], "donetick": [], "frappe": [],
    "gatus-status": [], "homebox-sso": ["PanAsia Administrators"], "homebox-gate": ["PanAsia Administrators"],
    "litellm-sso": ["PanAsia Administrators"], "litellm-gate": ["PanAsia Administrators"],
    "netdata-health": [], "nocobase": [],
    "paperless-sso": ["PanAsia Administrators", "PanAsia Employees"],
    "paperless-gate": ["PanAsia Administrators", "PanAsia Employees"],
    "plane-gitea-bridge": [], "rundeck": [], "snipe-it-provisioning": ["PanAsia Employees"],
    "panasia-twenty-crm": ["PanAsia Administrators", "PanAsia Employees"],
    "panasia-twenty-crm-gate": ["PanAsia Administrators", "PanAsia Employees"],
    "n8n-sso": [], "n8n": [], "homarr": [], "snipe-it": ["PanAsia Employees", "PanAsia Administrators"],
    "workbench": [],
}

# 默认映射同步一遍以后，每个应用上的绑定
EXPECTED = {
    "frappe": [ALL, NON_ERP], "homarr": [ALL, NON_ERP],
    "paperless-sso": [ERP_ADMIN, ADMINS, EMPLOYEES], "paperless-gate": [ERP_ADMIN, ADMINS, EMPLOYEES],
    "nocobase": [ERP_ADMIN, NON_ERP],
    "litellm-sso": [ERP_ADMIN, ADMINS], "litellm-gate": [ERP_ADMIN, ADMINS],
    "netdata-health": [ERP_ADMIN, NON_ERP], "gatus-status": [ERP_ADMIN, NON_ERP],
    "plane-gitea-bridge": [NON_ERP], "custom-console-sso": [NON_ERP],
    "budibase-sso": [NON_ERP], "budibase": [NON_ERP], "rundeck": [NON_ERP],
    "n8n-sso": [NON_ERP], "n8n": [NON_ERP], "donetick": [NON_ERP],
    "panasia-twenty-crm": [ADMINS, EMPLOYEES], "panasia-twenty-crm-gate": [ADMINS, EMPLOYEES],
    "snipe-it": [ADMINS, EMPLOYEES], "snipe-it-provisioning": [EMPLOYEES],
    "homebox-sso": [ADMINS], "homebox-gate": [ADMINS],
    "workbench": [f"策略 {WORKBENCH_POLICY}"],
}
NON_ERP_USERS = ["akadmin", "someone-qq", "ak-outpost-1", "erp-sync"]


def _migration(name):
    spec = importlib.util.spec_from_file_location(f"migration_{name}", VERSIONS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def ak(monkeypatch):
    fake = FakeAuthentik()
    akadmin = fake.add_user("akadmin", name="authentik Default Admin")
    qq = fake.add_user("someone-qq", name="QQ 邮箱的那位")
    fake.add_user("ak-outpost-1", type="internal_service_account", path="goauthentik.io/outposts")
    fake.add_user("erp-sync", type="service_account", path="goauthentik.io/service-accounts")
    fake.add_group("authentik Admins", is_superuser=True, members=[akadmin])
    fake.add_group("PanAsia Administrators", members=[akadmin])
    fake.add_group("PanAsia Employees", members=[qq])
    fake.add_policy(WORKBENCH_POLICY,
                    'return request.user.path == "erp" and bool(request.user.attributes.get("erp_sub"))')
    for name, expression in policy_expressions("erp").items():
        fake.add_policy(name, expression)
    for slug, groups in LIVE_APPS.items():
        fake.add_app(slug)
        for group in groups:
            fake.bind(slug, group=group)
    fake.bind("workbench", policy=WORKBENCH_POLICY)
    monkeypatch.setattr(settings, "authentik_url", "https://id.test")
    monkeypatch.setattr(settings, "authentik_api_token", TOKEN)
    monkeypatch.setattr(settings, "authentik_user_path", "erp")
    monkeypatch.setattr(settings, "authentik_sync_enabled", True)
    monkeypatch.setattr(settings, "authentik_access_sync_enabled", True)
    transport = httpx.MockTransport(fake.handler)
    monkeypatch.setattr(authentik_sync, "make_api", lambda transport_=None: authentik_sync.AuthentikApi(
        settings.authentik_url, settings.authentik_api_token, transport=transport))
    return fake


def _staff(db, username, role=StaffRole.SALES, status=StaffStatus.ACTIVE):
    s = Staff(staff_no=f"E-{username}", username=username, name=username.upper(),
              password_hash=_PW_HASH, role=role, status=status)
    db.add(s)
    db.commit()
    return s


def _group(db, name):
    return db.query(PlatformGroup).filter_by(name=name).one()


def _set_map(db, mapping):
    """{组名或 None: [系统]} 整张换掉。"""
    db.query(PlatformAccessMap).delete()
    for group, systems in mapping.items():
        for system in systems:
            db.add(PlatformAccessMap(group_id=_group(db, group).id if group else None, system=system))
    db.commit()


@pytest.fixture()
def erp(db_session):
    """默认分组用迁移 079 种的、默认映射用迁移 081 种的。"""
    for name, roles, description in _migration("079_platform_sso").DEFAULT_GROUPS:
        db_session.add(PlatformGroup(name=name, roles=roles, description=description))
    db_session.commit()
    for group, system in _migration("081_platform_access").DEFAULT_ACCESS_MAP:
        db_session.add(PlatformAccessMap(group_id=_group(db_session, group).id if group else None, system=system))
    db_session.commit()
    return {
        "admin": _staff(db_session, "admin", StaffRole.ADMIN),
        "zhangsan": _staff(db_session, "zhangsan", StaffRole.SALES),
        "lisi": _staff(db_session, "lisi", StaffRole.PURCHASER),
        "wangwu": _staff(db_session, "wangwu", StaffRole.SALES, status=StaffStatus.DISABLED),
        "crawler": _staff(db_session, "crawler-01", StaffRole.CRAWLER),
    }


def _sync(db, *, dry_run=False):
    api = authentik_sync.make_api()
    try:
        return authentik_sync.run_sync(db, api, dry_run=dry_run)
    finally:
        api.close()


def _access(report):
    [section] = report.sections
    assert section.title == "能进哪些系统"
    return section


def _theirs(ak):
    """不归同步管的绑定（别人绑的组、用户、策略）。"""
    ours = {ak.policy(ALL_STAFF_POLICY)["pk"], ak.policy(NON_ERP_POLICY)["pk"]}
    erp_groups = {pk for pk, g in ak.groups.items() if g["attributes"].get("erp_managed")}
    return {pk: copy.deepcopy(b) for pk, b in ak.bindings.items()
            if b["policy"] not in ours and b["group"] not in erp_groups}


def _can(ak, username):
    return sorted(slug for slug in ak.apps if ak.can_enter(slug, username))


def _binding_writes(ak):
    return [c for c in ak.writes() if "/policies/" in c[1]]


# --- 1. 默认映射 -----------------------------------------------------------------
def test_默认映射在线上那套应用上_加出来的正好是这些(db_session, ak, erp):
    report = _sync(db_session)
    access = _access(report)
    assert access.errors == [] and access.conflicts == [] and access.notes == []
    assert access.counts == {"加绑定": 22, "删绑定": 0}
    assert {slug: ak.describe(slug) for slug in ak.apps} == {k: sorted(v) for k, v in EXPECTED.items()}
    assert "放行「ERP管理员」进 Paperless（paperless-sso）：组这一轮新建" in access.actions
    assert "非 ERP 账号照旧能进 Rundeck（rundeck）：原来谁都能进" in access.actions
    assert "放行所有员工进门户（homarr）" in access.actions
    assert report.lines()[-23] == "能进哪些系统：加绑定 22"
    assert not report.has_errors()


def test_系统目录_线上那些应用都归了类_slug不重复():
    slugs = authentik_access.app_slugs()
    assert len(slugs) == len(set(slugs))
    assert set(slugs) == set(LIVE_APPS) - {"workbench"}, "工作台不归这里管"
    assert [s.key for s in authentik_access.FIXED] == ["workbench", "zentao"], "工作台、禅道固定给所有员工，不归这里管"


# --- 2. 谁能进哪个系统 ---------------------------------------------------------------
def test_非ERP的号一个不变_ERP的号只进映射里的(db_session, ak, erp):
    before = ak.access_table(NON_ERP_USERS)
    _sync(db_session)
    assert ak.access_table(NON_ERP_USERS) == before, "akadmin、QQ 那位、服务账号能进的一个不变"
    everyone = ["frappe", "homarr", "workbench"]
    assert _can(ak, "zhangsan") == everyone and _can(ak, "lisi") == everyone
    assert _can(ak, "admin") == sorted(everyone + [
        "paperless-sso", "paperless-gate", "nocobase", "litellm-sso", "litellm-gate", "netdata-health", "gatus-status",
    ])
    assert ak.user("wangwu") is None and ak.user("crawler-01") is None


def test_两条策略对匿名和空用户都不放_口径和工作台一样():
    exprs = policy_expressions("erp")
    for user in (None, SimpleNamespace(is_authenticated=False, username="")):
        assert not run_expression(exprs[ALL_STAFF_POLICY], user) and not run_expression(exprs[NON_ERP_POLICY], user)
    erp_user = SimpleNamespace(is_authenticated=True, path="erp", attributes={"erp_sub": "s-1"})
    other = SimpleNamespace(is_authenticated=True, path="users", attributes={})
    no_sub = SimpleNamespace(is_authenticated=True, path="erp", attributes={})   # 同步也不认它是 ERP 的号
    odd = SimpleNamespace(is_authenticated=True, path="erp", attributes=None)
    assert run_expression(exprs[ALL_STAFF_POLICY], erp_user) and not run_expression(exprs[NON_ERP_POLICY], erp_user)
    for user in (other, no_sub, odd):
        assert not run_expression(exprs[ALL_STAFF_POLICY], user) and run_expression(exprs[NON_ERP_POLICY], user)
    assert '"erp"' in exprs[ALL_STAFF_POLICY] and '"staff"' in policy_expressions("staff")[ALL_STAFF_POLICY]


# --- 3. 「非 ERP 账号照旧」 ------------------------------------------------------------
def test_别人后来加了绑定_非ERP照旧那条去掉_删光了再加回来(db_session, ak, erp):
    _sync(db_session)
    ak.bind("rundeck", group="PanAsia Administrators")
    report = _sync(db_session)
    assert _access(report).actions == [
        "去掉 Rundeck（rundeck）上的「非 ERP 账号照旧」：上面另有别人的绑定，非 ERP 的号能不能进由它们管"]
    assert ak.describe("rundeck") == [ADMINS]
    assert ak.can_enter("rundeck", "akadmin") and not ak.can_enter("rundeck", "someone-qq")
    for b in ak.bindings_of("rundeck"):
        del ak.bindings[b["pk"]]
    _sync(db_session)
    assert ak.describe("rundeck") == [NON_ERP] and ak.can_enter("rundeck", "someone-qq")


def test_停用的别人的绑定不算_挑的order跟谁都不撞(db_session, ak, erp):
    """假 Authentik 不收同一个应用上撞了的 order（比真的严），撞了就会报失败。"""
    ak.bind("frappe", group="PanAsia Employees", order=100, enabled=False)
    ak.bind("frappe", group="PanAsia Administrators", order=101, enabled=False)
    report = _sync(db_session)
    assert _access(report).errors == []
    assert ak.describe("frappe") == sorted([ALL, NON_ERP, f"{EMPLOYEES}（停用）", f"{ADMINS}（停用）"])
    orders = [b["order"] for b in ak.bindings_of("frappe")]
    assert sorted(orders) == [100, 101, 102, 103]
    assert ak.can_enter("frappe", "someone-qq") and ak.can_enter("frappe", "zhangsan")


# --- 4. 改映射 / 幂等 / 预演 ---------------------------------------------------------
def test_改映射_只删同步自己的绑定(db_session, ak, erp):
    _sync(db_session)
    theirs = _theirs(ak)
    _set_map(db_session, {None: ["frappe"], "ERP管理员": ["nocobase", "litellm", "netdata", "gatus"]})
    access = _access(_sync(db_session))
    assert sorted(access.actions) == sorted([
        "收回「ERP管理员」进 Paperless（paperless-sso）", "收回「ERP管理员」进 Paperless（paperless-gate）",
        "收回所有员工进门户（homarr）",
    ])
    assert access.counts == {"加绑定": 0, "删绑定": 3}
    assert ak.describe("paperless-sso") == sorted([ADMINS, EMPLOYEES]) and ak.describe("homarr") == [NON_ERP]
    assert _theirs(ak) == theirs
    assert not ak.can_enter("homarr", "zhangsan") and ak.can_enter("homarr", "akadmin")
    assert not ak.can_enter("paperless-sso", "admin")


def test_给分组加系统_只加这个组的绑定(db_session, ak, erp):
    _sync(db_session)
    _set_map(db_session, {None: ["frappe", "portal"], "销售": ["rundeck"]})
    access = _access(_sync(db_session))
    assert "放行「销售」进 Rundeck（rundeck）" in access.actions
    assert ak.describe("rundeck") == sorted(["组 销售", NON_ERP])
    assert ak.can_enter("rundeck", "zhangsan") and not ak.can_enter("rundeck", "lisi")
    assert ak.can_enter("rundeck", "akadmin"), "非 ERP 的号照旧能进"


def test_跑第二遍什么都不做(db_session, ak, erp):
    _sync(db_session)
    writes = len(ak.writes())
    report = _sync(db_session)
    assert len(ak.writes()) == writes
    assert report.lines() == ["统一登录同步：没有要改的", "能进哪些系统：没有要改的"]


def test_预演一个写请求都没有(db_session, ak, erp):
    before = ak.snapshot()
    report = _sync(db_session, dry_run=True)
    access = _access(report)
    assert access.dry_run and access.counts["加绑定"] == 22 and access.errors == []
    assert access.lines()[0] == "能进哪些系统预演（只看不改）：加绑定 22"
    assert ak.writes() == [] and ak.snapshot() == before
    assert db_session.query(AuthentikAccount).count() == 0


def test_删掉分组_它在应用上的绑定下一轮删掉(db_session, ak, erp, admin_client):
    _set_map(db_session, {None: ["frappe", "portal"], "财务": ["nocobase"]})
    _sync(db_session)
    assert "组 财务" in ak.describe("nocobase")
    finance = _group(db_session, "财务")
    assert admin_client.delete(f"/api/sso/groups/{finance.id}", headers=_auth(erp["admin"])).status_code == 204
    assert db_session.query(PlatformAccessMap).filter_by(group_id=finance.id).count() == 0
    access = _access(_sync(db_session))
    assert access.actions == ["收回「财务」进 NocoBase（nocobase）"]
    assert ak.describe("nocobase") == [NON_ERP] and ak.group("财务") is not None, "组本身留着"


# --- 5. 被改过 / 失败 ---------------------------------------------------------------
def test_同步的绑定被改过_删掉重建_重复的删掉(db_session, ak, erp):
    _sync(db_session)
    all_staff = ak.policy(ALL_STAFF_POLICY)["pk"]
    tampered = next(b for b in ak.bindings_of("frappe") if b["policy"] == all_staff)
    tampered["negate"] = True
    ak.bind("nocobase", group="ERP管理员")   # 有人手工又绑了一条
    access = _access(_sync(db_session))
    assert sorted(access.actions) == sorted([
        "放行所有员工进 Frappe（frappe）",
        "删掉 Frappe（frappe）上被改过的「所有员工」绑定（取反了）",
        "去掉 NocoBase（nocobase）上重复的「ERP管理员」绑定",
    ])
    assert tampered["pk"] not in ak.bindings
    assert ak.describe("frappe") == sorted([ALL, NON_ERP]) and ak.describe("nocobase") == sorted([ERP_ADMIN, NON_ERP])
    assert _access(_sync(db_session)).actions == []


def test_加绑定没成_这个应用这一轮不删(db_session, ak, erp):
    _sync(db_session)
    all_staff = ak.policy(ALL_STAFF_POLICY)["pk"]
    old = next(b for b in ak.bindings_of("frappe") if b["policy"] == all_staff)
    old["enabled"] = False
    ak.fail[("POST", "frappe")] = 500
    report = _sync(db_session)
    errors = _access(report).errors
    assert any(e.startswith("放行所有员工进 Frappe（frappe）：") and "500" in e for e in errors)
    assert any(e.startswith("删掉 Frappe（frappe）上被改过的") and "先不删" in e for e in errors)
    assert old["pk"] in ak.bindings and report.has_errors()
    del ak.fail[("POST", "frappe")]
    assert not _sync(db_session).has_errors()
    assert ak.describe("frappe") == sorted([ALL, NON_ERP])


# --- 6. 两条策略 ---------------------------------------------------------------------
def test_两条策略没建_这一段不跑_号和组照常同步(db_session, ak, erp):
    del ak.policies[ak.policy(NON_ERP_POLICY)["pk"]]
    report = _sync(db_session)
    access = _access(report)
    assert access.lines()[0] == "能进哪些系统：没同步"
    assert "没有表达式策略「ERP 同步：非 ERP 账号照旧」" in access.errors[0] and "ak shell" in access.errors[0]
    assert _binding_writes(ak) == [] and report.has_errors()
    assert ak.user("zhangsan") is not None and ak.group("ERP管理员") is not None, "号和组照常同步"


def test_策略的代码被改过_这一段不跑_改注释不算(db_session, ak, erp):
    policy = ak.policy(ALL_STAFF_POLICY)
    policy["expression"] = "return True"
    access = _access(_sync(db_session))
    assert "「ERP 同步：所有员工」的代码和 ERP 要的不一样" in access.errors[0]
    assert _binding_writes(ak) == []
    lines = policy_expressions("erp")[ALL_STAFF_POLICY].splitlines()
    policy["expression"] = "# 有人改了注释\n\n" + "\n".join(line for line in lines if not line.startswith("#")) + "\n\n"
    assert _access(_sync(db_session)).errors == []


# --- 7. 冲突 ------------------------------------------------------------------------
def test_统一登录里没有的应用_报冲突_别的照做(db_session, ak, erp):
    del ak.apps["gatus-status"]
    access = _access(_sync(db_session))
    assert access.conflicts == ["Gatus（gatus-status）：统一登录里没有这个应用，没管"]
    assert access.counts["加绑定"] == 20 and access.errors == []


def test_策略引擎模式不是any的应用_报冲突不碰(db_session, ak, erp):
    ak.apps["nocobase"]["policy_engine_mode"] = "all"
    access = _access(_sync(db_session))
    assert any(c.startswith("NocoBase（nocobase）：应用的策略引擎模式是「all」") for c in access.conflicts)
    assert ak.describe("nocobase") == [] and access.errors == []


def test_分组在统一登录里没对上_它的系统先不放行(db_session, ak, erp):
    ak.add_group("采购")   # 统一登录里别人的同名组
    _set_map(db_session, {None: ["frappe", "portal"], "采购": ["rundeck"]})
    report = _sync(db_session)
    assert any("采购" in c and "不是 ERP 建的" in c for c in report.conflicts)
    assert any(c.startswith("分组「采购」在统一登录里还没对上") and "Rundeck" in c for c in _access(report).conflicts)
    assert ak.describe("rundeck") == [NON_ERP]


# --- 8. 权限 / 开关 ---------------------------------------------------------------------
@pytest.mark.parametrize("perm", [
    "authentik_core.view_application",
    "authentik_policies.view_policybinding",
    "authentik_policies.add_policybinding",
    "authentik_policies.delete_policybinding",
    "authentik_policies_expression.view_expressionpolicy",
])
def test_缺权限_报出缺的是哪一条(db_session, ak, erp, perm):
    _sync(db_session)
    _set_map(db_session, {None: ["frappe"], "ERP管理员": ["nocobase"], "销售": ["rundeck"]})   # 有加有删
    ak.deny.add(perm)
    report = _sync(db_session)
    errors = _access(report).errors
    assert errors and all(f"缺权限 {perm}" in e or "先不删" in e for e in errors)
    assert report.has_errors()


def test_开关关着_真跑不出这一段_预演照样算(db_session, ak, erp, monkeypatch):
    monkeypatch.setattr(settings, "authentik_access_sync_enabled", False)
    report = _sync(db_session)
    assert report.sections == [] and not any("/policies/" in p or "/applications/" in p for _, p in ak.calls)
    access = _access(_sync(db_session, dry_run=True))
    assert access.counts["加绑定"] == 22 and "AUTHENTIK_ACCESS_SYNC_ENABLED" in access.notes[0]
    assert _binding_writes(ak) == []


# --- 9. 不归这里管的 ---------------------------------------------------------------------
def test_ERP的组绑在不归这里管的应用上_不碰(db_session, ak, erp):
    _sync(db_session)
    ak.add_app("someone-else")
    ak.bind("someone-else", group="销售")
    ak.bind("workbench", group="ERP管理员")
    before = copy.deepcopy(ak.bindings)
    assert _access(_sync(db_session)).actions == []
    assert ak.bindings == before


def test_别人的组里混进了ERP的号_提一句不动(db_session, ak, erp):
    _sync(db_session)
    ak.group("PanAsia Employees")["users"].add(ak.user("zhangsan")["pk"])
    access = _access(_sync(db_session))
    assert access.actions == []
    assert any(n.startswith("Paperless（paperless-sso）上绑着别人的组「PanAsia Employees」") and "zhangsan" in n
               for n in access.notes)
    assert ak.can_enter("paperless-sso", "zhangsan"), "别人给的照样能进，同步不管"


# --- 10. 后台 ---------------------------------------------------------------------
@pytest.fixture()
def admin_client(db_session):
    app = FastAPI()
    app.include_router(sso_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(app)


def _auth(staff):
    return {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


def test_后台改映射_整张覆盖(db_session, erp, admin_client):
    headers = _auth(erp["admin"])
    body = admin_client.get("/api/sso/access", headers=headers).json()
    assert [s["key"] for s in body["systems"]] == [s.key for s in authentik_access.SYSTEMS]
    assert body["systems"][0]["apps"] == ["frappe"] and body["fixed"][0]["key"] == "workbench"
    rows = body["rows"]
    assert rows[0] == {"group_id": None, "group_name": None, "systems": ["frappe", "portal"]}
    by_name = {r["group_name"]: r for r in rows[1:]}
    assert len(by_name) == 8 and by_name["销售"]["systems"] == []
    assert by_name["ERP管理员"]["systems"] == ["paperless", "nocobase", "litellm", "netdata", "gatus"]
    resp = admin_client.put("/api/sso/access", headers=headers, json={"rows": [
        {"group_id": None, "systems": [" portal ", "frappe", "frappe"]},
        {"group_id": by_name["销售"]["group_id"], "systems": ["rundeck"]},
    ]})
    assert resp.status_code == 200, resp.text
    after = {r["group_name"]: r["systems"] for r in resp.json()["rows"]}
    assert after[None] == ["frappe", "portal"] and after["销售"] == ["rundeck"] and after["ERP管理员"] == []
    assert db_session.query(PlatformAccessMap).count() == 3


@pytest.mark.parametrize("system,expect", [
    ("workbench", "固定给所有员工"),
    ("jira", "没有「jira」这个系统"),
    ("", "没有「」这个系统"),
])
def test_后台改映射_不收的系统(db_session, erp, admin_client, system, expect):
    before = db_session.query(PlatformAccessMap).count()
    resp = admin_client.put("/api/sso/access", headers=_auth(erp["admin"]),
                            json={"rows": [{"group_id": None, "systems": ["frappe", system]}]})
    assert resp.status_code == 400 and expect in resp.json()["detail"]
    assert db_session.query(PlatformAccessMap).count() == before, "报错不留半截"


def test_后台改映射_分组不存在_只给管理员(db_session, erp, admin_client):
    resp = admin_client.put("/api/sso/access", headers=_auth(erp["admin"]),
                            json={"rows": [{"group_id": "no-such-group", "systems": ["frappe"]}]})
    assert resp.status_code == 400 and "分组不存在" in resp.json()["detail"]
    assert admin_client.get("/api/sso/access", headers=_auth(erp["zhangsan"])).status_code == 403


def test_员工列表带上能进的系统_状态里有开关(db_session, erp, admin_client, monkeypatch):
    monkeypatch.setattr(settings, "authentik_access_sync_enabled", True)
    headers = _auth(erp["admin"])
    rows = {r["username"]: r for r in admin_client.get("/api/sso/staff", headers=headers).json()}
    assert rows["admin"]["systems"] == ["workbench", "zentao", "frappe", "portal", "paperless", "nocobase", "litellm",
                                        "netdata", "gatus"]
    assert rows["zhangsan"]["systems"] == ["workbench", "zentao", "frappe", "portal"]
    assert rows["wangwu"]["systems"] == []
    assert admin_client.get("/api/sso/status", headers=headers).json()["access_enabled"] is True


def test_后台手动触发_报告里有这一段(db_session, ak, erp, admin_client):
    resp = admin_client.post("/api/sso/authentik-sync", json={"dry_run": True}, headers=_auth(erp["admin"]))
    assert resp.status_code == 200
    body = resp.json()
    assert body["sections"][0]["counts"]["加绑定"] == 22
    assert "能进哪些系统预演（只看不改）：加绑定 22" in body["lines"]
    assert ak.writes() == []


# --- 11. 迁移 / 文档 ----------------------------------------------------------------
def test_迁移种的默认映射就是10_19定的():
    rows = _migration("081_platform_access").DEFAULT_ACCESS_MAP
    assert rows == [(None, "frappe"), (None, "portal"), ("ERP管理员", "paperless"), ("ERP管理员", "nocobase"),
                    ("ERP管理员", "litellm"), ("ERP管理员", "netdata"), ("ERP管理员", "gatus")]
    groups = {name for name, _, _ in _migration("079_platform_sso").DEFAULT_GROUPS}
    for group, system in rows:
        assert group is None or group in groups
        assert authentik_access.clean_system(system) == system


def test_迁移按名字找分组_找不到的不种_降级删表():
    engine = create_engine("sqlite://")
    module = _migration("081_platform_access")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE platform_group (id VARCHAR(36) PRIMARY KEY, name VARCHAR(80))"))
        conn.execute(text("INSERT INTO platform_group VALUES ('g-admin', 'ERP管理员'), ('g-x', '管理员组')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
        rows = sorted(conn.execute(text("SELECT group_id, system FROM platform_access_map")).fetchall(), key=str)
        assert len(rows) == 7 and {g for g, _ in rows} == {None, "g-admin"}
        conn.execute(text("DELETE FROM platform_access_map"))
        conn.execute(text("DELETE FROM platform_group WHERE id = 'g-admin'"))
        with Operations.context(MigrationContext.configure(conn)):
            module.downgrade()
            module.upgrade()
        rows = conn.execute(text("SELECT group_id, system FROM platform_access_map")).fetchall()
        assert sorted(rows, key=str) == sorted([(None, "frappe"), (None, "portal")], key=str), "ERP管理员 改名了就不种"
        with Operations.context(MigrationContext.configure(conn)):
            module.downgrade()
        assert "platform_access_map" not in inspect(conn).get_table_names()


def test_接入说明里的ak_shell就是代码里那两段():
    doc = (ROOT / "docs" / "统一登录接入说明.md").read_text(encoding="utf-8")
    for name, expression in policy_expressions("erp").items():
        assert f'"{name}"' in doc
        for line in expression.splitlines():
            assert line in doc, f"接入说明里少了这一行：{line}"
    for slug in authentik_access.app_slugs():   # 回滚那段 ak shell 里的应用清单
        assert f'"{slug}"' in doc, slug
    for perm in ("authentik_core.view_application", "authentik_policies.view_policybinding",
                 "authentik_policies.add_policybinding", "authentik_policies.delete_policybinding",
                 "authentik_policies_expression.view_expressionpolicy"):
        assert perm in doc
