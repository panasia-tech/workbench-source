"""统一登录同步：ERP 员工 → Authentik（services/authentik_sync.py）。

Authentik 是假的（tests/fake_authentik.py）：一个按 /api/v3 接口写的内存实现，挂在 httpx.MockTransport 上，同步走的
是真的客户端代码（翻页、报错、Bearer 头）。用户名、组名照 Authentik 的规矩不许重复；每页只给 2 条，逼着同步翻页。
能进哪些系统（同一轮里的后一段）见 test_authentik_access.py，这里开关关着。

# 这里钉死的

  1. 预演只打印不改：Authentik 一个写请求都没有，ERP 也不落任何东西；
  2. 真跑：建号（path=erp、attributes.erp_sub）、建组（erp_managed）、进组；设备账号、停用的人不建；
  3. 幂等：跑第二遍什么都不做；
  4. 别人的号（两个真人、outpost 服务账号）和别人的组一律不碰，ERP 的号被手工加进别人的组也不动；
  5. 停用 / 删除 / 改成设备账号 → 统一登录停号、移出 ERP 的组；恢复了再启用；删除的人用户名跟着改写，
     腾出来给新人；
  6. 用户名、组名撞了统一登录里别人的：报冲突、不建不碰，ERP 登录也不放行 / 不发这个组；
  7. 改角色组员跟着挪；ERP 里改组名，统一登录里同一个组改名；ERP 里删了分组，那边组留着、ERP 的号移出去；
  8. 一步失败不拖累别的，下一轮补上；
  9. 开关关着只能预演；后台能手动触发；
 10. 同步完，ERP 账号就能登录统一登录，组也带过去；迁移种的默认分组就是 10-18 定的那张表；
 11. 占位邮箱（Frappe 按它认人）：建号就带、一期已经建好的号补上、被改了改回来、跟着员工 ID 不跟用户名，
     别人的号的邮箱不碰。
"""

import copy
import importlib.util
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.database import get_db
from app.deps import create_access_token
from app.enums import StaffRole, StaffStatus
from app.models import AuthentikAccount, PlatformGroup, PlatformGroupMember, Staff
from app.routers import sso as sso_router
from app.services import authentik_sync, oidc_provider, platform_groups
from app.services.password import hash_password
from fake_authentik import TOKEN, FakeAuthentik

_PW_HASH = hash_password("pw")   # bcrypt 慢，一个模块算一次
MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "079_platform_sso.py"


def _migration():
    spec = importlib.util.spec_from_file_location("migration_079", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def ak(monkeypatch):
    fake = FakeAuthentik()
    akadmin = fake.add_user("akadmin", name="authentik Default Admin")
    boss = fake.add_user("boss", name="老板")
    fake.add_user("ak-outpost-1", type="internal_service_account", path="goauthentik.io/outposts")
    fake.add_group("authentik Admins", is_superuser=True, members=[akadmin])
    fake.add_group("Homebox用户", members=[boss])
    monkeypatch.setattr(settings, "authentik_url", "https://id.test")
    monkeypatch.setattr(settings, "authentik_api_token", TOKEN)
    monkeypatch.setattr(settings, "authentik_user_path", "erp")
    monkeypatch.setattr(settings, "authentik_sync_enabled", True)
    monkeypatch.setattr(settings, "authentik_access_sync_enabled", False)
    transport = httpx.MockTransport(fake.handler)
    monkeypatch.setattr(authentik_sync, "make_api", lambda transport_=None: authentik_sync.AuthentikApi(
        settings.authentik_url, settings.authentik_api_token, transport=transport))
    return fake


def _staff(db, username, role=StaffRole.SALES, status=StaffStatus.ACTIVE, name=None, staff_no=None):
    s = Staff(staff_no=staff_no or f"E-{username}", username=username, name=name or username.upper(),
              password_hash=_PW_HASH, role=role, status=status)
    db.add(s)
    db.commit()
    return s


@pytest.fixture()
def erp(db_session):
    """默认分组用迁移 079 种的那份；工作台老板手工挂了 admin。"""
    for name, roles, description in _migration().DEFAULT_GROUPS:
        db_session.add(PlatformGroup(name=name, roles=roles, description=description))
    db_session.commit()
    people = {
        "admin": _staff(db_session, "admin", StaffRole.ADMIN),
        "zhangsan": _staff(db_session, "zhangsan", StaffRole.SALES),
        "lisi": _staff(db_session, "lisi", StaffRole.PURCHASER),
        "crawler": _staff(db_session, "crawler-01", StaffRole.CRAWLER),
        "rfid": _staff(db_session, "rfid-01", StaffRole.RFID_DEVICE),
        "wangwu": _staff(db_session, "wangwu", StaffRole.SALES, status=StaffStatus.DISABLED),
    }
    boss_group = db_session.query(PlatformGroup).filter_by(name="工作台老板").one()
    db_session.add(PlatformGroupMember(group_id=boss_group.id, staff_id=people["admin"].id))
    db_session.commit()
    return people


def _sync(db, *, dry_run=False):
    api = authentik_sync.make_api()
    try:
        return authentik_sync.run_sync(db, api, dry_run=dry_run)
    finally:
        api.close()


# --- 1. 预演 --------------------------------------------------------------------
def test_预演只打印不改(db_session, ak, erp):
    before = ak.snapshot()
    report = _sync(db_session, dry_run=True)
    assert report.counts["建组"] == 8 and report.counts["建号"] == 3
    assert "建号 zhangsan（ZHANGSAN，销售）" in report.actions
    assert "进组 admin →「工作台老板」" in report.actions
    assert report.lines()[0].startswith("统一登录同步预演（只看不改）")
    assert ak.writes() == [] and ak.snapshot() == before
    assert db_session.query(AuthentikAccount).count() == 0
    assert all(g.authentik_pk is None for g in db_session.query(PlatformGroup))


# --- 2. 真跑 / 3. 幂等 ---------------------------------------------------------------
def test_真跑一遍_建号建组进组_设备账号和停用的人不建(db_session, ak, erp):
    report = _sync(db_session)
    assert report.errors == [] and report.conflicts == []
    for key in ("admin", "zhangsan", "lisi"):
        staff = erp[key]
        u = ak.user(staff.username)
        assert u["path"] == "erp" and u["type"] == "internal" and u["is_active"] is True
        assert u["attributes"] == {"erp_sub": staff.id, "erp_staff_no": staff.staff_no, "erp_role": staff.role}
        account = db_session.get(AuthentikAccount, staff.id)
        assert (account.authentik_pk, account.authentik_username) == (u["pk"], staff.username)
    for username in ("crawler-01", "rfid-01", "wangwu"):
        assert ak.user(username) is None
    assert ak.member_names("admin") == ["ERP管理员", "工作台老板"]
    assert ak.member_names("zhangsan") == ["销售"]
    assert ak.member_names("lisi") == ["采购"]
    for g in db_session.query(PlatformGroup):
        made = ak.group(g.name)
        assert made["attributes"] == {"erp_managed": True} and made["is_superuser"] is False
        assert (g.authentik_pk, g.authentik_name, g.authentik_note) == (made["pk"], g.name, None)


def test_跑第二遍什么都不做(db_session, ak, erp):
    _sync(db_session)
    writes = len(ak.writes())
    report = _sync(db_session)
    assert report.actions == [] and not any(report.counts.values())
    assert len(ak.writes()) == writes
    assert report.lines() == ["统一登录同步：没有要改的"]


# --- 4. 不碰别人的 ---------------------------------------------------------------
def test_别人的号和组一律不碰(db_session, ak, erp):
    theirs = lambda: (  # noqa: E731
        {pk: u for pk, u in ak.users.items() if u["path"] != "erp"},
        {pk: g for pk, g in ak.groups.items() if not g["attributes"].get("erp_managed")},
    )
    before = copy.deepcopy(theirs())
    _sync(db_session)
    _sync(db_session)
    assert theirs() == before


def test_ERP的号被手工加进别人的组_不动(db_session, ak, erp):
    _sync(db_session)
    ak.group("Homebox用户")["users"].add(ak.user("zhangsan")["pk"])
    _sync(db_session)
    assert "Homebox用户" in ak.member_names("zhangsan")


# --- 5. 停用 / 删除 ----------------------------------------------------------------
def test_停用了统一登录跟着停_恢复了再启用(db_session, ak, erp):
    _sync(db_session)
    zhangsan = erp["zhangsan"]
    zhangsan.status = StaffStatus.DISABLED
    db_session.commit()
    report = _sync(db_session)
    assert "改号 zhangsan：停用" in report.actions
    assert ak.user("zhangsan")["is_active"] is False and ak.member_names("zhangsan") == []
    zhangsan.status = StaffStatus.ACTIVE
    db_session.commit()
    _sync(db_session)
    assert ak.user("zhangsan")["is_active"] is True and ak.member_names("zhangsan") == ["销售"]


def test_改成设备账号也停(db_session, ak, erp):
    _sync(db_session)
    erp["lisi"].role = StaffRole.CRAWLER
    db_session.commit()
    _sync(db_session)
    assert ak.user("lisi")["is_active"] is False and ak.member_names("lisi") == []


def test_删除的人用户名跟着改写_腾给同名新人(db_session, ak, erp):
    """照 routers/staff.py 的软删：停用 + 用户名改写成 xxx__del_xxxxxxxx。新人再用这个用户名。"""
    _sync(db_session)
    old = erp["lisi"]
    old_pk = ak.user("lisi")["pk"]
    old.deleted_at = datetime.utcnow()
    old.status = StaffStatus.DISABLED
    old.username = f"lisi__del_{old.id[:8]}"
    db_session.commit()
    new = _staff(db_session, "lisi", StaffRole.PURCHASER, name="新李四", staff_no="E-lisi-2")
    report = _sync(db_session)
    assert report.conflicts == [] and report.errors == []
    renamed = ak.users[old_pk]
    assert renamed["username"] == old.username and renamed["is_active"] is False
    assert ak.member_names(old.username) == []
    fresh = ak.user("lisi")
    assert fresh["pk"] != old_pk and fresh["attributes"]["erp_sub"] == new.id
    assert ak.member_names("lisi") == ["采购"]
    assert db_session.get(AuthentikAccount, new.id).authentik_pk == fresh["pk"]
    assert oidc_provider.refusal(db_session, new) is None


def test_统一登录里对不上ERP员工的号_停用(db_session, ak, erp):
    _sync(db_session)
    ghost = ak.add_user("ghost", path="erp", attributes={"erp_sub": "no-such-staff"})
    ak.group("销售")["users"].add(ghost)
    report = _sync(db_session)
    assert "停用 ghost（ERP 里找不到这个员工）" in report.actions
    assert ak.users[ghost]["is_active"] is False and ak.member_names("ghost") == []


def test_两个号标着同一个员工_都不碰_ERP登录关门(db_session, ak, erp):
    _sync(db_session)
    zhangsan = erp["zhangsan"]
    twin = ak.add_user("zhangsan2", path="erp", attributes={"erp_sub": zhangsan.id})
    before = ak.snapshot()
    report = _sync(db_session)
    assert any("都标着同一个 ERP 员工" in c for c in report.conflicts)
    assert ak.snapshot() == before and ak.users[twin]["is_active"] is True
    assert oidc_provider.refusal(db_session, zhangsan) == oidc_provider.NOT_SYNCED


# --- 6. 冲突 --------------------------------------------------------------------
def test_用户名被别人占着_报冲突不建_ERP登录也不放行(db_session, ak, erp):
    boss = _staff(db_session, "boss", StaffRole.FINANCE)
    akadmin = _staff(db_session, "akadmin", StaffRole.ADMIN)
    before = copy.deepcopy((ak.user("boss"), ak.user("akadmin")))
    report = _sync(db_session)
    assert any(c.startswith("boss（") and "不是 ERP 同步来的" in c for c in report.conflicts)
    assert any(c.startswith("akadmin（") for c in report.conflicts)
    assert (ak.user("boss"), ak.user("akadmin")) == before
    assert ak.member_names("akadmin") == ["authentik Admins"], "没被加进 ERP管理员 组"
    for staff in (boss, akadmin):
        assert db_session.get(AuthentikAccount, staff.id) is None
        assert oidc_provider.refusal(db_session, staff) == oidc_provider.NOT_SYNCED


def test_组名撞了别人的组_报冲突不碰_登录也不发(db_session, ak, erp):
    db_session.add(PlatformGroup(name="Homebox用户", roles=[StaffRole.SALES]))
    db_session.commit()
    report = _sync(db_session)
    assert any("Homebox用户" in c and "不是 ERP 建的" in c for c in report.conflicts)
    assert ak.group("Homebox用户")["users"] == {ak.user("boss")["pk"]}
    row = db_session.query(PlatformGroup).filter_by(name="Homebox用户").one()
    assert row.authentik_pk is None and "同名组" in row.authentik_note
    assert platform_groups.groups_for_staff(db_session, erp["zhangsan"]) == ["销售"]


def test_authentik开头的组名不同步(db_session, ak, erp):
    """后台接口挡着建不出来；万一库里有了（手工改库），同步也不碰。"""
    db_session.add(PlatformGroup(name="authentik Admins", roles=[StaffRole.SALES]))
    db_session.commit()
    report = _sync(db_session)
    assert any("authentik Admins" in c for c in report.conflicts)
    assert ak.user("zhangsan")["pk"] not in ak.group("authentik Admins")["users"]


# --- 7. 改角色 / 改组名 / 删分组 ---------------------------------------------------------
def test_改角色_组员跟着挪(db_session, ak, erp):
    _sync(db_session)
    erp["zhangsan"].role = StaffRole.PURCHASER
    db_session.commit()
    report = _sync(db_session)
    assert "进组 zhangsan →「采购」" in report.actions and "出组 zhangsan ←「销售」" in report.actions
    assert ak.member_names("zhangsan") == ["采购"]


def test_ERP里改组名_统一登录里同一个组改名(db_session, ak, erp):
    _sync(db_session)
    sales = db_session.query(PlatformGroup).filter_by(name="销售").one()
    pk = sales.authentik_pk
    sales.name = "销售部"
    db_session.commit()
    assert platform_groups.groups_for_staff(db_session, erp["zhangsan"]) == [], "改名还没同步，先不发"
    report = _sync(db_session)
    assert "组改名「销售」→「销售部」" in report.actions
    assert ak.groups[pk]["name"] == "销售部" and ak.group("销售") is None
    assert platform_groups.groups_for_staff(db_session, erp["zhangsan"]) == ["销售部"]


def test_ERP里删了分组_统一登录里组留着_ERP的号移出去(db_session, ak, erp):
    _sync(db_session)
    group = ak.group("工作台老板")
    group["users"].add(ak.user("boss")["pk"])   # 统一登录里手工加的非 ERP 成员
    row = db_session.query(PlatformGroup).filter_by(name="工作台老板").one()
    db_session.query(PlatformGroupMember).filter_by(group_id=row.id).delete()
    db_session.delete(row)
    db_session.commit()
    report = _sync(db_session)
    assert "出组 admin ←「工作台老板」" in report.actions
    assert any("工作台老板" in n for n in report.notes)
    assert ak.group("工作台老板") is not None and group["users"] == {ak.user("boss")["pk"]}
    assert _sync(db_session).notes == [], "移完了就不再提醒"


# --- 8. 失败 --------------------------------------------------------------------
def test_一步失败不拖累别的_下一轮补上(db_session, ak, erp):
    ak.fail[("POST", "lisi")] = 500
    report = _sync(db_session)
    assert any(e.startswith("建号 lisi") for e in report.errors)
    assert any("跳过" in e for e in report.errors), "建号没成，后面给他进组跳过"
    assert ak.user("zhangsan") and ak.user("lisi") is None
    assert db_session.get(AuthentikAccount, erp["lisi"].id) is None
    del ak.fail[("POST", "lisi")]
    assert _sync(db_session).errors == []
    assert ak.member_names("lisi") == ["采购"]


def test_建组失败_这个组先不发(db_session, ak, erp):
    ak.fail[("POST", "销售")] = 500
    _sync(db_session)
    row = db_session.query(PlatformGroup).filter_by(name="销售").one()
    assert row.authentik_pk is None and "建组没成" in row.authentik_note
    assert platform_groups.groups_for_staff(db_session, erp["zhangsan"]) == []


def test_读不到Authentik直接报错(db_session, ak, erp, monkeypatch):
    monkeypatch.setattr(settings, "authentik_api_token", "wrong")
    api = authentik_sync.AuthentikApi("https://id.test", "wrong", transport=httpx.MockTransport(
        lambda request: httpx.Response(403, json={"detail": "Token invalid/expired"})))
    with pytest.raises(authentik_sync.AuthentikError, match="403"):
        authentik_sync.run_sync(db_session, api, dry_run=True)


# --- 9. 开关 / 手动触发 ---------------------------------------------------------------
def test_开关关着只能预演_没token都跑不了(ak, monkeypatch):
    monkeypatch.setattr(settings, "authentik_sync_enabled", False)
    assert authentik_sync.why_not(dry_run=True) is None
    assert "AUTHENTIK_SYNC_ENABLED" in authentik_sync.why_not(dry_run=False)
    monkeypatch.setattr(settings, "authentik_api_token", "")
    assert "AUTHENTIK_API_TOKEN" in authentik_sync.why_not(dry_run=True)
    monkeypatch.setattr(settings, "authentik_api_token", TOKEN)
    monkeypatch.setattr(settings, "authentik_user_path", "/erp")
    assert "AUTHENTIK_USER_PATH" in authentik_sync.why_not(dry_run=True)


def test_同步锁挂在单独的连接上_中途commit也放得掉():
    """MySQL 的 GET_LOCK 跟着连接走。挂在会话自己的连接上的话，同步中途 commit 连接就回了池子，
    RELEASE_LOCK 落到别的连接上放不掉，接口所在的 worker 之后一直回「上一轮还在跑」（本机 MySQL 实测踩到）。"""
    executed = []

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            executed.append(("close", self))

        def execute(self, stmt, params=None):
            executed.append((str(stmt), self))
            return SimpleNamespace(scalar=lambda: 1)

    conn = Conn()
    engine = SimpleNamespace(dialect=SimpleNamespace(name="mysql"), connect=lambda: conn)

    class Db:
        def get_bind(self):
            return engine

        def execute(self, *a, **k):
            raise AssertionError("锁不能走会话自己的连接")

    with authentik_sync.sync_lock(Db()) as got:
        assert got
    assert [sql for sql, _ in executed] == ["SELECT GET_LOCK(:n, 0)", "SELECT RELEASE_LOCK(:n)", "close"]
    assert all(c is conn for _, c in executed)


@pytest.fixture()
def admin_client(db_session):
    app = FastAPI()
    app.include_router(sso_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(app)


def _auth(staff):
    return {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


def test_后台手动触发(db_session, ak, erp, admin_client, monkeypatch):
    admin = erp["admin"]
    dry = admin_client.post("/api/sso/authentik-sync", json={"dry_run": True}, headers=_auth(admin))
    assert dry.status_code == 200 and dry.json()["dry_run"] is True and dry.json()["counts"]["建号"] == 3
    assert ak.writes() == []
    real = admin_client.post("/api/sso/authentik-sync", json={"dry_run": False}, headers=_auth(admin))
    assert real.status_code == 200 and ak.user("zhangsan")
    monkeypatch.setattr(settings, "authentik_sync_enabled", False)
    refused = admin_client.post("/api/sso/authentik-sync", json={"dry_run": False}, headers=_auth(admin))
    assert refused.status_code == 400 and "AUTHENTIK_SYNC_ENABLED" in refused.json()["detail"]
    sales = admin_client.post("/api/sso/authentik-sync", json={"dry_run": True}, headers=_auth(erp["zhangsan"]))
    assert sales.status_code == 403


def test_后台读不到Authentik回502(db_session, ak, erp, admin_client, monkeypatch):
    monkeypatch.setattr(authentik_sync, "make_api", lambda transport_=None: authentik_sync.AuthentikApi(
        "https://id.test", TOKEN, transport=httpx.MockTransport(lambda r: httpx.Response(500, text="oops"))))
    resp = admin_client.post("/api/sso/authentik-sync", json={"dry_run": True}, headers=_auth(erp["admin"]))
    assert resp.status_code == 502 and "500" in resp.json()["detail"]


# --- 10. 和登录接上 / 默认分组 -------------------------------------------------------------
def test_同步完_ERP账号能登录统一登录_组带过去(db_session, ak, erp):
    zhangsan = erp["zhangsan"]
    assert oidc_provider.refusal(db_session, zhangsan) == oidc_provider.NOT_SYNCED
    _sync(db_session)
    assert oidc_provider.refusal(db_session, zhangsan) is None
    assert oidc_provider.profile_claims(db_session, zhangsan)["groups"] == ["销售"]
    assert oidc_provider.profile_claims(db_session, erp["admin"])["groups"] == ["ERP管理员", "工作台老板"]


def test_迁移种的默认分组就是10_18定的那张表():
    groups = {name: roles for name, roles, _ in _migration().DEFAULT_GROUPS}
    assert groups == {
        "ERP管理员": ["ADMIN"], "采购": ["PURCHASER"], "仓管": ["WAREHOUSE"], "议价": ["NEGOTIATOR"],
        "销售": ["SALES"], "财务": ["FINANCE"], "工作台老板": [], "工作台管理员": [],
    }


# --- 11. 占位邮箱 ---------------------------------------------------------------
def test_建号带占位邮箱_用员工ID拼(db_session, ak, erp):
    _sync(db_session)
    for key in ("admin", "zhangsan", "lisi"):
        staff = erp[key]
        assert ak.user(staff.username)["email"] == f"{staff.id}@staff.panasia.fun"
    assert authentik_sync.staff_email("ABC-1") == "ebe18c7fc2@example.invalid", "Frappe 的主键是小写邮箱"


def test_一期已经建好的号补上邮箱_别人的号不碰(db_session, ak, erp):
    """线上一期建的号没有邮箱：这一版上去第一轮补上，第二轮什么都不做。"""
    ak.user("boss")["email"] = "boss@example.com"
    _sync(db_session)
    for u in ak.users.values():
        if u["path"] == "erp":
            u.pop("email")
    report = _sync(db_session)
    zhangsan = erp["zhangsan"]
    assert f"改号 zhangsan：邮箱 （空）→{zhangsan.id}@staff.panasia.fun" in report.actions
    assert report.counts["改号"] == 3 and report.errors == []
    assert ak.user("zhangsan")["email"] == authentik_sync.staff_email(zhangsan.id)
    assert ak.user("boss")["email"] == "boss@example.com" and "email" not in ak.user("akadmin")
    assert _sync(db_session).actions == []


def test_ERP的号邮箱被改了_改回来(db_session, ak, erp):
    """Frappe 按邮箱认人：ERP 的号邮箱被改成别人的，就能从统一登录进别人的 Frappe。"""
    _sync(db_session)
    ak.user("zhangsan")["email"] = "boss@example.com"
    report = _sync(db_session)
    assert any(a.startswith("改号 zhangsan：邮箱 boss@example.com→") for a in report.actions)
    assert ak.user("zhangsan")["email"] == authentik_sync.staff_email(erp["zhangsan"].id)


def test_删除的人邮箱不跟着用户名走_同名新人是另一个邮箱(db_session, ak, erp):
    _sync(db_session)
    old = erp["lisi"]
    old_pk = ak.user("lisi")["pk"]
    old.deleted_at = datetime.utcnow()
    old.status = StaffStatus.DISABLED
    old.username = f"lisi__del_{old.id[:8]}"
    db_session.commit()
    new = _staff(db_session, "lisi", StaffRole.PURCHASER, name="新李四", staff_no="E-lisi-2")
    _sync(db_session)
    assert ak.users[old_pk]["email"] == authentik_sync.staff_email(old.id)
    assert ak.user("lisi")["email"] == authentik_sync.staff_email(new.id) != authentik_sync.staff_email(old.id)


def test_对不上ERP员工的号和两个号标同一个人的_邮箱不碰(db_session, ak, erp):
    _sync(db_session)
    ghost = ak.add_user("ghost", path="erp", attributes={"erp_sub": "no-such-staff"})
    twin = ak.add_user("zhangsan2", path="erp", attributes={"erp_sub": erp["lisi"].id})
    _sync(db_session)
    assert "email" not in ak.users[ghost] and "email" not in ak.users[twin]
