"""谁在看：员工走统一登录（OIDC，ERP 账号），外部人员带凭证；然后按资料受众判能不能看。

会话是本服务签的 cookie，只存工号、名字、角色和分组，到期重新登录。外部凭证每次签播放地址都回库查，
撤销后立刻签不出新地址；已经签出去的地址按自己的有效期失效。
"""
import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import ExternalPass, MediaItem, utcnow

SESSION_COOKIE = "DEMO_ONLY_REDACTED"
PASS_COOKIE = "DEMO_ONLY_REDACTED"
LOGIN_COOKIE = "DEMO_ONLY_REDACTED"  # 登录来回一趟用：state、nonce、PKCE、回哪


@dataclass
class Viewer:
    staff_id: str | None = None
    name: str = ""
    roles: set[str] = field(default_factory=set)  # ERP 角色 + 平台分组
    passes: list[ExternalPass] = field(default_factory=list)

    @property
    def is_staff(self) -> bool:
        return self.staff_id is not None


# ---------------------------------------------------------------- 签名 cookie


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(payload: dict, secret: str) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
    mac = _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{mac}"


def unsign(token: str | None, secret: str) -> dict | None:
    if not token or "." not in token:
        return None
    body, mac = token.rsplit(".", 1)
    expect = _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(mac, expect):
        return None
    try:
        payload = json.loads(_unb64(body))
    except ValueError:
        return None
    if payload.get("exp", 0) < time.time():
        return None
    return payload


def session_payload(s: Settings, staff_id: str, name: str, roles: set[str]) -> dict:
    return {"sub": staff_id, "name": name, "roles": sorted({r.casefold() for r in roles}), "exp": int(time.time()) + s.session_ttl_hours * 3600}


# ---------------------------------------------------------------- 外部凭证


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_pass_token() -> str:
    return "mp_" + secrets.token_urlsafe(24)


def active_pass(db: Session, token: str | None, now: datetime | None = None) -> ExternalPass | None:
    if not token:
        return None
    row = db.scalar(select(ExternalPass).where(ExternalPass.token_sha256 == hash_token(token)))
    now = now or utcnow()
    if row is None or row.revoked_at is not None or row.expires_at <= now:
        return None
    return row


def load_viewer(db: Session, s: Settings, session_cookie: str | None, pass_cookie: str | None) -> Viewer:
    v = Viewer()
    sess = unsign(session_cookie, s.session_secret)
    if sess:
        v.staff_id, v.name, v.roles = sess["sub"], sess.get("name", ""), set(sess.get("roles", []))
    p = active_pass(db, pass_cookie)
    if p:
        v.passes.append(p)
    return v


# ---------------------------------------------------------------- 受众


def can_view(item: MediaItem, viewer: Viewer, s: Settings) -> bool:
    if any(item.id in p.item_set for p in viewer.passes):
        return True
    if item.audience == "public" and item.public_confirmed_at is not None:
        return True
    if not viewer.is_staff:
        return False
    if viewer.roles & s.admin_role_set:
        return True
    if item.audience in ("public", "staff"):  # 没确认公开的宣发先只给员工看
        return True
    if item.audience == "roles":
        return bool(viewer.roles & item.role_set)
    return False  # external 只认凭证


def needs_login(item: MediaItem, viewer: Viewer, s: Settings) -> bool:
    """看不了且还没登录：去登录可能就能看了。external 资料也让员工登录（管理员要能看）。"""
    return not viewer.is_staff and not can_view(item, viewer, s)


# ---------------------------------------------------------------- OIDC


@dataclass
class OidcEndpoints:
    authorization_endpoint: str
    token_endpoint: str
    userinfo_endpoint: str


_discovery_cache: dict[str, tuple[float, OidcEndpoints]] = {}


def discover(s: Settings) -> OidcEndpoints:
    hit = _discovery_cache.get(s.oidc_issuer)
    if hit and hit[0] > time.time():
        return hit[1]
    url = s.oidc_issuer.rstrip("/") + "/.well-known/openid-configuration"
    doc = httpx.get(url, timeout=10).raise_for_status().json()
    ep = OidcEndpoints(doc["authorization_endpoint"], doc["token_endpoint"], doc["userinfo_endpoint"])
    _discovery_cache[s.oidc_issuer] = (time.time() + 3600, ep)
    return ep


def redirect_uri(s: Settings) -> str:
    return s.base_url.rstrip("/") + "/auth/callback"


def start_login(s: Settings, next_path: str) -> tuple[str, str]:
    """返回（去统一登录的地址，要种下的 LOGIN_COOKIE）。"""
    state, nonce, verifier = secrets.token_urlsafe(16), secrets.token_urlsafe(16), secrets.token_urlsafe(48)
    challenge = _b64(hashlib.sha256(verifier.encode()).digest())
    ep = discover(s)
    q = urlencode({
        "response_type": "code", "client_id": s.oidc_client_id, "redirect_uri": redirect_uri(s),
        "scope": "openid profile erp", "state": state, "nonce": nonce,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    cookie = sign({"state": state, "verifier": verifier, "next": next_path, "exp": int(time.time()) + 600},
                  s.session_secret)
    return f"{ep.authorization_endpoint}?{q}", cookie


class LoginFailed(Exception):
    pass


def finish_login(s: Settings, login_cookie: str | None, code: str, state: str) -> tuple[dict, str]:
    """拿授权码换令牌、读身份。返回（会话 payload，登录后回哪）。"""
    pending = unsign(login_cookie, s.session_secret)
    if not pending or not hmac.compare_digest(pending["state"], state):
        raise LoginFailed("登录过程过期了，重新打开链接再试一次")
    ep = discover(s)
    tok = httpx.post(ep.token_endpoint, timeout=10, data={
        "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(s),
        "code_verifier": pending["verifier"], "client_id": s.oidc_client_id, "client_secret": s.oidc_client_secret,
    })
    if tok.status_code != 200:
        raise LoginFailed("统一登录没认这次登录，重新打开链接再试一次")
    info = httpx.get(ep.userinfo_endpoint, timeout=10,
                     headers={"Authorization": f"Bearer {tok.json()['access_token']}"}).raise_for_status().json()
    # 统一登录的 sub 是它自己的散列 ID；人以 ERP 员工 ID（erp 作用域里的 erp_sub）为准，不是 ERP 的号不让进
    staff_id = str(info.get("erp_sub") or "")
    if not staff_id:
        raise LoginFailed("这个账号不是 ERP 员工账号，请用「使用 ERP 账号」登录")
    roles = set(info.get(s.oidc_groups_claim) or [])
    if info.get(s.oidc_role_claim):
        roles.add(info[s.oidc_role_claim])
    name = info.get("name") or info.get("preferred_username") or staff_id
    return session_payload(s, staff_id, name, roles), pending.get("next") or "/"
