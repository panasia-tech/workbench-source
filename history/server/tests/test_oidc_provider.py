"""统一登录：ERP 当 Authentik 的账号来源（/api/oidc/*，services/oidc_provider.py）。

# 这里钉死的

  1. 授权码 + PKCE 全链路：登录页 → 输 ERP 密码 → 带码跳回 → 换令牌 → id_token 能用 JWKS 验（照 Authentik
     的验法再验一遍）→ userinfo；Basic 和表单两种客户端认证都收；
  2. PKCE 必须带、只收 S256，verifier 不对换不出令牌；
  3. 回调地址、客户端没登记的不往回跳；登录页隐藏字段被改了也一样整套重新校验；
  4. 授权码 60 秒、只能换一次，重放连同已经换出去的 access_token 一起作废；
  5. 设备账号、停用、删除的员工拿不到身份；同步还没在 Authentik 开好号的也不签发（防认领到别人的同名号）；
  6. 密码错计入防暴力，锁住了正确密码也进不去（和其他登录门同一套）；
  7. groups 按平台分组出，只出同步对上了的组；不出 nickname、邮箱、手机号；
  8. 开关关着 404；开了没配好 503，启动日志写清楚缺什么；私钥不合格说清楚为什么；
  9. 每个角色都归了「人」或「设备」，统一登录的门只放人。
"""

import base64
import hashlib
import logging
import secrets
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jose import jwt as jose_jwt

from app.config import settings
from app.database import get_db
from app.enums import HUMAN_ROLES, StaffRole, StaffStatus
from app.models import AuthentikAccount, LoginThrottle, OidcAuthCode, PlatformGroup, PlatformGroupMember, Staff
from app.routers import oidc as oidc_router
from app.routers.auth import LOGIN_SURFACES
from app.services import oidc_provider
from app.services.password import hash_password

ISSUER = "https://erp.test/api/oidc"
CLIENT_ID = "authentik-erp"
SECRET = "DEMO_ONLY_REDACTED" + "x" * 32
CALLBACK = "https://id.test/source/oauth/callback/erp/"
DEVICE_ROLES = {StaffRole.RFID_DEVICE, StaffRole.CRAWLER, StaffRole.MARKET_BOT}


def _pem(key) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()


@pytest.fixture(scope="module")
def key_file(tmp_path_factory):
    path = tmp_path_factory.mktemp("oidc") / "signing.pem"
    path.write_text(_pem(rsa.generate_private_key(public_exponent=65537, key_size=2048)))
    return str(path)


@pytest.fixture()
def oidc(monkeypatch, key_file):
    monkeypatch.setattr(settings, "oidc_enabled", True)
    monkeypatch.setattr(settings, "oidc_issuer", ISSUER)
    monkeypatch.setattr(settings, "oidc_client_id", CLIENT_ID)
    monkeypatch.setattr(settings, "oidc_client_secret", SECRET)
    monkeypatch.setattr(settings, "oidc_redirect_uris", f"{CALLBACK}, https://id.test/other/")
    monkeypatch.setattr(settings, "oidc_signing_key_file", key_file)
    monkeypatch.setattr(settings, "oidc_signing_key", "")
    monkeypatch.setattr(settings, "login_throttle_enabled", True)


@pytest.fixture()
def client(db_session, oidc):
    app = FastAPI()
    app.include_router(oidc_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(app, follow_redirects=False)


def _staff(db, username="zhangsan", role=StaffRole.SALES, password="DEMO_ONLY_REDACTED", status=StaffStatus.ACTIVE,
           name="张三", synced=True):
    s = Staff(staff_no=f"E-{username}", name=name, username=username,
              password_hash=hash_password(password), role=role, status=status)
    db.add(s)
    db.commit()
    if synced:
        db.add(AuthentikAccount(staff_id=s.id, authentik_pk=100, authentik_username=username,
                                synced_at=datetime.utcnow()))
        db.commit()
    return s


def _group(db, name, roles=(), members=(), synced=True):
    g = PlatformGroup(name=name, roles=list(roles),
                      authentik_pk=f"pk-{name}" if synced else None, authentik_name=name if synced else None)
    db.add(g)
    db.commit()
    for staff in members:
        db.add(PlatformGroupMember(group_id=g.id, staff_id=staff.id))
    db.commit()
    return g


def _pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def _params(challenge, **overrides):
    p = {
        "client_id": CLIENT_ID, "redirect_uri": CALLBACK, "response_type": "code",
        "scope": "openid email profile", "state": "st-1", "nonce": "n-1",
        "code_challenge": challenge, "code_challenge_method": "S256",
    }
    p.update(overrides)
    return {k: v for k, v in p.items() if v is not None}


def _login(client, params, username="zhangsan", password="DEMO_ONLY_REDACTED"):
    return client.post("/api/oidc/authorize", data={**params, "username": username, "password": password})


def _query(resp) -> dict:
    assert resp.status_code == 303, resp.text
    loc = resp.headers["location"]
    assert loc.startswith(CALLBACK)
    return {k: v[0] for k, v in parse_qs(urlsplit(loc).query).items()}


def _code(client, username="zhangsan", password="DEMO_ONLY_REDACTED"):
    verifier, challenge = _pkce()
    q = _query(_login(client, _params(challenge), username, password))
    assert q["state"] == "st-1"
    return q["code"], verifier


def _token(client, code, verifier, *, auth="basic", secret=SECRET, redirect_uri=CALLBACK):
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri, "code_verifier": verifier}
    if auth == "basic":
        return client.post("/api/oidc/token", data=data, auth=(CLIENT_ID, secret))
    return client.post("/api/oidc/token", data={**data, "client_id": CLIENT_ID, "client_secret": secret})


def _userinfo(client, access_token):
    return client.get("/api/oidc/userinfo", headers={"Authorization": f"Bearer {access_token}"})


# --- 1. 全链路 ------------------------------------------------------------------
def test_发现文档的地址都在issuer下(client):
    doc = client.get("/api/oidc/.well-known/openid-configuration").json()
    assert doc["issuer"] == ISSUER
    for key, tail in [("authorization_endpoint", "/authorize"), ("token_endpoint", "/token"),
                      ("userinfo_endpoint", "/userinfo"), ("jwks_uri", "/jwks")]:
        assert doc[key] == ISSUER + tail
    assert doc["code_challenge_methods_supported"] == ["S256"]
    assert doc["id_token_signing_alg_values_supported"] == ["RS256"]
    assert set(doc["token_endpoint_auth_methods_supported"]) == {"client_secret_basic", "client_secret_post"}


def test_完整走一遍授权码流程_id_token能用JWKS验(client, db_session):
    staff = _staff(db_session)
    _group(db_session, "销售", roles=[StaffRole.SALES])
    verifier, challenge = _pkce()

    page = client.get("/api/oidc/authorize", params=_params(challenge))
    assert page.status_code == 200
    assert 'name="password"' in page.text and challenge in page.text and 'value="st-1"' in page.text

    q = _query(_login(client, _params(challenge)))
    assert q["state"] == "st-1" and q["code"]
    resp = _token(client, q["code"], verifier)
    assert resp.status_code == 200, resp.text
    assert resp.headers["cache-control"] == "no-store"
    tokens = resp.json()
    assert tokens["token_type"] == "Bearer" and tokens["access_token"] and tokens["expires_in"] > 0

    jwks = client.get("/api/oidc/jwks").json()
    claims = jose_jwt.decode(tokens["id_token"], jwks["keys"][0], algorithms=["RS256"],
                             audience=CLIENT_ID, issuer=ISSUER)
    assert claims["sub"] == staff.id
    assert claims["preferred_username"] == "zhangsan" and claims["name"] == "张三"
    assert claims["staff_no"] == "E-zhangsan" and claims["groups"] == ["销售"]
    assert claims["nonce"] == "n-1" and claims["auth_time"] <= claims["iat"] < claims["exp"]

    # Authentik 登录源 userinfo 拿不到时的兜底验法：PyJWKSet + 按 kid 挑钥匙 + 只验 aud
    pyjwt = pytest.importorskip("jwt")
    header = pyjwt.get_unverified_header(tokens["id_token"])
    key = [k for k in pyjwt.PyJWKSet.from_dict(jwks).keys if k.key_id == header["kid"]][0]
    assert pyjwt.decode(tokens["id_token"], key=key, algorithms=[header["alg"]], audience=CLIENT_ID,
                        options={"verify_iss": False})["sub"] == staff.id

    info = _userinfo(client, tokens["access_token"])
    assert info.status_code == 200
    assert info.json() == {k: claims[k] for k in info.json()}
    assert info.json()["sub"] == staff.id


def test_表单方式的客户端认证也收(client, db_session):
    _staff(db_session)
    code, verifier = _code(client)
    assert _token(client, code, verifier, auth="post").status_code == 200


def test_不发nickname_没有邮箱手机号(client, db_session):
    """Authentik 取用户名 nickname 比 preferred_username 优先；员工表没有邮箱、本人手机号。"""
    _staff(db_session)
    code, verifier = _code(client)
    info = _userinfo(client, _token(client, code, verifier).json()["access_token"]).json()
    assert set(info) == {"sub", "preferred_username", "name", "staff_no", "erp_role", "erp_status", "groups"}
    assert info["erp_status"] == StaffStatus.ACTIVE


# --- 2. PKCE --------------------------------------------------------------------
def test_PKCE不对换不出令牌_码也作废(client, db_session):
    _staff(db_session)
    code, verifier = _code(client)
    bad = _token(client, code, _pkce()[0])
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_grant"
    assert _token(client, code, verifier).json()["error"] == "invalid_grant", "试错过一次的码不再给第二次机会"


@pytest.mark.parametrize("overrides", [
    {"code_challenge": None, "code_challenge_method": None},
    {"code_challenge_method": "plain"},
    {"code_challenge": "short"},
])
def test_不带PKCE或不是S256直接打回(client, overrides):
    _, challenge = _pkce()
    q = _query(client.get("/api/oidc/authorize", params=_params(challenge, **overrides)))
    assert q["error"] == "invalid_request" and q["state"] == "st-1"


@pytest.mark.parametrize("overrides,error", [
    ({"response_type": "token"}, "unsupported_response_type"),
    ({"scope": "profile"}, "invalid_scope"),
    ({"prompt": "none"}, "login_required"),
])
def test_别的不合规请求带错误跳回(client, overrides, error):
    _, challenge = _pkce()
    assert _query(client.get("/api/oidc/authorize", params=_params(challenge, **overrides)))["error"] == error


# --- 3. 回调地址 / 客户端 -----------------------------------------------------------
@pytest.mark.parametrize("overrides", [
    {"redirect_uri": "https://evil.example/cb"},
    {"redirect_uri": CALLBACK + "x"},
    {"redirect_uri": None},
    {"client_id": "someone-else"},
])
def test_回调地址或客户端没登记_不往回跳(client, db_session, overrides):
    _staff(db_session)
    _, challenge = _pkce()
    page = client.get("/api/oidc/authorize", params=_params(challenge, **overrides))
    assert page.status_code == 400 and "location" not in page.headers
    # 登录页的隐藏字段被改成别的回调地址再提交：同样不跳、不发码
    posted = _login(client, _params(challenge, **overrides))
    assert posted.status_code == 400 and "location" not in posted.headers
    assert db_session.query(OidcAuthCode).count() == 0


def test_token的redirect_uri要和授权时一致(client, db_session):
    _staff(db_session)
    code, verifier = _code(client)
    resp = _token(client, code, verifier, redirect_uri="https://id.test/other/")
    assert resp.json()["error"] == "invalid_grant"


# --- 4. 授权码一次性 / 短时效 ---------------------------------------------------------
def test_授权码只能用一次_重放连已发的令牌一起作废(client, db_session):
    _staff(db_session)
    code, verifier = _code(client)
    first = _token(client, code, verifier).json()
    assert _userinfo(client, first["access_token"]).status_code == 200
    again = _token(client, code, verifier)
    assert again.status_code == 400 and again.json()["error"] == "invalid_grant"
    revoked = _userinfo(client, first["access_token"])
    assert revoked.status_code == 401 and "invalid_token" in revoked.headers["www-authenticate"]


def test_授权码60秒过期(client, db_session, monkeypatch):
    _staff(db_session)
    code, verifier = _code(client)
    later = datetime.utcnow() + timedelta(seconds=61)
    monkeypatch.setattr(oidc_provider, "_now", lambda: later.replace(microsecond=0))
    resp = _token(client, code, verifier)
    assert resp.json()["error"] == "invalid_grant" and "过期" in resp.json()["error_description"]


def test_access_token过期_userinfo不给(client, db_session, monkeypatch):
    _staff(db_session)
    code, verifier = _code(client)
    access = _token(client, code, verifier).json()["access_token"]
    later = datetime.utcnow() + timedelta(minutes=11)
    monkeypatch.setattr(oidc_provider, "_now", lambda: later.replace(microsecond=0))
    assert _userinfo(client, access).status_code == 401


def test_客户端密钥不对(client, db_session):
    _staff(db_session)
    code, verifier = _code(client)
    resp = _token(client, code, verifier, secret="DEMO_ONLY_REDACTED" + "y" * 30)
    assert resp.status_code == 401 and resp.json()["error"] == "invalid_client"
    assert resp.headers["www-authenticate"].startswith("Basic")
    nobody = client.post("/api/oidc/token", data={"grant_type": "authorization_code", "code": code})
    assert nobody.status_code == 401
    assert _token(client, code, verifier).status_code == 200, "客户端认证没过不算用过这个码"


# --- 5. 谁能拿到身份 --------------------------------------------------------------
@pytest.mark.parametrize("role", sorted(DEVICE_ROLES))
def test_设备账号拿不到身份(client, db_session, role):
    _staff(db_session, role=role)
    _, challenge = _pkce()
    resp = _login(client, _params(challenge))
    assert resp.status_code == 403 and "location" not in resp.headers
    assert "不能登录统一登录" in resp.text


@pytest.mark.parametrize("status", [StaffStatus.DISABLED, StaffStatus.PENDING])
def test_停用的员工拿不到身份(client, db_session, status):
    _staff(db_session, status=status)
    _, challenge = _pkce()
    resp = _login(client, _params(challenge))
    assert resp.status_code == 403 and "未激活" in resp.text and "location" not in resp.headers


def test_删除的员工当不存在(client, db_session):
    s = _staff(db_session)
    s.deleted_at = datetime.utcnow()
    db_session.commit()
    _, challenge = _pkce()
    resp = _login(client, _params(challenge))
    assert resp.status_code == 400 and "账号或密码错误" in resp.text


def test_同步还没开好号的员工不签发(client, db_session):
    """Authentik 按用户名认领同步建的号：没开好号就签发，可能被认领到统一登录里别人的同名号上。"""
    _staff(db_session, username="akadmin", synced=False)
    _, challenge = _pkce()
    resp = _login(client, _params(challenge), username="akadmin")
    assert resp.status_code == 403 and "还没开通" in resp.text and "location" not in resp.headers


def test_开好的号用户名对不上也不签发(client, db_session):
    s = _staff(db_session)
    db_session.get(AuthentikAccount, s.id).authentik_username = "zhangsan__old"
    db_session.commit()
    _, challenge = _pkce()
    assert _login(client, _params(challenge)).status_code == 403


def test_换完令牌员工被停用_userinfo不再给(client, db_session):
    s = _staff(db_session)
    code, verifier = _code(client)
    access = _token(client, code, verifier).json()["access_token"]
    s.status = StaffStatus.DISABLED
    db_session.commit()
    assert _userinfo(client, access).status_code == 401


def test_拿到码之后被停用_换不出令牌(client, db_session):
    s = _staff(db_session)
    code, verifier = _code(client)
    s.status = StaffStatus.DISABLED
    db_session.commit()
    assert _token(client, code, verifier).json()["error"] == "invalid_grant"


# --- 6. 防暴力 ----------------------------------------------------------------------
def test_密码错计入防暴力_锁住了正确密码也进不去(client, db_session):
    _staff(db_session)
    _, challenge = _pkce()
    for _ in range(5):
        resp = _login(client, _params(challenge), password="DEMO_ONLY_REDACTED")
        assert resp.status_code == 400 and "账号或密码错误" in resp.text
    locked = _login(client, _params(challenge))
    assert locked.status_code == 429 and "分钟后再试" in locked.text and "location" not in locked.headers
    assert db_session.query(LoginThrottle).filter(LoginThrottle.scope == "pair").count() == 1


def test_没填账号密码不算一次尝试(client, db_session):
    _staff(db_session)
    _, challenge = _pkce()
    resp = _login(client, _params(challenge), password="")
    assert resp.status_code == 400 and db_session.query(LoginThrottle).count() == 0


# --- 7. groups --------------------------------------------------------------------
def test_userinfo的groups按映射出_只出同步对上了的(client, db_session):
    s = _staff(db_session)
    _group(db_session, "销售", roles=[StaffRole.SALES])
    _group(db_session, "工作台老板", members=[s])
    _group(db_session, "采购", roles=[StaffRole.PURCHASER])
    _group(db_session, "新建还没同步", roles=[StaffRole.SALES], synced=False)
    renamed = _group(db_session, "改名前", roles=[StaffRole.SALES])
    renamed.name = "改名后还没同步"
    db_session.commit()
    code, verifier = _code(client)
    info = _userinfo(client, _token(client, code, verifier).json()["access_token"]).json()
    assert info["groups"] == ["工作台老板", "销售"]


# --- 8. 开关 / 配置 -------------------------------------------------------------------
def test_开关关着全部404(client, monkeypatch):
    monkeypatch.setattr(settings, "oidc_enabled", False)
    assert client.get("/api/oidc/.well-known/openid-configuration").status_code == 404
    assert client.get("/api/oidc/jwks").status_code == 404
    assert client.get("/api/oidc/authorize").status_code == 404
    assert client.post("/api/oidc/token", data={}).status_code == 404


def test_开了没配私钥_回503_启动日志写清楚(client, monkeypatch, caplog):
    monkeypatch.setattr(settings, "oidc_signing_key_file", "")
    assert client.get("/api/oidc/.well-known/openid-configuration").status_code == 503
    _, challenge = _pkce()
    assert client.get("/api/oidc/authorize", params=_params(challenge)).status_code == 503
    with caplog.at_level(logging.ERROR, logger="app.services.oidc_provider"):
        oidc_provider.startup_check()
    assert "OIDC_SIGNING_KEY_FILE" in caplog.text and "openssl genpkey" in caplog.text


@pytest.mark.parametrize("make,expect", [
    (lambda: _pem(rsa.generate_private_key(public_exponent=65537, key_size=1024)), "至少 2048"),
    (lambda: _pem(ec.generate_private_key(ec.SECP256R1())), "要是 RSA"),
    (lambda: "not a key", "不是不带密码的 PEM 私钥"),
])
def test_私钥不合格说清楚(oidc, monkeypatch, tmp_path, make, expect):
    path = tmp_path / "bad.pem"
    path.write_text(make())
    monkeypatch.setattr(settings, "oidc_signing_key_file", str(path))
    with pytest.raises(oidc_provider.OidcMisconfigured, match=expect):
        oidc_provider.load_config()


def test_私钥文件不存在说清楚路径(oidc, monkeypatch):
    monkeypatch.setattr(settings, "oidc_signing_key_file", "/nowhere/oidc.pem")
    with pytest.raises(oidc_provider.OidcMisconfigured, match="/nowhere/oidc.pem"):
        oidc_provider.load_config()


def test_私钥也能直接填内容_kid是公钥指纹(oidc, monkeypatch, key_file):
    from_file = oidc_provider.load_config().kid
    monkeypatch.setattr(settings, "oidc_signing_key_file", "")
    monkeypatch.setattr(settings, "oidc_signing_key", open(key_file).read().replace("\n", "\\n"))
    assert oidc_provider.load_config().kid == from_file, "同一把钥匙 kid 不变（两个 worker、重启都一样）"
    monkeypatch.setattr(settings, "oidc_signing_key", _pem(rsa.generate_private_key(65537, 2048)))
    assert oidc_provider.load_config().kid != from_file, "换钥匙 kid 跟着变"


@pytest.mark.parametrize("name,value,expect", [
    ("oidc_client_secret", "short", "短于"),
    ("oidc_redirect_uris", "", "OIDC_REDIRECT_URIS"),
    ("oidc_redirect_uris", "http://id.test/cb", "https"),
    ("oidc_issuer", "https://erp.test/oidc", "/api/oidc"),
    ("oidc_client_id", "c" * 129, "128"),
    ("oidc_redirect_uris", "https://id.test/" + "x" * 600, "512"),
])
def test_配置不对说清楚(oidc, monkeypatch, name, value, expect):
    monkeypatch.setattr(settings, name, value)
    with pytest.raises(oidc_provider.OidcMisconfigured, match=expect):
        oidc_provider.load_config()


# --- 9. 角色归类 --------------------------------------------------------------------
def test_每个角色都归了类_统一登录的门只放人():
    """新加角色这里会红：想清楚它是人还是设备，人就加进 enums.HUMAN_ROLES。"""
    assert set(StaffRole) == set(HUMAN_ROLES) | DEVICE_ROLES
    assert not set(HUMAN_ROLES) & DEVICE_ROLES
    assert set(LOGIN_SURFACES["oidc"]) == set(HUMAN_ROLES)
    machine = set(LOGIN_SURFACES["crawler"]) | set(LOGIN_SURFACES["device"])
    assert not set(LOGIN_SURFACES["oidc"]) & machine


# --- 页面本身 ------------------------------------------------------------------------
def test_登录页把带进来的参数转义_带安全头(client):
    _, challenge = _pkce()
    page = client.get("/api/oidc/authorize", params=_params(challenge, state='"><script>alert(1)</script>'))
    assert page.status_code == 200
    assert "<script>alert(1)" not in page.text and "&lt;script&gt;" in page.text
    assert page.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert page.headers["cache-control"] == "no-store"
