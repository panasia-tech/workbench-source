"""登录防暴力尝试（app/services/login_throttle.py）。

# 这里钉死的

  1. 同账号同 IP 错 5 次就锁，锁着连正确密码也进不去；换个 IP 的人不受影响
  2. 锁住的提示对「账号存在」和「账号不存在」一模一样，不能借锁枚举用户名
  3. 登录成功清计数；锁到期自动放开；再犯锁的时间翻倍
  4. 撞库（一个 IP 撞一批不存在的账号）锁 IP；
     但同一个 IP 上一台机器反复输错一个真账号，不能把这个 IP 上的其他人锁在外面（办公室共用出口）
  5. 换着 IP 猜同一个账号，账号那把尺子兜底
  6. 拿不准 IP 时不按 IP 锁；直连 8000 时不信请求头里的 IP
  7. 开关关掉就不拦
  8. 真走一遍 HTTP：FastAPI 确实把 Request 注进来了，429 的返回体是 detail
  9. 并发：一口气同时打进来的请求，超出额度的那几个在验密码之前就被挡掉
 10. 计数表本身出意外时放行登录，不能让所有人都登不上
"""

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.config import settings
from app.database import get_db
from app.enums import StaffRole, StaffStatus
from app.models import LoginThrottle, Staff
from app.routers import auth
from app.services import login_throttle
from app.services.password import hash_password


class Clock:
    def __init__(self):
        self.t = datetime(2026, 10, 6, 12, 0, 0)

    def __call__(self):
        return self.t

    def tick(self, **kw):
        self.t += timedelta(**kw)


@pytest.fixture()
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(login_throttle, "_now", c)
    monkeypatch.setattr(settings, "login_throttle_enabled", True)
    return c


def _staff(db, username="u1", password="DEMO_ONLY_REDACTED", role=StaffRole.WAREHOUSE):
    s = Staff(staff_no=f"T-{username}", name="测试", username=username,
              password_hash=hash_password(password), role=role, status=StaffStatus.ACTIVE)
    db.add(s)
    db.commit()
    return s


def _login(db, username="u1", password="DEMO_ONLY_REDACTED", ip="127.0.0.1"):
    return auth._password_login(db, username, password, surface="h5",
                                wrong_role="x", with_tabs=True, ip=ip)


def _fail(db, n, **kw):
    for _ in range(n):
        with pytest.raises(HTTPException) as exc:
            _login(db, password="DEMO_ONLY_REDACTED", **kw)
        assert exc.value.status_code == 400


def _status(db, **kw):
    try:
        _login(db, **kw)
        return 200
    except HTTPException as e:
        return e.status_code


# --- 1. 主力那把尺子 ---------------------------------------------------------
def test_同账号同IP错5次就锁_正确密码也进不去(db_session, clock):
    _staff(db_session)
    _fail(db_session, 5)
    with pytest.raises(HTTPException) as exc:
        _login(db_session)
    assert exc.value.status_code == 429
    assert "15 分钟后再试" in exc.value.detail


def test_换个IP的人不受影响(db_session, clock):
    _staff(db_session)
    _fail(db_session, 5, ip="127.0.0.1")
    assert _status(db_session, ip="127.0.0.1") == 200


def test_错4次还能进(db_session, clock):
    _staff(db_session)
    _fail(db_session, 4)
    assert _status(db_session) == 200


# --- 2. 不能借锁枚举用户名 ----------------------------------------------------
def test_锁的提示不分账号存不存在(db_session, clock):
    _staff(db_session, username="real")
    _fail(db_session, 5, username="real")
    _fail(db_session, 5, username="ghost")
    with pytest.raises(HTTPException) as real:
        _login(db_session, username="real", password="DEMO_ONLY_REDACTED")
    with pytest.raises(HTTPException) as ghost:
        _login(db_session, username="ghost", password="DEMO_ONLY_REDACTED")
    assert real.value.status_code == ghost.value.status_code == 429
    assert real.value.detail == ghost.value.detail


# --- 3. 清零 / 到期 / 翻倍 ------------------------------------------------------
def test_登录成功清计数(db_session, clock):
    _staff(db_session)
    _fail(db_session, 4)
    assert _status(db_session) == 200
    _fail(db_session, 4)
    assert _status(db_session) == 200


def test_锁到期自动放开_再犯翻倍(db_session, clock):
    _staff(db_session)
    _fail(db_session, 5)
    clock.tick(minutes=14)
    assert _status(db_session) == 429
    clock.tick(minutes=2)
    _fail(db_session, 5)  # 放开后又错满 5 次
    with pytest.raises(HTTPException) as exc:
        _login(db_session)
    assert "30 分钟后再试" in exc.value.detail, "第二次锁要翻倍"


def test_一天没再犯_翻倍从头算(db_session, clock):
    _staff(db_session)
    _fail(db_session, 5)
    clock.tick(hours=25)
    _fail(db_session, 5)
    with pytest.raises(HTTPException) as exc:
        _login(db_session)
    assert "15 分钟后再试" in exc.value.detail


# --- 4. 撞库锁 IP，但办公室不连坐 ---------------------------------------------
def test_一个IP撞一批不存在的账号_锁IP(db_session, clock):
    _staff(db_session, username="boss", password="DEMO_ONLY_REDACTED")
    for i in range(20):
        with pytest.raises(HTTPException):
            _login(db_session, username=f"ghost{i}", password="DEMO_ONLY_REDACTED", ip="127.0.0.1")
    assert _status(db_session, username="boss", password="DEMO_ONLY_REDACTED", ip="127.0.0.1") == 429
    assert _status(db_session, username="boss", password="DEMO_ONLY_REDACTED", ip="127.0.0.1") == 200


def test_一台机器反复输错一个真账号_不连累同IP的其他人(db_session, clock):
    """办公室共用一个出口 IP。某台执行端配错密码一直重试，只该锁它自己那一对。"""
    _staff(db_session, username="bot", password="DEMO_ONLY_REDACTED")
    _staff(db_session, username="alice", password="DEMO_ONLY_REDACTED")
    for _ in range(10):
        clock.tick(minutes=16)  # 每次锁到期又来一轮
        for _ in range(5):
            with pytest.raises(HTTPException):
                _login(db_session, username="bot", password="DEMO_ONLY_REDACTED", ip="127.0.0.1")
    assert _status(db_session, username="alice", password="DEMO_ONLY_REDACTED", ip="127.0.0.1") == 200


# --- 5. 换着 IP 猜一个账号 ------------------------------------------------------
def test_换着IP猜同一个账号_账号尺子兜底(db_session, clock):
    _staff(db_session, username="target")
    for i in range(30):
        with pytest.raises(HTTPException):
            _login(db_session, username="target", password="DEMO_ONLY_REDACTED", ip=f"10.0.0.{i}")
    assert _status(db_session, username="target", ip="127.0.0.1") == 429


# --- 6. IP 认定 ----------------------------------------------------------------
def test_拿不准IP时不按IP锁(db_session, clock):
    _staff(db_session)
    _fail(db_session, 5, ip=None)
    assert _status(db_session, ip=None) == 200, "IP 不明时只剩账号尺子（30 次），5 次不该锁"
    assert db_session.query(LoginThrottle).filter(LoginThrottle.scope != "user").count() == 0


def _req(peer, headers=None):
    return SimpleNamespace(client=SimpleNamespace(host=peer) if peer else None, headers=headers or {})


def test_经本机nginx转发_用X_Real_IP():
    assert login_throttle.client_ip(_req("127.0.0.1", {"x-real-ip": "127.0.0.1"})) == "127.0.0.1"


def test_直连时不信请求头():
    assert login_throttle.client_ip(_req("127.0.0.1", {"x-real-ip": "127.0.0.1"})) == "127.0.0.1"


def test_本机来的又没带头_当不知道():
    assert login_throttle.client_ip(_req("127.0.0.1")) is None
    assert login_throttle.client_ip(None) is None


# --- 9. 并发 --------------------------------------------------------------------
def test_同时打进来的请求_超出额度的验不到密码(db_session, clock):
    """并发时 6 个请求都过了「查锁」、都还没验完密码：先记数，第 6 个必须进不去。"""
    _staff(db_session)
    for _ in range(5):
        login_throttle.admit(db_session, "u1", "1.1.1.1", known=True)
    with pytest.raises(HTTPException) as exc:
        login_throttle.admit(db_session, "u1", "1.1.1.1", known=True)
    assert exc.value.status_code == 429


# --- 10. 计数表出意外 ------------------------------------------------------------
def test_计数表出意外时放行登录(db_session, clock, monkeypatch):
    from sqlalchemy.exc import OperationalError

    def boom(*a, **k):
        raise OperationalError("SELECT 1", {}, Exception("table missing"))

    monkeypatch.setattr(login_throttle, "_raise_if_locked", boom)
    monkeypatch.setattr(login_throttle, "_bump", boom)
    _staff(db_session)
    assert _status(db_session) == 200
    _fail(db_session, 1)


# --- 7. 开关 --------------------------------------------------------------------
def test_开关关掉就不拦(db_session, clock, monkeypatch):
    monkeypatch.setattr(settings, "login_throttle_enabled", False)
    _staff(db_session)
    _fail(db_session, 8)
    assert _status(db_session) == 200


# --- 8. 真走 HTTP --------------------------------------------------------------
def test_HTTP_注入Request_429带detail(db_session, clock):
    _staff(db_session)
    app = FastAPI()
    app.include_router(auth.router)
    app.dependency_overrides[get_db] = lambda: db_session
    client = TestClient(app)
    for _ in range(5):
        r = client.post("/api/auth/h5-login", json={"username": "u1", "password": "DEMO_ONLY_REDACTED"})
        assert r.status_code == 400
    r = client.post("/api/auth/h5-login", json={"username": "u1", "password": "DEMO_ONLY_REDACTED"})
    assert r.status_code == 429
    assert "分钟后再试" in r.json()["detail"]
    # 这些计数确实是按 IP 记的（TestClient 的对端是 testclient，不是本机）
    assert db_session.query(LoginThrottle).filter(LoginThrottle.scope == "pair").count() == 1
