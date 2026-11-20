"""后台「统一登录」接口（/api/sso/*，routers/sso.py）：平台分组的增删改、员工状态、配置状态。

# 这里钉死的

  1. 分组按 ERP 角色自动进 + 手工挂人；只能挂真人员工，设备角色、设备账号、删了的人都挂不进去；
  2. 组名：不能空、不超 80 字、不能 authentik 开头（统一登录自己的管理员组就是这个开头）、不能重名；
  3. 改了组名，同步把统一登录里的组也改好之前，登录时先不发这个组；
  4. 参数不对一律 400，不回 403——后台的请求拦截器把 403 当成登录失效，直接踢回登录页；
  5. 员工页列出每个真人员工发哪些组、哪些还在等同步、现在能不能用 ERP 账号登录、不能的原因；
  6. 配置状态把「开了但没配好」的原因原样给出来；只给管理员。
"""

from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.database import get_db
from app.deps import create_access_token
from app.enums import StaffRole, StaffStatus
from app.models import AuthentikAccount, PlatformGroup, PlatformGroupMember, Staff
from app.routers import sso as sso_router
from app.services import oidc_provider, platform_groups
from app.services.password import hash_password

_PW_HASH = hash_password("pw")


def _staff(db, username, role=StaffRole.SALES, status=StaffStatus.ACTIVE):
    s = Staff(staff_no=f"E-{username}", username=username, name=username.upper(),
              password_hash=_PW_HASH, role=role, status=status)
    db.add(s)
    db.commit()
    return s


@pytest.fixture()
def admin(db_session):
    return _staff(db_session, "admin", StaffRole.ADMIN)


@pytest.fixture()
def api(db_session, admin):
    app = FastAPI()
    app.include_router(sso_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    client = TestClient(app)
    client.headers["Authorization"] = f"Bearer {create_access_token(admin.id, admin.role)}"
    return client


def test_新建分组_按角色自动进加手工挂人(api, db_session):
    a = _staff(db_session, "zhangsan")
    b = _staff(db_session, "lisi", StaffRole.WAREHOUSE)
    resp = api.post("/api/sso/groups", json={
        "name": "  工作台老板 ", "description": "老板", "roles": ["ADMIN", "ADMIN"], "member_ids": [b.id, a.id],
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "工作台老板" and body["roles"] == ["ADMIN"] and body["synced"] is False
    assert [m["username"] for m in body["members"]] == ["lisi", "zhangsan"]
    assert [g["name"] for g in api.get("/api/sso/groups").json()] == ["工作台老板"]
    assert platform_groups.groups_for_staff(db_session, a, confirmed_only=False) == ["工作台老板"]
    assert platform_groups.groups_for_staff(db_session, a) == [], "没同步过的组登录时先不发"


@pytest.mark.parametrize("name,expect", [
    ("", "不能为空"),
    ("   ", "不能为空"),
    ("authentik Admins", "authentik"),
    ("AUTHENTIK 只读", "authentik"),
    ("组" * 81, "80"),
    ("坏\x07名", "看不见"),
])
def test_组名校验(api, name, expect):
    resp = api.post("/api/sso/groups", json={"name": name})
    assert resp.status_code == 400 and expect in resp.json()["detail"]


def test_组名不能重名(api):
    assert api.post("/api/sso/groups", json={"name": "销售"}).status_code == 200
    dup = api.post("/api/sso/groups", json={"name": "销售"})
    assert dup.status_code == 400 and "已经有" in dup.json()["detail"]
    other = api.post("/api/sso/groups", json={"name": "采购"}).json()
    assert api.patch(f"/api/sso/groups/{other['id']}", json={"name": "销售"}).status_code == 400


@pytest.mark.parametrize("role", ["CRAWLER", "RFID_DEVICE", "MARKET_BOT", "NOBODY"])
def test_设备角色进不了分组(api, role):
    resp = api.post("/api/sso/groups", json={"name": "x", "roles": [role]})
    assert resp.status_code == 400 and "设备账号" in resp.json()["detail"]


def test_设备账号和删了的人挂不进去(api, db_session):
    device = _staff(db_session, "crawler-01", StaffRole.CRAWLER)
    gone = _staff(db_session, "gone")
    gone.deleted_at = datetime.utcnow()
    db_session.commit()
    for ids in ([device.id], [gone.id], ["no-such-id"]):
        resp = api.post("/api/sso/groups", json={"name": "x", "member_ids": ids})
        assert resp.status_code == 400
    assert db_session.query(PlatformGroup).count() == 0


def test_改组名后先不发_等同步改好(api, db_session):
    s = _staff(db_session, "zhangsan")
    group = PlatformGroup(name="销售", roles=["SALES"], authentik_pk="pk-1", authentik_name="销售")
    db_session.add(group)
    db_session.commit()
    assert platform_groups.groups_for_staff(db_session, s) == ["销售"]
    resp = api.patch(f"/api/sso/groups/{group.id}", json={"name": "销售部"})
    assert resp.status_code == 200 and resp.json()["synced"] is False
    assert platform_groups.groups_for_staff(db_session, s) == []


def test_手工成员整组覆盖(api, db_session):
    a, b = _staff(db_session, "a1"), _staff(db_session, "b1")
    group = api.post("/api/sso/groups", json={"name": "g", "member_ids": [a.id]}).json()
    resp = api.patch(f"/api/sso/groups/{group['id']}", json={"member_ids": [b.id]})
    assert [m["username"] for m in resp.json()["members"]] == ["b1"]
    resp = api.patch(f"/api/sso/groups/{group['id']}", json={"member_ids": []})
    assert resp.json()["members"] == []
    resp = api.patch(f"/api/sso/groups/{group['id']}", json={"description": "只改说明"})
    assert resp.json()["description"] == "只改说明" and resp.json()["name"] == "g"


def test_删除分组连手工成员一起删(api, db_session):
    a = _staff(db_session, "a1")
    group = api.post("/api/sso/groups", json={"name": "g", "member_ids": [a.id]}).json()
    assert api.delete(f"/api/sso/groups/{group['id']}").status_code == 204
    assert db_session.query(PlatformGroupMember).count() == 0
    assert api.delete(f"/api/sso/groups/{group['id']}").status_code == 404
    assert api.patch(f"/api/sso/groups/{group['id']}", json={"name": "x"}).status_code == 404


def test_员工列表_发哪些组_能不能登录(api, db_session, admin):
    sales = _staff(db_session, "zhangsan")
    _staff(db_session, "crawler-01", StaffRole.CRAWLER)
    disabled = _staff(db_session, "wangwu", status=StaffStatus.DISABLED)
    db_session.add_all([
        PlatformGroup(name="销售", roles=["SALES"], authentik_pk="pk-1", authentik_name="销售"),
        PlatformGroup(name="销售新组", roles=["SALES"]),
        AuthentikAccount(staff_id=sales.id, authentik_pk=7, authentik_username="zhangsan", synced_at=datetime.utcnow()),
    ])
    db_session.commit()
    rows = {r["username"]: r for r in api.get("/api/sso/staff").json()}
    assert set(rows) == {"admin", "zhangsan", "wangwu"}, "设备账号不列"
    z = rows["zhangsan"]
    assert z["groups"] == ["销售"] and z["groups_pending"] == ["销售新组"]
    assert z["can_login"] is True and z["account"]["authentik_username"] == "zhangsan"
    assert rows["admin"]["can_login"] is False and rows["admin"]["reason"] == oidc_provider.NOT_SYNCED
    assert rows["wangwu"]["groups"] == [] and rows["wangwu"]["reason"] == "账号未激活"
    assert disabled.id == rows["wangwu"]["id"]


def test_配置状态把没配好的原因给出来(api, monkeypatch):
    monkeypatch.setattr(settings, "oidc_enabled", True)
    monkeypatch.setattr(settings, "oidc_issuer", "")
    monkeypatch.setattr(settings, "authentik_api_token", "")
    body = api.get("/api/sso/status").json()
    assert body["oidc_enabled"] is True and "OIDC_ISSUER" in body["oidc_problem"]
    assert body["discovery_url"] is None
    assert "AUTHENTIK_API_TOKEN" in body["sync_problem"]
    monkeypatch.setattr(settings, "oidc_enabled", False)
    assert api.get("/api/sso/status").json()["oidc_problem"] is None


def test_只给管理员(api, db_session):
    sales = _staff(db_session, "zhangsan")
    resp = api.get("/api/sso/groups", headers={"Authorization": f"Bearer {create_access_token(sales.id, sales.role)}"})
    assert resp.status_code == 403
