"""部门 → 分组（统一登录四期）：HR 在 Frappe HR 员工档案上填的部门，按后台配的映射让人进平台分组
（services/frappe_departments.py，进组统一在 services/platform_groups.py 的 membership 里算）。

Frappe 是假的（tests/fake_frappe.py），起手是 10-19 线上 HR 的样子：部门树（所有部门 → 两个公司各一套默认部门、
三个自己建的），三份测试档案（张三关联的是他原来的号，李四、王主管没关联号）。Authentik 也是假的
（tests/fake_authentik.py），挂着各系统的应用和两条专用策略，fake.can_enter() 照 Authentik 的引擎判谁能进。

# 这里钉死的

  1. 按线上现状、没配映射：第一轮什么都不变（三份档案一份都对不上 ERP 的号）；
  2. 档案 User ID 是 ERP 的占位邮箱、在职、部门（或它的各级上级）配了分组 → 每一处都算：统一登录的组员、登录时发的组、
     Frappe 角色、能进哪些系统、后台员工列表（带来源）；
  3. 没关联号的、关联别的号的、对不上 ERP 员工的、不在职（Left / Inactive / Suspended）的档案都不算；看着像填错了的提一句；
  4. 换部门，组跟着挪，同一轮 Frappe 角色就按新的给；只动按部门进的那部分，按角色进的、手工挂的照旧；
  5. 读不到档案、部门：那一段报失败（定时器退出码 1），照上一轮存下的算，谁也不出组，Frappe 别的照做；
  6. 预演什么都不写（ERP、Frappe、Authentik 都不写）；
  7. 停用、删除的员工、设备账号：档案关联着也一个组都没有；
  8. 两份在职档案关联同一个人：都算、提一句；映射里的部门 Frappe 里没有：报冲突；档案上的部门不在部门列表里：只按它
     自己算；部门绕成圈不卡死；没有「停用」字段的版本也读得了；
  9. 后台：改映射（整张覆盖、校验）、能选的部门现查 Frappe（按树排、带深度）、分组列表带按哪些部门进和权限大的提醒、
     删分组连映射一起删、卡片上的同步两个一起跑（预演时统一登录那一半也按这一轮读到的部门算）；
 10. 迁移 082 建两张表、不种映射，降级删表；接入说明写了这一期。
"""

import importlib.util
import sys
from datetime import datetime
from pathlib import Path

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
from app.models import (
    FrappeDepartmentMap,
    FrappeEmployee,
    FrappeRoleMap,
    PlatformAccessMap,
    PlatformGroup,
    PlatformGroupMember,
    Staff,
)
from app.routers import sso as sso_router
from app.services import authentik_access, authentik_sync, frappe_sync, oidc_provider, platform_groups
from app.services.authentik_access import policy_expressions
from app.services.frappe_departments import Department, DepartmentTree
from app.services.password import hash_password
from fake_authentik import TOKEN, FakeAuthentik
from fake_frappe import KEY, LIVE_DEPARTMENTS, ME, ROOT_DEPARTMENT, SECRET, FakeFrappe

_PW_HASH = hash_password("pw")   # bcrypt 慢，一个模块算一次
ROOT = Path(__file__).resolve().parents[2]
VERSIONS = ROOT / "server" / "alembic" / "versions"
WORKBENCH_POLICY = "PanAsia 只放 ERP 同步来的员工"


def _migration(name):
    spec = importlib.util.spec_from_file_location(f"migration_{name}", VERSIONS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- 夹具


@pytest.fixture()
def fr(monkeypatch):
    fake = FakeFrappe()
    fake.add_user("961000e173@example.invalid", roles=["Employee", "LMS Student"], first_name="张三")   # 原来的员工
    fake.add_user(ME, roles=["System Manager"], first_name="ERP 同步")
    fake.seed_live_hr()
    monkeypatch.setattr(settings, "frappe_sync_url", "https://hr.test")
    monkeypatch.setattr(settings, "frappe_sync_api_key", KEY)
    monkeypatch.setattr(settings, "frappe_sync_api_secret", SECRET)
    monkeypatch.setattr(settings, "frappe_sync_enabled", True)
    transport = httpx.MockTransport(fake.handler)
    monkeypatch.setattr(frappe_sync, "make_api", lambda transport_=None: frappe_sync.FrappeApi(
        settings.frappe_sync_url, KEY, SECRET, transport=transport))
    return fake


@pytest.fixture()
def ak(monkeypatch):
    fake = FakeAuthentik()
    akadmin = fake.add_user("akadmin", name="authentik Default Admin")
    fake.add_group("authentik Admins", is_superuser=True, members=[akadmin])
    fake.add_group("PanAsia Administrators", members=[akadmin])
    fake.add_policy(WORKBENCH_POLICY,
                    'return request.user.path == "erp" and bool(request.user.attributes.get("erp_sub"))')
    for name, expression in policy_expressions("erp").items():
        fake.add_policy(name, expression)
    for slug in authentik_access.app_slugs() + ["workbench"]:
        fake.add_app(slug)
    for slug in ("paperless-sso", "paperless-gate"):
        fake.bind(slug, group="PanAsia Administrators")
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


def _staff(db, username, role=StaffRole.SALES, status=StaffStatus.ACTIVE, name=None):
    s = Staff(staff_no=f"E-{username}", username=username, name=name or username.upper(),
              password_hash=_PW_HASH, role=role, status=status)
    db.add(s)
    db.commit()
    return s


def _group(db, name):
    return db.query(PlatformGroup).filter_by(name=name).one()


@pytest.fixture()
def erp(db_session):
    """默认分组、Frappe 角色、能进哪些系统都用迁移 079 / 080 / 081 种的；部门映射迁移 082 不种，各个测试自己配。"""
    for name, roles, description in _migration("079_platform_sso").DEFAULT_GROUPS:
        db_session.add(PlatformGroup(name=name, roles=roles, description=description))
    db_session.commit()
    for group, role in _migration("080_frappe_sync").DEFAULT_ROLE_MAP:
        db_session.add(FrappeRoleMap(group_id=_group(db_session, group).id if group else None, role=role))
    for group, system in _migration("081_platform_access").DEFAULT_ACCESS_MAP:
        db_session.add(PlatformAccessMap(group_id=_group(db_session, group).id if group else None, system=system))
    db_session.commit()
    return {
        "admin": _staff(db_session, "admin", StaffRole.ADMIN, name="管理员"),
        "zhangsan": _staff(db_session, "zhangsan", StaffRole.SALES, name="张三"),
        "lisi": _staff(db_session, "lisi", StaffRole.PURCHASER, name="李四"),
        "zhuguan": _staff(db_session, "zhuguan", StaffRole.WAREHOUSE, name="王主管"),
        "wangwu": _staff(db_session, "wangwu", StaffRole.SALES, status=StaffStatus.DISABLED, name="王五"),
        "crawler": _staff(db_session, "crawler-01", StaffRole.CRAWLER),
    }


@pytest.fixture()
def admin_client(db_session):
    app = FastAPI()
    app.include_router(sso_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(app)


def _auth(staff):
    return {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


def _map(db, mapping):
    """{部门: [组名]} 整张换掉。"""
    db.query(FrappeDepartmentMap).delete()
    for department, groups in mapping.items():
        for name in groups:
            db.add(FrappeDepartmentMap(department=department, group_id=_group(db, name).id))
    db.commit()


def _email(staff):
    return authentik_sync.staff_email(staff.id)


def _link(fr, employee, staff, **changes):
    """HR 在档案的 User ID 里选上他的号（占位邮箱），顺带改别的字段。"""
    fr.employee_docs[employee].update(user_id=_email(staff), **changes)


def _fr_sync(db, *, dry_run=False):
    api = frappe_sync.make_api()
    try:
        return frappe_sync.run_sync(db, api, dry_run=dry_run)
    finally:
        api.close()


def _ak_sync(db, *, dry_run=False):
    api = authentik_sync.make_api()
    try:
        return authentik_sync.run_sync(db, api, dry_run=dry_run)
    finally:
        api.close()


def _accounts(db):
    """两个定时器各跑一轮：统一登录开号、建组，Frappe 开号（HR 这才在档案里选得到他的号）。"""
    _ak_sync(db)
    _fr_sync(db)


def _dept(report):
    [section] = [s for s in report.sections if s.title == "部门 → 分组"]
    return section


def _rows(db):
    return {r.employee: (r.staff_id, r.department, r.status) for r in db.query(FrappeEmployee)}


# --- 1. 线上现状 -------------------------------------------------------------------
def test_按线上现状_没配映射_第一轮什么都不变(db_session, fr, ak, erp):
    _ak_sync(db_session)
    report = _fr_sync(db_session)
    assert _dept(report).lines() == ["部门 → 分组：没有要改的"], "测试档案一份都对不上 ERP 的号，也就没什么好提的"
    assert not report.has_errors() and db_session.query(FrappeEmployee).count() == 0
    assert ("GET", "/api/resource/Employee") in fr.calls and ("GET", "/api/resource/Department") in fr.calls
    assert _ak_sync(db_session).lines() == ["统一登录同步：没有要改的", "能进哪些系统：没有要改的"]


# --- 2. 每一处都算 ------------------------------------------------------------------
def test_档案关联了ERP的号_部门和上级部门配了分组_每一处都算(db_session, fr, ak, erp, admin_client):
    zhuguan, lisi = erp["zhuguan"], erp["lisi"]
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员", "工作台管理员"], "销售 - 泛亚": ["销售"]})
    db_session.add(PlatformAccessMap(group_id=_group(db_session, "销售").id, system="rundeck"))
    db_session.commit()
    fr.add_department("华东销售 - 泛亚", "销售 - 泛亚")
    fr.add_department("杭州门店 - 泛亚", "华东销售 - 泛亚")
    _accounts(db_session)
    _link(fr, "HR-EMP-00003", zhuguan)                                   # 王主管在管理部
    _link(fr, "HR-EMP-00002", lisi, department="杭州门店 - 泛亚")           # 李四在销售部下面两级

    report = _fr_sync(db_session)
    assert _dept(report).actions == [
        "lisi（李四）：进「销售」（部门 （无）→杭州门店 - 泛亚）",
        "zhuguan（王主管）：进「ERP管理员」「工作台管理员」（部门 （无）→管理部 - 泛亚）",
    ]
    assert _dept(report).counts == {"按部门进组": 3, "按部门出组": 0}
    # Frappe 角色：同一轮就按刚读到的部门给
    assert fr.roles_of(_email(zhuguan)) == ["LMS Student", "Sales Manager", "Sales User"]
    assert fr.roles_of(_email(lisi)) == ["LMS Student", "Sales User"]
    assert _rows(db_session) == {"HR-EMP-00002": (lisi.id, "杭州门店 - 泛亚", "Active"),
                                 "HR-EMP-00003": (zhuguan.id, "管理部 - 泛亚", "Active")}

    # 统一登录：组员、能进哪些系统、登录时发的组
    ak_report = _ak_sync(db_session)
    assert {"进组 zhuguan →「ERP管理员」", "进组 zhuguan →「工作台管理员」", "进组 lisi →「销售」"} <= set(ak_report.actions)
    assert ak.member_names("zhuguan") == ["ERP管理员", "仓管", "工作台管理员"]
    assert ak.member_names("lisi") == ["采购", "销售"]
    assert ak.can_enter("paperless-sso", "zhuguan") and not ak.can_enter("rundeck", "zhuguan")
    assert ak.can_enter("rundeck", "lisi") and not ak.can_enter("paperless-sso", "lisi")
    assert oidc_provider.profile_claims(db_session, zhuguan)["groups"] == ["ERP管理员", "仓管", "工作台管理员"]
    assert oidc_provider.profile_claims(db_session, lisi)["groups"] == ["采购", "销售"]

    # 后台员工列表：进的组带来源，Frappe 部门带档案
    rows = {r["username"]: r for r in admin_client.get("/api/sso/staff", headers=_auth(erp["admin"])).json()}
    z = rows["zhuguan"]
    assert z["groups"] == ["ERP管理员", "仓管", "工作台管理员"]
    assert z["group_sources"] == {
        "ERP管理员": [{"kind": "department", "detail": "管理部 - 泛亚"}],
        "仓管": [{"kind": "role", "detail": "WAREHOUSE"}],
        "工作台管理员": [{"kind": "department", "detail": "管理部 - 泛亚"}],
    }
    assert "paperless" in z["systems"] and "Sales Manager" in z["frappe_roles"]
    [emp] = rows["lisi"]["frappe_employees"]
    assert emp["employee"] == "HR-EMP-00002" and emp["status"] == "Active"
    assert emp["path"] == ["杭州门店 - 泛亚", "华东销售 - 泛亚", "销售 - 泛亚", ROOT_DEPARTMENT]
    assert rows["lisi"]["group_sources"]["销售"] == [{"kind": "department", "detail": "销售 - 泛亚"}], "配在上级部门上的"
    assert rows["zhangsan"]["frappe_employees"] == [] and rows["zhangsan"]["group_sources"]["销售"][0]["kind"] == "role"

    # 两边再各跑一遍什么都不做
    assert _dept(_fr_sync(db_session)).actions == [] and _ak_sync(db_session).actions == []


# --- 3. 不算的档案 ------------------------------------------------------------------
def test_没关联号_关联别的号_对不上_不在职的档案_都不算(db_session, fr, ak, erp):
    zhuguan, lisi, zhangsan = erp["zhuguan"], erp["lisi"], erp["zhangsan"]
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员"], "销售 - 泛亚": ["工作台老板"]})
    _accounts(db_session)
    # 王主管的档案（管理部）没关联号；张三的档案（销售部）关联的是他原来的号，不是 ERP 的号
    fr.add_employee("HR-EMP-00020", "错号", department="管理部 - 泛亚", user_id="7ac64a9a7b@example.invalid")
    fr.add_employee("HR-EMP-00021", "王主管", department="管理部 - 泛亚", user_id=_email(zhuguan), status="Left")
    fr.add_employee("HR-EMP-00022", "李四", department="管理部 - 泛亚", user_id=_email(lisi), status="Suspended")
    fr.add_employee("HR-EMP-00023", "张三", department="管理部 - 泛亚", user_id=_email(zhangsan), status="Inactive")
    report = _fr_sync(db_session)
    dept = _dept(report)
    assert dept.actions == [] and dept.conflicts == [] and dept.errors == []
    assert dept.notes == [
        "员工档案 HR-EMP-00020（错号）的 User ID 7ac64a9a7b@example.invalid 对不上 ERP 员工，部门不算",
        "这些在职员工档案在配了分组的部门里，User ID 却不是 ERP 的号，部门不算："
        "张三（HR-EMP-00001，961000e173@example.invalid）、王主管（HR-EMP-00003，User ID 没填）",
    ]
    assert _rows(db_session) == {"HR-EMP-00021": (zhuguan.id, "管理部 - 泛亚", "Left"),
                                 "HR-EMP-00022": (lisi.id, "管理部 - 泛亚", "Suspended"),
                                 "HR-EMP-00023": (zhangsan.id, "管理部 - 泛亚", "Inactive")}, "存着，后台看得出为什么不算"
    _ak_sync(db_session)
    assert ak.member_names("zhuguan") == ["仓管"] and ak.member_names("lisi") == ["采购"]
    assert ak.member_names("zhangsan") == ["销售"]
    assert "Sales Manager" not in fr.roles_of(_email(zhuguan))


# --- 4. 换部门 / 只动按部门进的 ----------------------------------------------------------
def test_换部门_组跟着挪_Frappe角色同一轮就换(db_session, fr, ak, erp):
    zhuguan = erp["zhuguan"]
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员"], "技术部 - 泛亚": ["工作台管理员"]})
    _accounts(db_session)
    _link(fr, "HR-EMP-00003", zhuguan)
    _fr_sync(db_session)
    _ak_sync(db_session)
    assert ak.member_names("zhuguan") == ["ERP管理员", "仓管"]

    fr.employee_docs["HR-EMP-00003"]["department"] = "技术部 - 泛亚"
    report = _fr_sync(db_session)
    assert _dept(report).actions == ["zhuguan（王主管）：进「工作台管理员」，出「ERP管理员」（部门 管理部 - 泛亚→技术部 - 泛亚）"]
    assert "改号 zhuguan（王主管）：去 Sales Manager、Sales User" in report.actions
    ak_report = _ak_sync(db_session)
    assert {"进组 zhuguan →「工作台管理员」", "出组 zhuguan ←「ERP管理员」"} <= set(ak_report.actions)
    assert ak.member_names("zhuguan") == ["仓管", "工作台管理员"]
    assert not ak.can_enter("paperless-sso", "zhuguan")

    fr.employee_docs["HR-EMP-00003"]["status"] = "Left"
    assert _dept(_fr_sync(db_session)).actions == ["zhuguan（王主管）：出「工作台管理员」（员工档案改成了 Left）"]
    _ak_sync(db_session)
    assert ak.member_names("zhuguan") == ["仓管"]


def test_部门树改了上级_下级的人跟着挪(db_session, fr, ak, erp):
    zhuguan = erp["zhuguan"]
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员"]})
    fr.add_department("行政组 - 泛亚", "管理部 - 泛亚")
    _accounts(db_session)
    _link(fr, "HR-EMP-00003", zhuguan, department="行政组 - 泛亚")
    _fr_sync(db_session)
    assert [g.name for g in platform_groups.membership(db_session).of(zhuguan)] == ["ERP管理员", "仓管"]
    fr.departments["行政组 - 泛亚"]["parent_department"] = "技术部 - 泛亚"   # HR 把行政组挪到技术部下面
    assert _dept(_fr_sync(db_session)).actions == ["zhuguan（王主管）：出「ERP管理员」（行政组 - 泛亚 的上级部门变了）"]


def test_按角色进的_手工挂的_不受部门影响(db_session, fr, ak, erp):
    zhangsan = erp["zhangsan"]
    boss = _group(db_session, "工作台老板")
    db_session.add(PlatformGroupMember(group_id=boss.id, staff_id=zhangsan.id))
    db_session.commit()
    _map(db_session, {"销售 - 泛亚": ["销售"], "管理部 - 泛亚": ["ERP管理员", "工作台老板"]})
    _accounts(db_session)
    fr.add_employee("HR-EMP-00030", "张三", department="销售 - 泛亚", user_id=_email(zhangsan))
    report = _fr_sync(db_session)
    assert _dept(report).actions == [], "本来就按角色在「销售」，按部门再算一遍也不算进组"
    m = platform_groups.membership(db_session)
    assert m.sources(zhangsan, _group(db_session, "销售")) == [("role", "SALES"), ("department", "销售 - 泛亚")]
    assert m.sources(zhangsan, boss) == [("manual", None)]

    fr.employee_docs["HR-EMP-00030"]["department"] = "管理部 - 泛亚"
    _fr_sync(db_session)
    _ak_sync(db_session)
    assert ak.member_names("zhangsan") == ["ERP管理员", "工作台老板", "销售"]

    fr.employee_docs["HR-EMP-00030"]["department"] = None   # HR 把部门清空了
    assert _dept(_fr_sync(db_session)).actions == ["zhangsan（张三）：出「ERP管理员」（部门 管理部 - 泛亚→（无））"]
    _ak_sync(db_session)
    assert ak.member_names("zhangsan") == ["工作台老板", "销售"], "手工挂的、按角色进的照旧"
    assert db_session.query(PlatformGroupMember).count() == 1, "手工挂人的表不碰"


# --- 5. 读不到 ------------------------------------------------------------------------
@pytest.mark.parametrize("doctype", ["Employee", "Department"])
def test_读不到档案或部门_照上一轮的算_谁也不出组(db_session, fr, ak, erp, doctype):
    zhuguan = erp["zhuguan"]
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员"]})
    _accounts(db_session)
    _link(fr, "HR-EMP-00003", zhuguan)
    _fr_sync(db_session)
    _ak_sync(db_session)
    cached = _rows(db_session)
    fr.employee_docs["HR-EMP-00003"]["department"] = "技术部 - 泛亚"   # HR 改了，这一轮却读不到
    fr.fail[("GET", doctype)] = 403
    writes = len(fr.writes())

    report = _fr_sync(db_session)
    dept = _dept(report)
    assert dept.lines()[0] == "部门 → 分组：没读到"
    assert "读 Frappe 的员工档案、部门失败" in dept.errors[0] and "照上一轮读到的算" in dept.errors[0]
    assert report.has_errors() and report.errors == [], "Frappe 别的照做，只是这一段报失败"
    assert _rows(db_session) == cached and len(fr.writes()) == writes
    assert "Sales Manager" in fr.roles_of(_email(zhuguan)), "没因为读不到就撤角色"
    assert _ak_sync(db_session).actions == [] and ak.member_names("zhuguan") == ["ERP管理员", "仓管"]

    del fr.fail[("GET", doctype)]
    assert _dept(_fr_sync(db_session)).actions == [
        "zhuguan（王主管）：出「ERP管理员」（部门 管理部 - 泛亚→技术部 - 泛亚）"]


def test_定时器_读不到档案退出码1(db_session, fr, erp, monkeypatch):
    from scripts import run_frappe_sync

    monkeypatch.setattr(run_frappe_sync, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(sys, "argv", ["run_frappe_sync"])
    assert run_frappe_sync.main() == 0
    fr.fail[("GET", "Employee")] = 500
    assert run_frappe_sync.main() == 1


# --- 6. 预演 ------------------------------------------------------------------------
def test_预演什么都不写(db_session, fr, ak, erp):
    zhuguan = erp["zhuguan"]
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员"]})
    _accounts(db_session)
    _link(fr, "HR-EMP-00003", zhuguan)
    fr_before, ak_before = fr.snapshot(), ak.snapshot()
    fr_writes, ak_writes = len(fr.writes()), len(ak.writes())

    report = _fr_sync(db_session, dry_run=True)
    dept = _dept(report)
    assert dept.lines() == ["部门 → 分组预演（只看不改）：按部门进组 1",
                            "  zhuguan（王主管）：进「ERP管理员」（部门 （无）→管理部 - 泛亚）"]
    assert "改号 zhuguan（王主管）：加 Sales Manager、Sales User" in report.actions, "预演里给角色也按这一轮读到的部门算"
    assert db_session.query(FrappeEmployee).count() == 0
    assert _ak_sync(db_session, dry_run=True).actions == [], "存下来之前，统一登录同步还按上一轮的算"
    assert fr.snapshot() == fr_before and len(fr.writes()) == fr_writes
    assert ak.snapshot() == ak_before and len(ak.writes()) == ak_writes


# --- 7. 不在职的人 ---------------------------------------------------------------------
def test_停用删除的员工和设备账号_档案关联着也一个组都没有(db_session, fr, ak, erp):
    wangwu, crawler = erp["wangwu"], erp["crawler"]
    gone = _staff(db_session, "gone", StaffRole.FINANCE, name="走了的")
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员"]})
    _accounts(db_session)
    gone.deleted_at, gone.status = datetime.utcnow(), StaffStatus.DISABLED
    db_session.commit()
    for i, staff in enumerate((wangwu, crawler, gone)):
        fr.add_employee(f"HR-EMP-0006{i}", staff.name, department="管理部 - 泛亚", user_id=_email(staff))
    report = _fr_sync(db_session)
    assert _dept(report).actions == [] and len(_rows(db_session)) == 3
    _ak_sync(db_session)
    m = platform_groups.membership(db_session)
    role_map = frappe_sync.load_role_map(db_session)
    access_map = authentik_access.load_access_map(db_session)
    for staff in (wangwu, crawler, gone):
        assert m.of(staff) == [] and platform_groups.groups_for_staff(db_session, staff, confirmed_only=False) == []
        assert frappe_sync.roles_for(staff, m, role_map) == set()
        assert authentik_access.systems_for(staff, m, access_map) == []
    assert ak.member_names("admin") == ["ERP管理员"] and ak.user("wangwu") is None
    assert ak.group("ERP管理员")["users"] == {ak.user("admin")["pk"]}

    wangwu.status = StaffStatus.ACTIVE   # 恢复了：按部门进的组跟着回来
    db_session.commit()
    _ak_sync(db_session)
    assert ak.member_names("wangwu") == ["ERP管理员", "销售"]


# --- 8. 少见的情况 ---------------------------------------------------------------------
def test_两份在职档案关联同一个人_部门都算_提一句(db_session, fr, erp):
    zhuguan = erp["zhuguan"]
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员"], "技术部 - 泛亚": ["工作台管理员"]})
    _link(fr, "HR-EMP-00003", zhuguan)
    fr.add_employee("HR-EMP-00040", "王主管", department="技术部 - 泛亚", user_id=_email(zhuguan))
    report = _fr_sync(db_session)
    assert _dept(report).notes == ["zhuguan（王主管）关联了 2 份在职员工档案（HR-EMP-00003、HR-EMP-00040），"
                                   "几份的部门都算；Frappe 本来不许这样，留一份就好"]
    assert platform_groups.groups_for_staff(db_session, zhuguan, confirmed_only=False) == [
        "ERP管理员", "仓管", "工作台管理员"]


def test_映射里的部门Frappe里没有_报冲突(db_session, fr, erp):
    _map(db_session, {"旧部门 - 泛亚": ["销售"], "销售 - 泛亚": ["销售"]})
    report = _fr_sync(db_session, dry_run=True)
    assert _dept(report).conflicts == [
        "映射里的部门「旧部门 - 泛亚」Frappe 里没有（改了名或者删了？），没人按它进组：在「部门 → 分组」卡片上改"]
    assert not report.has_errors()


def test_档案上的部门不在部门列表里_只按它自己算(db_session, fr, erp):
    zhuguan = erp["zhuguan"]
    _map(db_session, {"幽灵部门": ["销售"], ROOT_DEPARTMENT: ["工作台老板"]})
    _link(fr, "HR-EMP-00003", zhuguan, department="幽灵部门")
    report = _fr_sync(db_session)
    assert "员工档案 HR-EMP-00003（王主管）的部门「幽灵部门」不在 Frappe 的部门列表里，上级部门算不出来，只按它自己算" \
        in _dept(report).notes
    assert platform_groups.groups_for_staff(db_session, zhuguan, confirmed_only=False) == ["仓管", "销售"], \
        "配在根上的「工作台老板」算不到他"


def test_配在根上_有部门的人都算(db_session, fr, erp):
    _map(db_session, {ROOT_DEPARTMENT: ["工作台老板"]})
    _link(fr, "HR-EMP-00003", erp["zhuguan"])
    _link(fr, "HR-EMP-00002", erp["lisi"], department=None)   # 没填部门的不算
    _fr_sync(db_session)
    m = platform_groups.membership(db_session)
    assert [g.name for g in m.of(erp["zhuguan"])] == ["仓管", "工作台老板"]
    assert [g.name for g in m.of(erp["lisi"])] == ["采购"]


def test_部门树绕成圈也不卡死():
    tree = DepartmentTree([Department("A", "B", False), Department("B", "A", False),
                           Department("C", None, False), Department("D", "C", True)])
    assert tree.path("A") == ["A", "B"] and tree.path("D") == ["D", "C"] and tree.path("X") == ["X"]
    assert [(d.name, depth) for d, depth in tree.ordered()] == [("C", 0), ("D", 1), ("A", 0), ("B", 1)]


def test_部门没有停用字段的版本也读得了(db_session, fr, erp, admin_client):
    fr.has_disabled_field = False
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员"]})
    _link(fr, "HR-EMP-00003", erp["zhuguan"])
    report = _fr_sync(db_session)
    assert not report.has_errors() and len(_dept(report).actions) == 1
    body = admin_client.get("/api/sso/frappe/department-options", headers=_auth(erp["admin"])).json()
    assert body["problem"] is None and not any(d["disabled"] for d in body["departments"])


def test_只读需要的字段_档案里的生日证件不取(db_session, fr, erp):
    _fr_sync(db_session, dry_run=True)
    api = frappe_sync.make_api()
    try:
        rows = api.list_employees()
    finally:
        api.close()
    assert set(rows[0]) == {"name", "employee_name", "department", "user_id", "status"}


# --- 9. 后台 ------------------------------------------------------------------------
def test_后台改映射_整张覆盖_分组列表带上部门和提醒(db_session, erp, admin_client):
    headers = _auth(erp["admin"])
    assert admin_client.get("/api/sso/frappe/departments", headers=headers).json() == []
    ids = {g.name: g.id for g in db_session.query(PlatformGroup)}
    resp = admin_client.put("/api/sso/frappe/departments", headers=headers, json={"rows": [
        {"department": " 管理部 - 泛亚 ", "group_ids": [ids["工作台管理员"], ids["ERP管理员"]]},
        {"department": "管理部 - 泛亚", "group_ids": [ids["ERP管理员"]]},   # 同一个部门写了两行：合在一起
        {"department": "销售 - 泛亚", "group_ids": [ids["销售"]]},
        {"department": "采购 - 泛亚", "group_ids": []},                    # 没选组 = 不配
    ]})
    assert resp.status_code == 200, resp.text
    assert resp.json() == [
        {"department": "管理部 - 泛亚", "group_ids": [ids["ERP管理员"], ids["工作台管理员"]]},
        {"department": "销售 - 泛亚", "group_ids": [ids["销售"]]},
    ]
    assert db_session.query(FrappeDepartmentMap).count() == 3
    groups = {g["name"]: g for g in admin_client.get("/api/sso/groups", headers=headers).json()}
    assert groups["ERP管理员"]["departments"] == ["管理部 - 泛亚"] and groups["销售"]["departments"] == ["销售 - 泛亚"]
    assert {n for n, g in groups.items() if g["powerful"]} == {"ERP管理员", "工作台老板", "工作台管理员"}
    resp = admin_client.put("/api/sso/frappe/departments", headers=headers, json={"rows": []})
    assert resp.json() == [] and db_session.query(FrappeDepartmentMap).count() == 0


def test_改了名的ERP管理员组也提醒权限大(db_session, erp, admin_client):
    group = _group(db_session, "ERP管理员")
    group.name = "管理员组"
    db_session.commit()
    groups = {g["name"]: g for g in admin_client.get("/api/sso/groups", headers=_auth(erp["admin"])).json()}
    assert groups["管理员组"]["powerful"] and groups["销售"]["powerful"] is None


@pytest.mark.parametrize("department,expect", [
    ("", "不能为空"),
    ("   ", "不能为空"),
    ("部" * 141, "140"),
    ("坏\x07名", "看不见"),
])
def test_后台改映射_不收的部门名(db_session, erp, admin_client, department, expect):
    _map(db_session, {"销售 - 泛亚": ["销售"]})
    sales = _group(db_session, "销售").id
    resp = admin_client.put("/api/sso/frappe/departments", headers=_auth(erp["admin"]), json={"rows": [
        {"department": "管理部 - 泛亚", "group_ids": [sales]}, {"department": department, "group_ids": [sales]}]})
    assert resp.status_code == 400 and expect in resp.json()["detail"]
    assert [r.department for r in db_session.query(FrappeDepartmentMap)] == ["销售 - 泛亚"], "报错不留半截"


def test_后台改映射_分组不存在_只给管理员(db_session, erp, admin_client):
    resp = admin_client.put("/api/sso/frappe/departments", headers=_auth(erp["admin"]),
                            json={"rows": [{"department": "管理部 - 泛亚", "group_ids": ["no-such-group"]}]})
    assert resp.status_code == 400 and "分组不存在" in resp.json()["detail"]
    sales = _auth(erp["zhangsan"])
    assert admin_client.get("/api/sso/frappe/departments", headers=sales).status_code == 403
    assert admin_client.get("/api/sso/frappe/department-options", headers=sales).status_code == 403
    assert admin_client.post("/api/sso/frappe/departments/sync", json={"dry_run": True}, headers=sales).status_code == 403


def test_删分组连部门映射一起删(db_session, erp, admin_client):
    _map(db_session, {"管理部 - 泛亚": ["财务", "ERP管理员"]})
    finance = _group(db_session, "财务")
    assert admin_client.delete(f"/api/sso/groups/{finance.id}", headers=_auth(erp["admin"])).status_code == 204
    assert [(r.department, r.group_id) for r in db_session.query(FrappeDepartmentMap)] == [
        ("管理部 - 泛亚", _group(db_session, "ERP管理员").id)]


def test_后台能选的部门现查Frappe_按树排(db_session, fr, erp, admin_client, monkeypatch):
    headers = _auth(erp["admin"])
    fr.add_department("华东销售 - 泛亚", "销售 - 泛亚")
    fr.add_department("停掉的部门 - 泛亚", disabled=True)
    body = admin_client.get("/api/sso/frappe/department-options", headers=headers).json()
    assert body["problem"] is None
    depts = body["departments"]
    assert depts[0] == {"name": ROOT_DEPARTMENT, "parent": None, "depth": 0, "disabled": False}
    names = [d["name"] for d in depts]
    assert set(names) == {ROOT_DEPARTMENT, "华东销售 - 泛亚", "停掉的部门 - 泛亚", *LIVE_DEPARTMENTS}
    i = names.index("销售 - 泛亚")
    assert depts[i]["depth"] == 1 and depts[i + 1] == {"name": "华东销售 - 泛亚", "parent": "销售 - 泛亚",
                                                       "depth": 2, "disabled": False}
    assert [d["name"] for d in depts if d["disabled"]] == ["停掉的部门 - 泛亚"]
    monkeypatch.setattr(frappe_sync, "make_api", lambda transport_=None: frappe_sync.FrappeApi(
        "https://hr.test", KEY, SECRET, transport=httpx.MockTransport(lambda r: httpx.Response(500, text="oops"))))
    down = admin_client.get("/api/sso/frappe/department-options", headers=headers)
    assert down.status_code == 200 and down.json()["departments"] == [] and "读 Frappe 失败" in down.json()["problem"]
    monkeypatch.setattr(settings, "frappe_sync_api_key", "")
    assert "FRAPPE_SYNC_API_KEY" in admin_client.get("/api/sso/frappe/department-options",
                                                     headers=headers).json()["problem"]


def test_卡片上的同步_两个一起跑_预演按这一轮读到的部门算(db_session, fr, ak, erp, admin_client):
    zhuguan = erp["zhuguan"]
    headers = _auth(erp["admin"])
    _map(db_session, {"管理部 - 泛亚": ["ERP管理员"]})
    _accounts(db_session)
    _link(fr, "HR-EMP-00003", zhuguan)
    fr_writes, ak_writes = len(fr.writes()), len(ak.writes())

    dry = admin_client.post("/api/sso/frappe/departments/sync", json={"dry_run": True}, headers=headers)
    assert dry.status_code == 200, dry.text
    lines = dry.json()["lines"]
    assert lines[0] == "Frappe 同步预演（只看不改）：改号 1"
    assert "部门 → 分组预演（只看不改）：按部门进组 1" in lines
    assert "统一登录同步预演（只看不改）：进组 1" in lines and "  进组 zhuguan →「ERP管理员」" in lines, \
        "统一登录那一半也按这一轮刚读到的部门算"
    assert any(line.startswith("能进哪些系统预演") for line in lines)
    assert len(fr.writes()) == fr_writes and len(ak.writes()) == ak_writes
    assert db_session.query(FrappeEmployee).count() == 0

    real = admin_client.post("/api/sso/frappe/departments/sync", json={"dry_run": False}, headers=headers)
    assert real.status_code == 200, real.text
    assert ak.member_names("zhuguan") == ["ERP管理员", "仓管"] and "Sales Manager" in fr.roles_of(_email(zhuguan))
    assert db_session.query(FrappeEmployee).count() == 1
    again = admin_client.post("/api/sso/frappe/departments/sync", json={"dry_run": True}, headers=headers).json()
    assert again["lines"] == ["Frappe 同步预演（只看不改）：没有要改的", "部门 → 分组预演（只看不改）：没有要改的",
                              "统一登录同步预演（只看不改）：没有要改的", "能进哪些系统预演（只看不改）：没有要改的"]


def test_卡片上的同步_统一登录跑不了就只跑Frappe(db_session, fr, ak, erp, admin_client, monkeypatch):
    headers = _auth(erp["admin"])
    monkeypatch.setattr(settings, "authentik_api_token", "")
    body = admin_client.post("/api/sso/frappe/departments/sync", json={"dry_run": True}, headers=headers).json()
    assert body["lines"][-2:] == ["统一登录同步预演（只看不改）：没跑", "  注意：没配 AUTHENTIK_API_TOKEN"]
    monkeypatch.setattr(settings, "authentik_api_token", TOKEN)
    monkeypatch.setattr(settings, "authentik_sync_enabled", False)
    body = admin_client.post("/api/sso/frappe/departments/sync", json={"dry_run": False}, headers=headers).json()
    assert body["dry_run"] is False and "  注意：同步开关没开（AUTHENTIK_SYNC_ENABLED），只能预演" in body["lines"]
    assert ak.writes() == []
    monkeypatch.setattr(authentik_sync, "make_api", lambda transport_=None: authentik_sync.AuthentikApi(
        "https://id.test", TOKEN, transport=httpx.MockTransport(lambda r: httpx.Response(500, text="oops"))))
    monkeypatch.setattr(settings, "authentik_sync_enabled", True)
    body = admin_client.post("/api/sso/frappe/departments/sync", json={"dry_run": True}, headers=headers).json()
    assert body["lines"][-2].endswith("没跑") and "读统一登录失败" in body["lines"][-1]
    monkeypatch.setattr(settings, "frappe_sync_enabled", False)
    off = admin_client.post("/api/sso/frappe/departments/sync", json={"dry_run": False}, headers=headers)
    assert off.status_code == 400 and "FRAPPE_SYNC_ENABLED" in off.json()["detail"]


# --- 10. 迁移 / 文档 --------------------------------------------------------------------
def test_迁移082建两张表_不种映射_降级删表():
    module = _migration("082_frappe_departments")
    assert module.down_revision == "081_platform_access"
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE staff (id VARCHAR(36) PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE platform_group (id VARCHAR(36) PRIMARY KEY, name VARCHAR(80))"))
        conn.execute(text("INSERT INTO platform_group VALUES ('g-admin', 'ERP管理员')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
        insp = inspect(conn)
        assert {"frappe_department_map", "frappe_employee"} <= set(insp.get_table_names())
        assert {c["name"] for c in insp.get_columns("frappe_employee")} >= {
            "employee", "staff_id", "employee_name", "department", "department_path", "status", "synced_at"}
        assert conn.execute(text("SELECT COUNT(*) FROM frappe_department_map")).scalar() == 0, "不种映射"
        with Operations.context(MigrationContext.configure(conn)):
            module.downgrade()
        assert not {"frappe_department_map", "frappe_employee"} & set(inspect(conn).get_table_names())


def test_接入说明写了部门这一期():
    doc = (ROOT / "docs" / "统一登录接入说明.md").read_text(encoding="utf-8")
    for words in ("部门 → 分组", "frappe_department_map", "10 分钟", "HR Manager", "alembic downgrade 081_platform_access"):
        assert words in doc, words
