"""H5 的「记住密码」凭证（app/services/remember_login.py）。

# 这里钉死的

  1. 记住的凭证能换出登录令牌，带 tabs / landing_page（和密码登录一样落地）
  2. 两种令牌不能混用：凭证当登录令牌用不行，登录令牌冒充凭证也不行
  3. 员工改了密码，记住的凭证立刻作废
  4. 账号停用、过期、伪造、角色不在 H5 的门里，都换不出令牌
  5. 只有登录了的人能要凭证，设备账号要不到
"""

from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from jose import JWTError, jwt

from app.database import get_db
from app.deps import create_access_token, decode_token
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.routers import auth
from app.schemas.auth import RememberLoginRequest
from app.services import remember_login
from app.services.password import hash_password


def _staff(db, role=StaffRole.SALES, username="u1", password="DEMO_ONLY_REDACTED"):
    s = Staff(staff_no=f"R-{username}", name="测试", username=username,
              password_hash=hash_password(password), role=role, status=StaffStatus.ACTIVE)
    db.add(s)
    db.commit()
    return s


def _remember_login(db, token):
    return auth.h5_remember_login(RememberLoginRequest(remember_token=token), db)


# --- 1 ---------------------------------------------------------------------------
def test_记住的凭证能换出登录令牌(db_session):
    s = _staff(db_session)
    res = _remember_login(db_session, remember_login.issue(s))
    assert res.token and res.staff.id == s.id
    assert res.tabs and res.landing_page


# --- 2 ---------------------------------------------------------------------------
def test_凭证不能当登录令牌用(db_session):
    s = _staff(db_session)
    with pytest.raises(JWTError):
        decode_token(remember_login.issue(s))


def test_登录令牌冒充不了凭证(db_session):
    s = _staff(db_session)
    assert remember_login.verify(db_session, create_access_token(s.id, s.role)) is None


# --- 3 ---------------------------------------------------------------------------
def test_改了密码凭证作废(db_session):
    s = _staff(db_session)
    token = remember_login.issue(s)
    s.password_hash = hash_password("new-pw")
    db_session.commit()
    with pytest.raises(HTTPException) as exc:
        _remember_login(db_session, token)
    assert exc.value.status_code == 401


# --- 4 ---------------------------------------------------------------------------
def test_停用的账号换不出令牌(db_session):
    s = _staff(db_session)
    token = remember_login.issue(s)
    s.status = StaffStatus.DISABLED
    db_session.commit()
    assert remember_login.verify(db_session, token) is None


def test_过期的凭证不认(db_session):
    s = _staff(db_session)
    expired = jwt.encode(
        {"sub": s.id, "pwh": remember_login._pwh(s), "typ": "h5-remember", "exp": datetime.utcnow() - timedelta(seconds=1)},
        remember_login._key(), algorithm="HS256",
    )
    assert remember_login.verify(db_session, expired) is None


def test_伪造的凭证不认(db_session):
    s = _staff(db_session)
    forged = jwt.encode(
        {"sub": s.id, "pwh": remember_login._pwh(s), "typ": "h5-remember", "exp": datetime.utcnow() + timedelta(days=1)},
        "wrong-key", algorithm="HS256",
    )
    assert remember_login.verify(db_session, forged) is None
    assert remember_login.verify(db_session, "garbage") is None


def test_角色不在H5的门里换不出令牌(db_session):
    s = _staff(db_session, role=StaffRole.RFID_DEVICE)
    with pytest.raises(HTTPException) as exc:
        _remember_login(db_session, remember_login.issue(s))
    assert exc.value.status_code == 401


# --- 5 ---------------------------------------------------------------------------
def _client(db):
    app = FastAPI()
    app.include_router(auth.router)
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def test_HTTP_登录后要凭证再用凭证登录(db_session):
    s = _staff(db_session)
    c = _client(db_session)
    assert c.post("/api/auth/h5-remember").status_code == 401, "没登录要不到凭证"
    token = c.post("/api/auth/h5-login", json={"username": "u1", "password": "DEMO_ONLY_REDACTED"}).json()["token"]
    r = c.post("/api/auth/h5-remember", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and r.json()["expires_in_days"] == 30
    r2 = c.post("/api/auth/h5-remember-login", json={"remember_token": r.json()["remember_token"]})
    assert r2.status_code == 200 and r2.json()["staff"]["id"] == s.id
    r3 = c.post("/api/auth/h5-remember-login", json={"remember_token": "DEMO_ONLY_REDACTED"})
    assert r3.status_code == 401 and "重新输入" in r3.json()["detail"]


def test_HTTP_设备账号要不到凭证(db_session):
    s = _staff(db_session, role=StaffRole.CRAWLER)
    c = _client(db_session)
    token = create_access_token(s.id, s.role)
    assert c.post("/api/auth/h5-remember", headers={"Authorization": f"Bearer {token}"}).status_code == 403
