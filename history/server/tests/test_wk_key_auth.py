"""个人 API Key（wk_ 前缀，工作台签发）当 ERP 身份凭证（deps.get_current_user 的 wk_ 分支）。

# 这里钉死的

  1. wk_ 开头才去工作台 verify，身份换回来后和 JWT 走同一套在职/未删校验；
  2. 只读：非 GET 一律 403（写操作要真登录 JWT）；
  3. verify 被拒（无效/吊销/停用）→ 401，工作台连不上也 401（不降级放行）；
  4. verify 结果有 60 秒进程内缓存（含 401 负缓存），不每次都打工作台。
"""

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.deps import get_current_user
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.services import wk_verify
from app.services.password import hash_password


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Staff.__table__])
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield session
    session.close()


@pytest.fixture(autouse=True)
def _clear_wk_cache():
    wk_verify._clear_cache()
    yield
    wk_verify._clear_cache()


def _staff(db, username="u1", role=StaffRole.PURCHASER, status=StaffStatus.ACTIVE, deleted=False):
    from datetime import datetime

    s = Staff(staff_no=f"M-{username}", name="测试", username=username,
              password_hash=hash_password("pw"), role=role, status=status,
              deleted_at=datetime.utcnow() if deleted else None)
    db.add(s)
    db.commit()
    return s


def _bearer(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def _stub_request(method: str):
    class _Req:
        pass

    req = _Req()
    req.method = method
    return req


def _ok(identity: wk_verify.WkIdentity):
    return lambda key: identity


def test_wk有效key换回本人(db, monkeypatch):
    s = _staff(db, role=StaffRole.SALES)
    monkeypatch.setattr(wk_verify, "_verify_remote", _ok(wk_verify.WkIdentity(s.id, "测试", ())))
    me = get_current_user(_bearer("wk_abc"), db, _stub_request("GET"))
    assert me.id == s.id and me.role == StaffRole.SALES


def test_wk非GET只读403(db, monkeypatch):
    s = _staff(db)
    monkeypatch.setattr(wk_verify, "_verify_remote", _ok(wk_verify.WkIdentity(s.id, "测试", ())))
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        with pytest.raises(HTTPException) as e:
            get_current_user(_bearer("wk_abc"), db, _stub_request(method))
        assert e.value.status_code == 403


def test_wk被拒绝401(db, monkeypatch):
    def _reject(key):
        raise wk_verify.WkRejected()

    monkeypatch.setattr(wk_verify, "_verify_remote", _reject)
    with pytest.raises(HTTPException) as e:
        get_current_user(_bearer("wk_bad"), db, _stub_request("GET"))
    assert e.value.status_code == 401


def test_wk工作台连不上401不降级(db, monkeypatch):
    def _down(key):
        raise wk_verify.WkUnavailable("连不上")

    monkeypatch.setattr(wk_verify, "_verify_remote", _down)
    with pytest.raises(HTTPException) as e:
        get_current_user(_bearer("wk_abc"), db, _stub_request("GET"))
    assert e.value.status_code == 401


def test_wk身份对应的员工停用401(db, monkeypatch):
    s = _staff(db, status=StaffStatus.DISABLED)
    monkeypatch.setattr(wk_verify, "_verify_remote", _ok(wk_verify.WkIdentity(s.id, "测试", ())))
    with pytest.raises(HTTPException) as e:
        get_current_user(_bearer("wk_abc"), db, _stub_request("GET"))
    assert e.value.status_code == 401


def test_wk设备账号401(db, monkeypatch):
    s = _staff(db, role=StaffRole.CRAWLER, status=StaffStatus.DISABLED)
    monkeypatch.setattr(wk_verify, "_verify_remote", _ok(wk_verify.WkIdentity(s.id, "测试", ())))
    with pytest.raises(HTTPException) as e:
        get_current_user(_bearer("wk_abc"), db, _stub_request("GET"))
    assert e.value.status_code == 401


def test_wk结果有缓存不重复打工作台(db, monkeypatch):
    calls = []

    def _counting(key):
        calls.append(key)
        return wk_verify.WkIdentity(s.id, "测试", ())

    s = _staff(db)
    monkeypatch.setattr(wk_verify, "_verify_remote", _counting)
    get_current_user(_bearer("wk_abc"), db, _stub_request("GET"))
    get_current_user(_bearer("wk_abc"), db, _stub_request("GET"))
    assert calls == ["wk_abc"]


def test_wk拒绝也有负缓存(db, monkeypatch):
    calls = []

    def _reject(key):
        calls.append(key)
        raise wk_verify.WkRejected()

    monkeypatch.setattr(wk_verify, "_verify_remote", _reject)
    for _ in range(2):
        with pytest.raises(HTTPException):
            get_current_user(_bearer("wk_bad"), db, _stub_request("GET"))
    assert calls == ["wk_bad"]


def test_非wk前缀仍走JWT(db):
    with pytest.raises(HTTPException) as e:
        get_current_user(_bearer("not-a-jwt"), db, _stub_request("GET"))
    assert e.value.status_code == 401
    assert e.value.detail == "无效令牌"
