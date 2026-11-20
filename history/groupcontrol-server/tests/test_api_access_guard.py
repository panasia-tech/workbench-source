"""群控管理接口的凭据(2026-10-06)。

起因:nginx 把 /gc/ 整段转给群控,群控自己又不验——建上下架作业、改账号、看设备
令牌这些事公网谁都能做,`/gc/devices` 直接吐出 24 台设备的令牌、IMEI、手机号。

这里钉死第一步:
  1. 只有 ERP 内部在调的接口,逐条点名必须过 require_internal_or_admin;
  2. 「本机直连」只认来源是本机、且没有 nginx 转发头的请求;
  3. 设备令牌对谁都不给;没凭据的外部请求连个人信息也抹掉(守护端还不带令牌在调);
  4. 没凭据的外部请求改账号只能解冻(守护端唯一要做的事)。
"""
import asyncio
import json
from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt

import app.auth as auth
from app.api import list_devices, router, update_account
from app.database import get_db
from app.models import Account, Device
from app.schemas import AccountUpdate, DeviceOut, DeviceWithTokenOut

SECRET = "DEMO_ONLY_REDACTED"

# 只有 ERP(本机直连)在调的接口。新加一条只有 ERP 用的管理接口,记得加进来。
ERP_ONLY = {
    ("POST", "/api/gc/debug/mem"),
    ("POST", "/api/gc/devices"),
    ("POST", "/api/gc/devices/{device_id}/self-check"),
    ("POST", "/api/gc/devices/{device_id}/restart"),
    ("POST", "/api/gc/devices/{device_id}/update-code"),
    ("PATCH", "/api/gc/devices/{device_id}"),
    ("POST", "/api/gc/accounts"),
    ("POST", "/api/gc/accounts/bind"),
    ("POST", "/api/gc/jobs"),
    ("GET", "/api/gc/jobs"),
    ("GET", "/api/gc/jobs/{job_id}"),
    ("GET", "/api/gc/listings"),
    ("POST", "/api/gc/logs/request"),
    ("GET", "/api/gc/logs"),
}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setattr(auth.settings, "jwt_secret", SECRET)


def _token(role):
    exp = datetime.utcnow() + timedelta(minutes=5)
    return jwt.encode({"sub": "staff-1", "role": role, "exp": exp}, SECRET, algorithm="HS256")


def _cred(role):
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=_token(role))


def _request(host="127.0.0.1", headers=None):
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "client": (host, 50000), "headers": raw,
                    "method": "GET", "path": "/", "query_string": b""})


INTERNAL = dict(host="127.0.0.1")
VIA_NGINX = dict(host="127.0.0.1", headers={"X-Real-IP": "127.0.0.1", "X-Forwarded-For": "127.0.0.1"})


def _dep_calls(route):
    calls, stack = set(), [route.dependant]
    while stack:
        d = stack.pop()
        if d.call is not None:
            calls.add(d.call)
        stack.extend(d.dependencies)
    return calls


def test_erp_only_routes_are_guarded():
    routes = {(m, r.path): r for r in router.routes for m in getattr(r, "methods", ())}
    missing = sorted(key for key in ERP_ONLY if key not in routes)
    assert not missing, f"路由改名了,这里在空跑: {missing}"
    ungated = sorted(f"{m} {p}" for (m, p) in ERP_ONLY
                     if auth.require_internal_or_admin not in _dep_calls(routes[(m, p)]))
    assert not ungated, f"以下接口没有凭据守卫: {ungated}"


def test_is_internal_only_trusts_loopback_without_proxy_headers():
    assert auth.is_internal(_request(**INTERNAL)) is True
    assert auth.is_internal(_request(host="::1")) is True
    # nginx 转发的请求同样来自 127.0.0.1,但一定带 X-Real-IP
    assert auth.is_internal(_request(**VIA_NGINX)) is False
    assert auth.is_internal(_request(host="127.0.0.1", headers={"X-Forwarded-For": "127.0.0.1"})) is False
    assert auth.is_internal(_request(host="127.0.0.1")) is False


def test_require_internal_or_admin():
    assert auth.require_internal_or_admin(_request(**INTERNAL), None)["role"] == "INTERNAL"
    assert auth.require_internal_or_admin(_request(**VIA_NGINX), _cred("ADMIN"))["role"] == "ADMIN"
    with pytest.raises(HTTPException) as no_cred:
        auth.require_internal_or_admin(_request(**VIA_NGINX), None)
    assert no_cred.value.status_code == 401
    with pytest.raises(HTTPException) as sales:
        auth.require_internal_or_admin(_request(**VIA_NGINX), _cred("SALES"))
    assert sales.value.status_code == 403
    bad = HTTPAuthorizationCredentials(scheme="Bearer", credentials="forged")
    with pytest.raises(HTTPException) as forged:
        auth.require_internal_or_admin(_request(**VIA_NGINX), bad)
    assert forged.value.status_code == 401


def _seed_device(db):
    db.add(Device(id="dev-1", name="红米A", token="secret-token", hw_id="k1env001", kind="browser",
                  serial="SN123", imei1="860000000000001", phone_number="00030902120",
                  xianyu_member_name="tb_123"))
    db.commit()


def test_device_token_is_never_listed(db_session):
    assert "token" not in DeviceOut.model_fields, "设备令牌是心跳与 MQTT 的凭据,只在 enroll 时交给设备本身"
    assert "token" in DeviceWithTokenOut.model_fields, "人工建设备要把令牌配到设备上,只有这一次给"
    _seed_device(db_session)
    for request, staff in ((_request(**INTERNAL), None), (_request(**VIA_NGINX), {"role": "ADMIN"})):
        [row] = list_devices(request=request, db=db_session, staff=staff)
        assert "secret-token" not in row.model_dump_json()
        assert row.imei1 == "860000000000001" and row.hw_id == "k1env001", "ERP 和管理员要看全量(账号档案按 IMEI/SN 对资产)"


def test_device_list_redacts_private_fields_without_credentials(db_session):
    _seed_device(db_session)
    [row] = list_devices(request=_request(**VIA_NGINX), db=db_session, staff=None)
    dumped = row.model_dump_json()
    for secret in ("secret-token", "860000000000001", "00030902120", "SN123", "k1env001", "tb_123"):
        assert secret not in dumped, f"没凭据的外部请求看见了 {secret}"
    assert row.id == "dev-1" and row.name == "红米A", "守护端拿它做 id→名称,这两样要留着"
    [sales] = list_devices(request=_request(**VIA_NGINX), db=db_session, staff={"role": "SALES"})
    assert sales.imei1 is None, "非管理员令牌也只给删减版"


def _seed_account(db):
    db.add(Device(id="dev-1", name="红米A", token="t"))
    db.add(Account(id="acc-1", nick="号1", device_id="dev-1", status="FROZEN"))
    db.commit()


def test_account_patch_without_credentials_can_only_unfreeze(db_session):
    _seed_account(db_session)
    outside = _request(**VIA_NGINX)
    # 守护端的「解冻」:不带令牌也照旧能用
    out = update_account("acc-1", AccountUpdate(status="ACTIVE"), request=outside, db=db_session, staff=None)
    assert out.status == "ACTIVE"
    # 换绑设备 = 把这个号的上下架派到别的机器上
    with pytest.raises(HTTPException) as moved:
        update_account("acc-1", AccountUpdate(device_id="dev-x"), request=outside, db=db_session, staff=None)
    assert moved.value.status_code == 401
    with pytest.raises(HTTPException) as frozen:
        update_account("acc-1", AccountUpdate(status="FROZEN"), request=outside, db=db_session, staff=None)
    assert frozen.value.status_code == 401, "只放行解冻这一个动作,冻结别人的号也不行"
    with pytest.raises(HTTPException) as sales:
        update_account("acc-1", AccountUpdate(nick="改名"), request=outside, db=db_session, staff={"role": "SALES"})
    assert sales.value.status_code == 403
    # ERP 本机直连、管理员令牌:照旧什么都能改
    update_account("acc-1", AccountUpdate(daily_publish_quota=5), request=_request(**INTERNAL), db=db_session, staff=None)
    out = update_account("acc-1", AccountUpdate(nick="新名"), request=outside, db=db_session, staff={"role": "ADMIN"})
    assert out.nick == "新名" and out.daily_publish_quota == 5


def _call(app, method, path, *, body=None, headers=None):
    """直接驱动 ASGI 应用(仓库不装 TestClient 要的依赖)。来源固定 127.0.0.1——
    线上 nginx 和 ERP 都从本机连群控,区别只在有没有 X-Real-IP。"""
    data = b"" if body is None else json.dumps(body).encode()
    raw = [(b"host", b"testserver")] + [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    if body is not None:
        raw += [(b"content-type", b"application/json"), (b"content-length", str(len(data)).encode())]
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
             "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
             "root_path": "", "headers": raw, "client": ("127.0.0.1", 50000), "server": ("testserver", 80)}
    sent = []

    async def receive():
        return {"type": "http.request", "body": data, "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    text = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body").decode()
    return status, text


def test_http_wiring(db_session):
    """走一遍真路由:依赖接线、请求头取法都按线上来。"""
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: db_session
    _seed_device(db_session)
    nginx = {"X-Real-IP": "127.0.0.1", "X-Forwarded-For": "127.0.0.1"}
    admin = {**nginx, "Authorization": f"Bearer {_token('ADMIN')}"}
    sales = {**nginx, "Authorization": f"Bearer {_token('SALES')}"}

    assert _call(app, "POST", "/api/gc/jobs", body={}, headers=nginx)[0] == 401
    assert _call(app, "POST", "/api/gc/devices/dev-1/restart", headers=nginx)[0] == 401
    assert _call(app, "POST", "/api/gc/accounts/bind", body={"nick": "x"}, headers=nginx)[0] == 401
    assert _call(app, "POST", "/api/gc/accounts/bind", body={"nick": "x"}, headers=sales)[0] == 403
    assert _call(app, "POST", "/api/gc/accounts/bind", body={"nick": "x"}, headers=admin)[0] == 200
    assert _call(app, "POST", "/api/gc/accounts/bind", body={"nick": "y"})[0] == 200, "ERP 本机直连照旧放行"

    status, body = _call(app, "GET", "/api/gc/devices", headers=nginx)
    assert status == 200, "守护端还不带令牌在调,不能直接 401"
    assert "secret-token" not in body and "860000000000001" not in body and "00030902120" not in body
    assert "860000000000001" in _call(app, "GET", "/api/gc/devices", headers=admin)[1]
    assert "860000000000001" in _call(app, "GET", "/api/gc/devices")[1], "ERP 本机直连要全量"
    assert "secret-token" not in _call(app, "GET", "/api/gc/devices")[1]


# ==================== 第二步:守护端/行情台在用的运维接口 ====================
# 守护端加了登录(带主 ERP 签的员工令牌)。为不打断还没更新、没登录的守护端,先以
# ops_auth_enforced=False 上线:不带令牌照常放行、记日志;都登上了再打开强制。

OPS = {
    ("GET", "/api/gc/devices"),
    ("POST", "/api/gc/devices/{device_id}/device-info"),
    ("GET", "/api/gc/tasks"),
    ("GET", "/api/gc/tasks/{task_id}"),
    ("GET", "/api/gc/tasks/{task_id}/trace"),
    ("POST", "/api/gc/tasks"),
    ("GET", "/api/gc/accounts"),
    ("PATCH", "/api/gc/accounts/{account_id}"),
    ("GET", "/api/gc/units"),
    ("POST", "/api/gc/devices/{device_id}/maintenance"),
    ("DELETE", "/api/gc/devices/{device_id}/maintenance"),
}


def test_ops_routes_are_guarded():
    routes = {(m, r.path): r for r in router.routes for m in getattr(r, "methods", ())}
    missing = sorted(key for key in OPS if key not in routes)
    assert not missing, f"路由改名了,这里在空跑: {missing}"
    ungated = sorted(f"{m} {p}" for (m, p) in OPS if auth.require_ops_access not in _dep_calls(routes[(m, p)]))
    assert not ungated, f"以下运维接口没有凭据守卫: {ungated}"


def test_require_ops_access_before_and_after_enforcement(monkeypatch, caplog):
    outside = _request(**VIA_NGINX)
    # 内部与运维角色:开没开强制都放行
    assert auth.require_ops_access(_request(**INTERNAL), None)["role"] == "INTERNAL"
    assert auth.require_ops_access(outside, {"role": "SALES"})["role"] == "SALES"

    # 没开强制:放行,并把还没登录的来源记下来(同一来源同一接口只记一条)
    monkeypatch.setattr(auth.settings, "ops_auth_enforced", False)
    auth._anon_seen.clear()
    with caplog.at_level("INFO", logger="app.auth"):
        assert auth.require_ops_access(outside, None) is None
        assert auth.require_ops_access(outside, None) is None
    assert sum("未带有效令牌" in r.message for r in caplog.records) == 1, "10 秒一轮询,不节流会刷屏"

    # 开了强制:没令牌 401(守护端据此弹登录),角色不对 403
    monkeypatch.setattr(auth.settings, "ops_auth_enforced", True)
    with pytest.raises(HTTPException) as anonymous:
        auth.require_ops_access(outside, None)
    assert anonymous.value.status_code == 401
    with pytest.raises(HTTPException) as warehouse:
        auth.require_ops_access(outside, {"role": "WAREHOUSE"})
    assert warehouse.value.status_code == 403


def test_http_ops_enforcement(db_session, monkeypatch):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: db_session
    _seed_account(db_session)
    nginx = {"X-Real-IP": "127.0.0.1"}
    sales = {**nginx, "Authorization": f"Bearer {_token('SALES')}"}

    monkeypatch.setattr(auth.settings, "ops_auth_enforced", False)
    assert _call(app, "GET", "/api/gc/units", headers=nginx)[0] == 200, "没开强制前,还没登录的守护端照常能用"

    monkeypatch.setattr(auth.settings, "ops_auth_enforced", True)
    assert _call(app, "GET", "/api/gc/units", headers=nginx)[0] == 401
    assert _call(app, "GET", "/api/gc/tasks", headers=nginx)[0] == 401
    assert _call(app, "POST", "/api/gc/tasks", body={"device_id": "dev-1", "task_type": "restart"}, headers=nginx)[0] == 401, \
        "建任务是最危险的一个:能给任意设备派任意任务"
    assert _call(app, "PATCH", "/api/gc/accounts/acc-1", body={"status": "ACTIVE"}, headers=nginx)[0] == 401, \
        "强制之后连解冻也要登录"
    assert _call(app, "GET", "/api/gc/devices", headers=nginx)[0] == 401
    assert _call(app, "GET", "/api/gc/units", headers=sales)[0] == 200, "守护端登录后(销售/采购/管理员)照常用"
    assert _call(app, "PATCH", "/api/gc/accounts/acc-1", body={"status": "ACTIVE"}, headers=sales)[0] == 200
    assert _call(app, "PATCH", "/api/gc/accounts/acc-1", body={"device_id": "x"}, headers=sales)[0] == 403, \
        "非管理员登录了也只能解冻"
    assert _call(app, "GET", "/api/gc/units")[0] == 200, "ERP 本机直连不受影响"
