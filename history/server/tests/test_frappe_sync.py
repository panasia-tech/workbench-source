"""Frappe 同步：ERP 员工 → Frappe（hr.panasia.fun）开号、按平台分组给角色、停用（services/frappe_sync.py）。

Frappe 是假的（tests/fake_frappe.py）：一个按 REST 接口写的内存实现，挂在 httpx.MockTransport 上，同步走的是真的
客户端代码（token 头、报错、提示的解析），User 的行为照 Frappe 16 的源码学的。起手是 10-19 线上 HR 的样子（部门树、
三份测试档案）。按部门进组（同一轮里的另一段）见 test_frappe_departments.py。

# 这里钉死的

  1. 预演只打印不改：Frappe 一个写请求都没有，ERP 也不落任何东西；
  2. 真跑：只给统一登录开好号的在职员工建号（占位邮箱 = 员工 ID、ERP 姓名、不发欢迎邮件、按分组给角色），
     设备账号、停用的、统一登录还没开好号的不建；
  3. 幂等：跑第二遍什么都不做；
  4. 别人的号（工作台服务账号、原来的员工、API 用户自己）一律不碰；占位邮箱但不是同步建的：报冲突不碰；
  5. 给角色、撤角色：换分组、映射里删掉角色，同步加上去的撤掉；人工给的（哪怕是映射里有的角色名）不动；
     LMS Student 只补不撤；改角色前现读一遍，读完到写之间人工刚加的也不会被冲掉；
  6. 停用 / 删除 / 改成设备账号 / 不再属于给角色的分组 → enabled=0、角色不动；恢复了再启用；删除的人用户名
     腾给新人，新人另开一个号（邮箱跟着员工 ID，不跟用户名）；ERP 里找不到的同步号也停；
  7. 映射里的角色 Frappe 没有、停用了、归 Frappe 自己管：报冲突、不给、不停号、也不来回改；Frappe 自己把角色
     改回去了：报失败；
  8. 一步失败不拖累别的，下一轮补上；key 是 Administrator 的或者不认：不跑；
  9. 开关关着只能预演；后台能改映射、看能选的角色、手动触发；员工列表带上 Frappe 角色和号；
 10. 迁移 080 种的默认映射就是这期定的那几条，分组按名字找，找不到的不种。
"""

import copy
import importlib.util
from datetime import datetime
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
from app.models import AuthentikAccount, FrappeAccount, FrappeRoleMap, PlatformGroup, PlatformGroupMember, Staff
from app.routers import sso as sso_router
from app.services import authentik_sync, frappe_sync
from app.services.password import hash_password
from fake_frappe import KEY, ME, SECRET, FakeFrappe
from fake_frappe import frappe_error as _frappe_error

_PW_HASH = hash_password("pw")   # bcrypt 慢，一个模块算一次
VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"


def _migration(name):
    spec = importlib.util.spec_from_file_location(f"migration_{name}", VERSIONS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def fr(monkeypatch):
    fake = FakeFrappe()
    fake.add_user("33f6bde767@example.invalid", roles=["System Manager"], first_name="工作台")
    fake.add_user("961000e173@example.invalid", roles=["Employee", "LMS Student"], first_name="张三")   # 原来的员工
    fake.add_user(ME, roles=["System Manager"], first_name="ERP 同步")
    fake.seed_live_hr()   # 张三的员工档案关联着他原来的号
    monkeypatch.setattr(settings, "frappe_sync_url", "https://hr.test")
    monkeypatch.setattr(settings, "frappe_sync_api_key", KEY)
    monkeypatch.setattr(settings, "frappe_sync_api_secret", SECRET)
    monkeypatch.setattr(settings, "frappe_sync_enabled", True)
    transport = httpx.MockTransport(fake.handler)
    monkeypatch.setattr(frappe_sync, "make_api", lambda transport_=None: frappe_sync.FrappeApi(
        settings.frappe_sync_url, KEY, SECRET, transport=transport))
    return fake


_ak_pk = iter(range(100, 10_000))


def _staff(db, username, role=StaffRole.SALES, status=StaffStatus.ACTIVE, name=None, staff_no=None, synced=True):
    """synced=True：统一登录的号开好了（authentik_account 有这一行、用户名对得上）。"""
    s = Staff(staff_no=staff_no or f"E-{username}", username=username, name=name or username.upper(),
              password_hash=_PW_HASH, role=role, status=status)
    db.add(s)
    db.commit()
    if synced:
        db.add(AuthentikAccount(staff_id=s.id, authentik_pk=next(_ak_pk), authentik_username=username,
                                synced_at=datetime.utcnow()))
        db.commit()
    return s


def _group(db, name):
    return db.query(PlatformGroup).filter_by(name=name).one()


def _set_map(db, mapping):
    """{组名或 None: [角色]} 整张换掉。"""
    db.query(FrappeRoleMap).delete()
    for group, roles in mapping.items():
        for role in roles:
            db.add(FrappeRoleMap(group_id=_group(db, group).id if group else None, role=role))
    db.commit()


@pytest.fixture()
def erp(db_session):
    """默认分组用迁移 079 种的、默认映射用迁移 080 种的。"""
    for name, roles, description in _migration("079_platform_sso").DEFAULT_GROUPS:
        db_session.add(PlatformGroup(name=name, roles=roles, description=description))
    db_session.commit()
    for group, role in _migration("080_frappe_sync").DEFAULT_ROLE_MAP:
        db_session.add(FrappeRoleMap(group_id=_group(db_session, group).id if group else None, role=role))
    db_session.commit()
    return {
        "admin": _staff(db_session, "admin", StaffRole.ADMIN, name="管理员"),
        "zhangsan": _staff(db_session, "zhangsan", StaffRole.SALES, name="张三"),
        "lisi": _staff(db_session, "lisi", StaffRole.PURCHASER, name="李四"),
        "zhaoliu": _staff(db_session, "zhaoliu", StaffRole.SALES, name="赵六", synced=False),
        "crawler": _staff(db_session, "crawler-01", StaffRole.CRAWLER, synced=False),
        "wangwu": _staff(db_session, "wangwu", StaffRole.SALES, status=StaffStatus.DISABLED, name="王五"),
    }


def _sync(db, *, dry_run=False):
    api = frappe_sync.make_api()
    try:
        return frappe_sync.run_sync(db, api, dry_run=dry_run)
    finally:
        api.close()


def _email(staff):
    return authentik_sync.staff_email(staff.id)


def _user(fr, staff):
    return fr.users.get(_email(staff))


# --- 1. 预演 --------------------------------------------------------------------
def test_预演只打印不改(db_session, fr, erp):
    before = fr.snapshot()
    report = _sync(db_session, dry_run=True)
    assert report.counts["建号"] == 3 and report.errors == []
    assert "建号 zhangsan（张三）：LMS Student、Sales User" in report.actions
    assert "建号 admin（管理员）：LMS Student、Sales Manager、Sales User" in report.actions
    assert any("zhaoliu" in n and "统一登录的号还没开好" in n for n in report.notes)
    assert report.lines()[0].startswith("Frappe 同步预演（只看不改）")
    assert fr.writes() == [] and fr.snapshot() == before
    assert db_session.query(FrappeAccount).count() == 0


# --- 2. 真跑 / 3. 幂等 ---------------------------------------------------------------
def test_真跑一遍_建号给角色_不发欢迎邮件(db_session, fr, erp):
    report = _sync(db_session)
    assert report.errors == [] and report.conflicts == []
    want = {
        "admin": ["LMS Student", "Sales Manager", "Sales User"],
        "zhangsan": ["LMS Student", "Sales User"],
        "lisi": ["LMS Student"],
    }
    for key, roles in want.items():
        staff = erp[key]
        u = _user(fr, staff)
        assert u["name"] == f"{staff.id}@staff.panasia.fun" and u["owner"] == ME
        assert u["enabled"] == 1 and u["full_name"] == staff.name and u["username"] == staff.username
        assert fr.roles_of(u["name"]) == roles
        account = db_session.get(FrappeAccount, staff.id)
        assert account.frappe_user == u["name"] and account.enabled is True
        assert account.roles == [r for r in roles if r != "LMS Student"], "LMS Student 只补不撤，不记成同步给的"
    assert _user(fr, erp["admin"])["user_type"] == "System User"
    assert _user(fr, erp["lisi"])["user_type"] == "Website User", "只有 LMS Student 进不了后台，Frappe 自己会算"
    assert fr.welcome == []
    for key in ("zhaoliu", "crawler", "wangwu"):
        assert _user(fr, erp[key]) is None


def test_跑第二遍什么都不做(db_session, fr, erp):
    _sync(db_session)
    writes = len(fr.writes())
    report = _sync(db_session)
    assert report.actions == [] and not any(report.counts.values()) and report.errors == []
    assert len(fr.writes()) == writes
    assert report.lines()[0] == "Frappe 同步：没有要改的" and report.lines()[-1] == "部门 → 分组：没有要改的"


# --- 4. 不碰别人的 ---------------------------------------------------------------
def test_别人的号一律不碰(db_session, fr, erp):
    theirs = lambda: {n: u for n, u in fr.users.items() if not n.endswith("@staff.panasia.fun")}  # noqa: E731
    before = copy.deepcopy(theirs())
    _sync(db_session)
    _sync(db_session)
    assert theirs() == before
    touched = {p.removeprefix("/api/resource/User/") for m, p in fr.writes()}
    assert not touched & set(before)


def test_同邮箱的号不是同步建的_报冲突不碰(db_session, fr, erp):
    zhangsan = erp["zhangsan"]
    fr.add_user(_email(zhangsan), owner="Administrator", roles=["HR User"], first_name="手工建的")
    before = copy.deepcopy(_user(fr, zhangsan))
    report = _sync(db_session)
    assert any(c.startswith("zhangsan（张三）：Frappe 里已经有") and "不是同步建的" in c for c in report.conflicts)
    assert _user(fr, zhangsan) == before
    assert db_session.get(FrappeAccount, zhangsan.id) is None
    assert _user(fr, erp["lisi"]) is not None, "别人照常建"


def test_占位域名下对不上员工的别人的号_不碰(db_session, fr, erp):
    fr.add_user("931713500e@example.invalid", owner="Administrator")
    before = copy.deepcopy(fr.users["931713500e@example.invalid"])
    report = _sync(db_session)
    assert any("931713500e@example.invalid" in n and "没碰" in n for n in report.notes)
    assert fr.users["931713500e@example.invalid"] == before


# --- 5. 给角色 / 撤角色 -------------------------------------------------------------
def test_换分组_同步给的撤掉_人工给的不动(db_session, fr, erp):
    _sync(db_session)
    zhangsan = erp["zhangsan"]
    _user(fr, zhangsan)["roles"].append("HR User")   # HR 在 Frappe 里手工给的
    zhangsan.role = StaffRole.PURCHASER
    db_session.commit()
    report = _sync(db_session)
    assert "改号 zhangsan（张三）：去 Sales User" in report.actions
    assert fr.roles_of(_email(zhangsan)) == ["HR User", "LMS Student"]
    assert db_session.get(FrappeAccount, zhangsan.id).roles == []
    zhangsan.role = StaffRole.SALES
    db_session.commit()
    _sync(db_session)
    assert fr.roles_of(_email(zhangsan)) == ["HR User", "LMS Student", "Sales User"]


def test_人工给的映射角色也不撤(db_session, fr, erp):
    """CRM 里经理拉个采购进来、HR 手工给了 Sales User：不是同步加的，同步不撤。"""
    _sync(db_session)
    lisi = erp["lisi"]
    _user(fr, lisi)["roles"].append("Sales User")
    report = _sync(db_session)
    assert report.actions == []
    assert "Sales User" in fr.roles_of(_email(lisi))


def test_映射里删掉的角色_从同步给过的人身上撤掉(db_session, fr, erp):
    _sync(db_session)
    lisi = erp["lisi"]
    _user(fr, lisi)["roles"].append("Sales Manager")   # 人工给的
    _set_map(db_session, {None: ["LMS Student"], "ERP管理员": ["Sales Manager"]})
    report = _sync(db_session)
    assert "改号 zhangsan（张三）：去 Sales User" in report.actions
    assert "改号 admin（管理员）：去 Sales User" in report.actions
    assert fr.roles_of(_email(erp["zhangsan"])) == ["LMS Student"]
    assert fr.roles_of(_email(erp["admin"])) == ["LMS Student", "Sales Manager"]
    assert "Sales Manager" in fr.roles_of(_email(lisi)), "不是同步给的，不撤"


def test_删掉分组_它映射的角色一起删_下一轮撤掉(db_session, fr, erp, admin_client):
    _sync(db_session)
    sales = _group(db_session, "销售")
    assert admin_client.delete(f"/api/sso/groups/{sales.id}", headers=_auth(erp["admin"])).status_code == 204
    assert db_session.query(FrappeRoleMap).filter_by(group_id=sales.id).count() == 0
    _sync(db_session)
    assert fr.roles_of(_email(erp["zhangsan"])) == ["LMS Student"]


def test_LMS_Student只补不撤(db_session, fr, erp):
    _sync(db_session)
    _set_map(db_session, {"销售": ["Sales User", "LMS Student"], "ERP管理员": ["Sales Manager", "Sales User"],
                          "采购": ["Course Creator"]})
    report = _sync(db_session)
    assert not any("LMS Student" in a for a in report.actions), "Learning 自己给的学员身份，映射里只剩销售有也不撤别人的"
    assert "LMS Student" in fr.roles_of(_email(erp["lisi"])) and "LMS Student" in fr.roles_of(_email(erp["admin"]))
    zhangsan = _user(fr, erp["zhangsan"])
    zhangsan["roles"].remove("LMS Student")
    report = _sync(db_session)
    assert "改号 zhangsan（张三）：加 LMS Student" in report.actions


def test_改角色前现读一遍_人工刚加的不会被冲掉(db_session, fr, erp):
    _sync(db_session)
    zhangsan = erp["zhangsan"]
    zhangsan.role = StaffRole.PURCHASER
    db_session.commit()
    seen = []

    def someone_adds_role(u):   # 第一次是算差异时读的，第二次是写之前现读的
        seen.append(1)
        if len(seen) == 2:
            u["roles"].append("HR User")

    fr.on_get[_email(zhangsan)] = someone_adds_role
    report = _sync(db_session)
    assert report.errors == [] and len(seen) == 2
    assert fr.roles_of(_email(zhangsan)) == ["HR User", "LMS Student"]


# --- 6. 停用 / 删除 ----------------------------------------------------------------
def test_停用了Frappe跟着停_角色不动_恢复了再启用(db_session, fr, erp):
    _sync(db_session)
    zhangsan = erp["zhangsan"]
    zhangsan.status = StaffStatus.DISABLED
    db_session.commit()
    report = _sync(db_session)
    assert "停号 zhangsan（张三）：ERP 里停用了" in report.actions
    u = _user(fr, zhangsan)
    assert u["enabled"] == 0 and fr.roles_of(u["name"]) == ["LMS Student", "Sales User"]
    assert db_session.get(FrappeAccount, zhangsan.id).enabled is False
    u["enabled"] = 1   # HR 存了一下员工档案，Frappe 自己把号又启用了
    assert "停号 zhangsan（张三）：ERP 里停用了" in _sync(db_session).actions
    zhangsan.status = StaffStatus.ACTIVE
    db_session.commit()
    assert "改号 zhangsan（张三）：启用" in _sync(db_session).actions
    assert _user(fr, zhangsan)["enabled"] == 1


def test_停用期间换了分组_恢复时角色按那时对(db_session, fr, erp):
    _sync(db_session)
    zhangsan = erp["zhangsan"]
    zhangsan.status = StaffStatus.DISABLED
    db_session.commit()
    _sync(db_session)
    zhangsan.status, zhangsan.role = StaffStatus.ACTIVE, StaffRole.PURCHASER
    db_session.commit()
    assert "改号 zhangsan（张三）：启用；去 Sales User" in _sync(db_session).actions


def test_改成设备账号也停(db_session, fr, erp):
    _sync(db_session)
    erp["lisi"].role = StaffRole.CRAWLER
    db_session.commit()
    assert "停号 lisi（李四）：改成了设备账号" in _sync(db_session).actions
    assert _user(fr, erp["lisi"])["enabled"] == 0


def test_不再属于给角色的分组也停(db_session, fr, erp):
    _sync(db_session)
    _set_map(db_session, {"ERP管理员": ["Sales Manager"]})
    report = _sync(db_session)
    assert "停号 lisi（李四）：不再属于给 Frappe 角色的分组" in report.actions
    assert "停号 zhangsan（张三）：不再属于给 Frappe 角色的分组" in report.actions
    assert _user(fr, erp["admin"])["enabled"] == 1


def test_删除的人停号_用户名腾给同名新人_新人另开一个号(db_session, fr, erp):
    """照 routers/staff.py 的软删：停用 + 用户名改写成 xxx__del_xxxxxxxx。新人再用这个用户名。"""
    _sync(db_session)
    old = erp["lisi"]
    old_email = _email(old)
    old.deleted_at = datetime.utcnow()
    old.status = StaffStatus.DISABLED
    old.username = f"lisi__del_{old.id[:8]}"
    db_session.commit()
    new = _staff(db_session, "lisi", StaffRole.SALES, name="新李四", staff_no="E-lisi-2")
    report = _sync(db_session)
    assert report.errors == [] and report.conflicts == []
    assert f"停号 {old.username}（李四）：ERP 里删了" in report.actions
    assert fr.users[old_email]["enabled"] == 0 and fr.users[old_email]["full_name"] == "李四"
    fresh = _user(fr, new)
    assert fresh["name"] != old_email and fresh["enabled"] == 1 and fresh["full_name"] == "新李四"
    assert fr.roles_of(fresh["name"]) == ["LMS Student", "Sales User"]
    assert fresh["username"] != "lisi", "旧号占着用户名，Frappe 另起了一个"
    assert any("Frappe 对 lisi（新李四） 的提示：Username lisi already exists" == n for n in report.notes)
    assert db_session.get(FrappeAccount, new.id).frappe_user == fresh["name"]


def test_ERP里找不到的同步号_停用(db_session, fr, erp):
    _sync(db_session)
    ghost = fr.add_user("7ac64a9a7b@example.invalid", owner=ME, roles=["Sales User"])
    report = _sync(db_session)
    assert "停号 7ac64a9a7b@example.invalid：ERP 里找不到这个员工" in report.actions
    assert fr.users[ghost["name"]]["enabled"] == 0 and fr.users[ghost["name"]]["roles"] == ["Sales User"]


# --- 7. 映射里的角色有问题 ------------------------------------------------------------
def test_映射里的角色Frappe没有或停用了_报冲突不给_也不停号(db_session, fr, erp):
    _set_map(db_session, {None: ["LMS Student"], "销售": ["Sales Usr", "Old Role"]})
    report = _sync(db_session)
    assert any("「Sales Usr」Frappe 里没有这个角色" in c for c in report.conflicts)
    assert any("「Old Role」在 Frappe 里停用了" in c for c in report.conflicts)
    assert report.errors == []
    assert fr.roles_of(_email(erp["zhangsan"])) == ["LMS Student"]
    _sync(db_session)
    _set_map(db_session, {"销售": ["Sales Usr"]})
    report = _sync(db_session)
    assert not any(a.startswith("停号 zhangsan") for a in report.actions), "写错角色名不该把人停掉"


def test_Frappe自己管的角色进了映射_不给也不来回改(db_session, fr, erp):
    """后台接口挡着配不进去；万一库里有了（手工改库），同步也不碰。"""
    _set_map(db_session, {None: ["LMS Student", "Employee"], "销售": ["Sales User"]})
    report = _sync(db_session)
    assert any("「Employee」同步不管" in c for c in report.conflicts)
    assert report.errors == [] and "Employee" not in fr.roles_of(_email(erp["zhangsan"]))
    writes = len(fr.writes())
    assert _sync(db_session).actions == [] and len(fr.writes()) == writes


def test_Frappe自己把角色改回去了_报失败(db_session, fr, erp):
    fr.strip.add("Sales User")
    report = _sync(db_session)
    assert any(e.startswith("建号 zhangsan（张三）") and "Frappe 保存后没有 Sales User" in e for e in report.errors)
    zhangsan = erp["zhangsan"]
    assert _user(fr, zhangsan) is not None
    assert db_session.get(FrappeAccount, zhangsan.id).roles == [], "按 Frappe 实际有的记"


# --- 8. 失败 / 配置不对 --------------------------------------------------------------
def test_一步失败不拖累别的_下一轮补上(db_session, fr, erp):
    zhangsan = erp["zhangsan"]
    fr.fail[("POST", _email(zhangsan))] = 500
    report = _sync(db_session)
    assert any(e.startswith("建号 zhangsan（张三）") and "500" in e for e in report.errors)
    assert _user(fr, zhangsan) is None and _user(fr, erp["lisi"]) is not None
    assert db_session.get(FrappeAccount, zhangsan.id) is None
    del fr.fail[("POST", _email(zhangsan))]
    assert _sync(db_session).errors == []
    assert fr.roles_of(_email(zhangsan)) == ["LMS Student", "Sales User"]


def test_改号失败_上一轮的记录原样留着(db_session, fr, erp):
    _sync(db_session)
    zhangsan = erp["zhangsan"]
    zhangsan.role = StaffRole.PURCHASER
    db_session.commit()
    fr.fail[("PUT", _email(zhangsan))] = 417
    report = _sync(db_session)
    assert any("boom" in e for e in report.errors)
    assert db_session.get(FrappeAccount, zhangsan.id).roles == ["Sales User"], "下一轮还知道 Sales User 归同步撤"
    del fr.fail[("PUT", _email(zhangsan))]
    _sync(db_session)
    assert fr.roles_of(_email(zhangsan)) == ["LMS Student"]


def test_key是Administrator的或者不认_不跑(db_session, fr, erp):
    fr.me = "Administrator"
    with pytest.raises(frappe_sync.FrappeRefused, match="Administrator"):
        _sync(db_session, dry_run=True)
    fr.me = "Guest"
    with pytest.raises(frappe_sync.FrappeRefused, match="不认这把 key"):
        _sync(db_session, dry_run=True)
    assert fr.writes() == []


def test_读不到Frappe直接报错(db_session, fr, erp):
    api = frappe_sync.FrappeApi("https://hr.test", KEY, SECRET, transport=httpx.MockTransport(
        lambda request: _frappe_error(403, "PermissionError", "Not permitted")))
    with pytest.raises(frappe_sync.FrappeError, match="403.*PermissionError"):
        frappe_sync.run_sync(db_session, api, dry_run=True)


# --- 9. 开关 / 后台 -----------------------------------------------------------------
def test_开关关着只能预演_没key跑不了(fr, monkeypatch):
    monkeypatch.setattr(settings, "frappe_sync_enabled", False)
    assert frappe_sync.why_not(dry_run=True) is None
    assert "FRAPPE_SYNC_ENABLED" in frappe_sync.why_not(dry_run=False)
    monkeypatch.setattr(settings, "frappe_sync_api_secret", "")
    assert "FRAPPE_SYNC_API_SECRET" in frappe_sync.why_not(dry_run=True)
    monkeypatch.setattr(settings, "frappe_sync_api_secret", SECRET)
    monkeypatch.setattr(settings, "frappe_sync_url", "http://127.0.0.1:8000")
    assert "https" in frappe_sync.why_not(dry_run=True)
    monkeypatch.setattr(settings, "frappe_sync_url", "http://127.0.0.1:8000")
    assert frappe_sync.why_not(dry_run=True) is None


def test_Frappe同步用另一把锁():
    executed = []

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            pass

        def execute(self, stmt, params=None):
            executed.append((str(stmt), params))
            return SimpleNamespace(scalar=lambda: 1)

    engine = SimpleNamespace(dialect=SimpleNamespace(name="mysql"), connect=lambda: Conn())
    with frappe_sync.sync_lock(SimpleNamespace(get_bind=lambda: engine)) as got:
        assert got
    assert executed == [("SELECT GET_LOCK(:n, 0)", {"n": "frappe_sync"}),
                        ("SELECT RELEASE_LOCK(:n)", {"n": "frappe_sync"})]


@pytest.fixture()
def admin_client(db_session):
    app = FastAPI()
    app.include_router(sso_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(app)


def _auth(staff):
    return {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


def test_后台手动触发(db_session, fr, erp, admin_client, monkeypatch):
    admin = erp["admin"]
    dry = admin_client.post("/api/sso/frappe/sync", json={"dry_run": True}, headers=_auth(admin))
    assert dry.status_code == 200 and dry.json()["dry_run"] is True and dry.json()["counts"]["建号"] == 3
    assert fr.writes() == []
    real = admin_client.post("/api/sso/frappe/sync", json={"dry_run": False}, headers=_auth(admin))
    assert real.status_code == 200 and _user(fr, erp["zhangsan"])
    fr.me = "Administrator"
    refused = admin_client.post("/api/sso/frappe/sync", json={"dry_run": True}, headers=_auth(admin))
    assert refused.status_code == 400 and "Administrator" in refused.json()["detail"]
    monkeypatch.setattr(settings, "frappe_sync_enabled", False)
    off = admin_client.post("/api/sso/frappe/sync", json={"dry_run": False}, headers=_auth(admin))
    assert off.status_code == 400 and "FRAPPE_SYNC_ENABLED" in off.json()["detail"]
    sales = admin_client.post("/api/sso/frappe/sync", json={"dry_run": True}, headers=_auth(erp["zhangsan"]))
    assert sales.status_code == 403


def test_后台读不到Frappe回502(db_session, fr, erp, admin_client, monkeypatch):
    monkeypatch.setattr(frappe_sync, "make_api", lambda transport_=None: frappe_sync.FrappeApi(
        "https://hr.test", KEY, SECRET,
        transport=httpx.MockTransport(lambda r: httpx.Response(502, text="bad gateway"))))
    resp = admin_client.post("/api/sso/frappe/sync", json={"dry_run": True}, headers=_auth(erp["admin"]))
    assert resp.status_code == 502 and "502" in resp.json()["detail"]


def test_后台改映射_整张覆盖(db_session, erp, admin_client):
    headers = _auth(erp["admin"])
    rows = admin_client.get("/api/sso/frappe/roles", headers=headers).json()
    assert rows[0] == {"group_id": None, "group_name": None, "roles": ["LMS Student"]}
    by_name = {r["group_name"]: r for r in rows[1:]}
    assert len(by_name) == 8 and by_name["销售"]["roles"] == ["Sales User"]
    assert by_name["ERP管理员"]["roles"] == ["Sales Manager", "Sales User"] and by_name["财务"]["roles"] == []
    finance = by_name["财务"]["group_id"]
    resp = admin_client.put("/api/sso/frappe/roles", headers=headers, json={"rows": [
        {"group_id": None, "roles": [" LMS Student ", "LMS Student"]},
        {"group_id": finance, "roles": ["Accounts User"]},
    ]})
    assert resp.status_code == 200, resp.text
    after = {r["group_name"]: r["roles"] for r in resp.json()}
    assert after[None] == ["LMS Student"] and after["财务"] == ["Accounts User"] and after["销售"] == []
    assert db_session.query(FrappeRoleMap).count() == 2


@pytest.mark.parametrize("role,expect", [
    ("Employee", "员工档案"),
    ("Leave Approver", "审批人"),
    ("Administrator", "Administrator"),
    ("", "不能为空"),
    ("x" * 141, "140"),
    ("坏\x07名", "看不见"),
])
def test_后台改映射_不收的角色(db_session, erp, admin_client, role, expect):
    before = db_session.query(FrappeRoleMap).count()
    resp = admin_client.put("/api/sso/frappe/roles", headers=_auth(erp["admin"]),
                            json={"rows": [{"group_id": None, "roles": ["LMS Student", role]}]})
    assert resp.status_code == 400 and expect in resp.json()["detail"]
    assert db_session.query(FrappeRoleMap).count() == before, "报错不留半截"


def test_后台改映射_分组不存在(db_session, erp, admin_client):
    resp = admin_client.put("/api/sso/frappe/roles", headers=_auth(erp["admin"]),
                            json={"rows": [{"group_id": "no-such-group", "roles": ["Sales User"]}]})
    assert resp.status_code == 400 and "分组不存在" in resp.json()["detail"]
    sales = admin_client.get("/api/sso/frappe/roles", headers=_auth(erp["zhangsan"]))
    assert sales.status_code == 403


def test_后台能选的角色现查Frappe(db_session, fr, erp, admin_client, monkeypatch):
    headers = _auth(erp["admin"])
    body = admin_client.get("/api/sso/frappe/role-options", headers=headers).json()
    assert body["problem"] is None
    assert {"LMS Student", "Sales User", "Sales Manager", "HR User", "System Manager"} <= set(body["roles"])
    assert not {"Old Role", "Employee", "Leave Approver", "Guest", "All", "Administrator"} & set(body["roles"])
    monkeypatch.setattr(frappe_sync, "make_api", lambda transport_=None: frappe_sync.FrappeApi(
        "https://hr.test", KEY, SECRET, transport=httpx.MockTransport(lambda r: httpx.Response(500, text="oops"))))
    down = admin_client.get("/api/sso/frappe/role-options", headers=headers)
    assert down.status_code == 200 and down.json()["roles"] == [] and "读 Frappe 失败" in down.json()["problem"]
    monkeypatch.setattr(settings, "frappe_sync_api_key", "")
    assert "FRAPPE_SYNC_API_KEY" in admin_client.get("/api/sso/frappe/role-options", headers=headers).json()["problem"]


def test_员工列表带上Frappe角色和号_状态里有Frappe(db_session, fr, erp, admin_client):
    _sync(db_session)
    headers = _auth(erp["admin"])
    rows = {r["username"]: r for r in admin_client.get("/api/sso/staff", headers=headers).json()}
    assert rows["zhangsan"]["frappe_roles"] == ["LMS Student", "Sales User"]
    assert rows["zhangsan"]["frappe_user"] == _email(erp["zhangsan"])
    assert rows["zhaoliu"]["frappe_roles"] == ["LMS Student", "Sales User"] and rows["zhaoliu"]["frappe_user"] is None
    assert rows["wangwu"]["frappe_roles"] == []
    status = admin_client.get("/api/sso/status", headers=headers).json()
    assert status["frappe_enabled"] is True and status["frappe_problem"] is None
    assert status["frappe_url"] == "https://hr.test"


# --- 10. 迁移 -------------------------------------------------------------------
def test_迁移种的默认映射():
    role_map = _migration("080_frappe_sync").DEFAULT_ROLE_MAP
    assert role_map == [(None, "LMS Student"), ("销售", "Sales User"),
                        ("ERP管理员", "Sales Manager"), ("ERP管理员", "Sales User")]
    groups = {name for name, _, _ in _migration("079_platform_sso").DEFAULT_GROUPS}
    for group, role in role_map:
        assert group is None or group in groups
        assert frappe_sync.clean_role_name(role) == role and role != "System Manager"


def test_迁移按名字找分组_找不到的不种_降级删表():
    """079 种的分组线上在用：改了名、删掉了的分组不种那一条。"""
    engine = create_engine("sqlite://")
    module = _migration("080_frappe_sync")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE staff (id VARCHAR(36) PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE platform_group (id VARCHAR(36) PRIMARY KEY, name VARCHAR(80))"))
        conn.execute(text("INSERT INTO platform_group VALUES ('g-sales', '销售'), ('g-admin', '管理员组')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
        rows = sorted(conn.execute(text("SELECT group_id, role FROM frappe_role_map")).fetchall(), key=str)
        assert rows == sorted([(None, "LMS Student"), ("g-sales", "Sales User")], key=str)
        assert "frappe_account" in inspect(conn).get_table_names()
        with Operations.context(MigrationContext.configure(conn)):
            module.downgrade()
        assert not {"frappe_role_map", "frappe_account"} & set(inspect(conn).get_table_names())


def test_没开号的不建_ready只看统一登录有没有开好(db_session, fr, erp):
    """统一登录那边号开好了才建；用户名对不上（改名还没同步）也算没开好。"""
    zhaoliu = erp["zhaoliu"]
    db_session.add(AuthentikAccount(staff_id=zhaoliu.id, authentik_pk=1, authentik_username="old-name",
                                    synced_at=datetime.utcnow()))
    db_session.commit()
    _sync(db_session)
    assert _user(fr, zhaoliu) is None
    db_session.get(AuthentikAccount, zhaoliu.id).authentik_username = "zhaoliu"
    db_session.commit()
    _sync(db_session)
    assert fr.roles_of(_email(zhaoliu)) == ["LMS Student", "Sales User"]


def test_手工挂进分组的人也按分组给(db_session, fr, erp):
    lisi = erp["lisi"]
    sales = _group(db_session, "销售")
    db_session.add(PlatformGroupMember(group_id=sales.id, staff_id=lisi.id))
    db_session.commit()
    _sync(db_session)
    assert fr.roles_of(_email(lisi)) == ["LMS Student", "Sales User"]
