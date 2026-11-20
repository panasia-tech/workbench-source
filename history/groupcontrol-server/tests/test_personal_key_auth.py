"""个人 API Key(wk_ 前缀,工作台签发)在群控的鉴权(2026-10-22 上线)。

链式验证:wk_ Bearer 转发给 ERP /api/auth/me 换员工身份(见 app/personal_key.py),
之后与 ERP JWT 同一套角色判断,外加两条专属规则——

# 这里钉死的

  1. wk_ 通道的运维接口(require_ops_access)只放行 ADMIN,员工(SALES/PURCHASER) 403;
     聊天接口(require_chat_access)维持 CHAT_ROLES 不变;
  2. 机密字段对 wk_ 恒定抹除,管理员也不例外(设备列表的串号/IMEI/手机号、
     执行单元的 serial、人工建设备回的 token);
  3. key 无效/吊销/停用 → 401;ERP 连不上 → 401 不降级;
  4. 验证结果 60 秒进程内缓存(含负缓存),不每次都打 ERP;
  5. JWT 与本机直连路径一字未动。
"""
import time

import pytest
from fastapi import HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt

import app.auth as auth
from app import personal_key
from app.api import list_devices
from app.config import settings
from app.models import Device

SECRET = "DEMO_ONLY_REDACTED"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setattr(settings, "jwt_secret", SECRET)
    personal_key._clear_cache()
    yield
    personal_key._clear_cache()


def _cred(token):
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def _jwt(role):
    return jwt.encode({"sub": "s1", "role": role, "exp": int(time.time()) + 600},
                      SECRET, algorithm="HS256")


def _request(method="GET", path="/api/gc/x", headers=None):
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "client": ("127.0.0.1", 50000), "headers": raw,
                    "method": method, "path": path, "query_string": b""})


VIA_NGINX = {"X-Real-IP": "127.0.0.1"}


def _wk(role="ADMIN", staff_id="s-wk"):
    return {"staff_id": staff_id, "role": role, "name": "测试", "via": "wk"}


def _patch_remote(monkeypatch, fn):
    monkeypatch.setattr(personal_key, "_resolve_remote", fn)


# ---------- 身份解析 ----------

def test_wk_有效key换回员工身份(monkeypatch):
    _patch_remote(monkeypatch, lambda token: _wk("SALES"))
    user = auth.get_current_staff(_cred("wk_abc"))
    assert user["staff_id"] == "s-wk" and user["role"] == "SALES" and user["via"] == "wk"


def test_wk_无效key_401(monkeypatch):
    _patch_remote(monkeypatch, lambda token: None)
    with pytest.raises(HTTPException) as e:
        auth.get_current_staff(_cred("wk_bad"))
    assert e.value.status_code == 401


def test_wk_ERP连不上401不降级(monkeypatch):
    def _down(token):
        raise personal_key.WkUnavailable("连不上")

    _patch_remote(monkeypatch, _down)
    with pytest.raises(HTTPException) as e:
        auth.get_current_staff(_cred("wk_abc"))
    assert e.value.status_code == 401


def test_wk_结果有缓存不重复打ERP(monkeypatch):
    calls = []

    def _counting(token):
        calls.append(token)
        return _wk()

    _patch_remote(monkeypatch, _counting)
    auth.get_current_staff(_cred("wk_abc"))
    auth.get_current_staff(_cred("wk_abc"))
    assert calls == ["wk_abc"]


def test_wk_无效也有负缓存(monkeypatch):
    calls = []

    def _reject(token):
        calls.append(token)
        return None

    _patch_remote(monkeypatch, _reject)
    for _ in range(2):
        with pytest.raises(HTTPException):
            auth.get_current_staff(_cred("wk_bad"))
    assert calls == ["wk_bad"]


# ---------- 角色门禁 ----------

@pytest.mark.parametrize("role", ["PURCHASER", "SALES", "ADMIN"])
def test_wk_聊天接口三角色放行(monkeypatch, role):
    _patch_remote(monkeypatch, lambda token: _wk(role))
    user = auth.require_chat_access(auth.get_current_staff(_cred("wk_abc")))
    assert user["role"] == role


@pytest.mark.parametrize("role", ["WAREHOUSE", "NEGOTIATOR", "FINANCE"])
def test_wk_聊天接口其它角色403(monkeypatch, role):
    _patch_remote(monkeypatch, lambda token: _wk(role))
    with pytest.raises(HTTPException) as e:
        auth.require_chat_access(auth.get_current_staff(_cred("wk_abc")))
    assert e.value.status_code == 403


def test_wk_管理接口ADMIN全通(monkeypatch):
    _patch_remote(monkeypatch, lambda token: _wk("ADMIN"))
    cred = _cred("wk_abc")
    req = _request(method="POST", headers=VIA_NGINX)
    assert auth.require_internal_or_admin(req, cred)["role"] == "ADMIN"
    assert auth.require_ops_access(req, auth.optional_staff(cred))["role"] == "ADMIN"


@pytest.mark.parametrize("guard", ["internal_or_admin", "ops"])
@pytest.mark.parametrize("role", ["PURCHASER", "SALES"])
def test_wk_员工管理接口403(monkeypatch, guard, role):
    # 员工 wk_ 只有基础权限(聊天):JWT 里 SALES 能过 ops,wk_ 里不行
    _patch_remote(monkeypatch, lambda token: _wk(role))
    cred = _cred("wk_abc")
    req = _request(method="POST", headers=VIA_NGINX)
    with pytest.raises(HTTPException) as e:
        if guard == "internal_or_admin":
            auth.require_internal_or_admin(req, cred)
        else:
            auth.require_ops_access(req, auth.optional_staff(cred))
    assert e.value.status_code == 403


def test_wk_JWT路径不受影响(monkeypatch):
    # JWT 的 SALES 依旧能过 ops(wk_ 的收紧不影响 JWT)
    _patch_remote(monkeypatch, lambda token: None)
    staff = auth.optional_staff(_cred(_jwt("SALES")))
    assert staff["role"] == "SALES" and "via" not in staff
    req = _request(method="GET", headers=VIA_NGINX)
    assert auth.require_ops_access(req, staff)["role"] == "SALES"


# ---------- 机密抹除 ----------

def _seed_device(db):
    db.add(Device(id="dev-1", name="红米A", token="secret-token", hw_id="k1env001", kind="browser",
                  serial="SN123", imei1="860000000000001", phone_number="00030902120",
                  xianyu_member_name="tb_123"))
    db.commit()


def test_wk_ADMIN设备列表仍抹除机密(db_session, monkeypatch):
    _patch_remote(monkeypatch, lambda token: _wk("ADMIN"))
    _seed_device(db_session)
    staff = auth.optional_staff(_cred("wk_abc"))
    rows = list_devices(_request(headers=VIA_NGINX), db_session, staff)
    d = rows[0]
    assert d.serial is None and d.imei1 is None and d.phone_number is None
    assert d.hw_id is None and d.xianyu_member_name is None


def test_JWT_ADMIN设备列表不抹除(db_session, monkeypatch):
    _patch_remote(monkeypatch, lambda token: None)
    _seed_device(db_session)
    staff = auth.optional_staff(_cred(_jwt("ADMIN")))
    rows = list_devices(_request(headers=VIA_NGINX), db_session, staff)
    assert rows[0].serial == "SN123"
