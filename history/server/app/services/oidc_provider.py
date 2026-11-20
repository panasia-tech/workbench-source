"""ERP 当统一登录（Authentik）的账号来源：一个最小的 OpenID Connect 提供方。

# 怎么串起来

员工在统一登录页（id.panasia.fun）点「ERP 账号」→ Authentik 带着 client_id / redirect_uri / state /
PKCE 跳到 ERP 的 /api/oidc/authorize → 在 ERP 的页面输 ERP 账号密码 → 带授权码跳回 Authentik 的回调 →
Authentik 服务端拿码到 /api/oidc/token 换 access_token 和 id_token → 再调 /api/oidc/userinfo 拿身份 →
第一次按 preferred_username 认领同步建好的号，之后按 sub 认（Authentik 自己记的源连接）。

# 只做了这些

  - 授权码 + PKCE（必须带，只收 S256）。授权码 60 秒内有效、只能换一次；同一个码再来换，连同已经
    换出去的 access_token 一起作废。
  - 只认登记过的那一个客户端（Authentik 的登录源）和登记过的回调地址，逐字比对。客户端认证 Basic 和
    表单两种都收（Authentik 登录源两种都可能用，看它的「授权码认证方式」）。
  - id_token 用 RS256 签。私钥从 .env 指的文件或内容读，没有就不启用、启动日志写清楚，不会自己生成一把
    写到哪去；kid 是公钥指纹（RFC 7638），换钥匙它就跟着变。
  - 不做：刷新令牌、隐式流程、动态注册、登出、授权确认页、ERP 这边的登录会话（每次都输密码）。

# 谁能拿到身份

在职的真人员工（enums.HUMAN_ROLES），而且同步已经在 Authentik 给他开好了号（authentik_account，用户名
对得上）。后一条是因为 Authentik 那边按用户名认领：ERP 只给同步开好号的人签发身份，被认领的就只可能是
ERP 建的号，认不到统一登录里别人的同名号上（为什么这么做见 services/authentik_sync.py 开头）。
验密码和其他登录门是同一段（routers/auth.py 的 authenticate_staff），防暴力计数也是同一套。

# 身份里有什么（userinfo 和 id_token 一样）

  sub                 员工 ID（Staff.id，永远不变；用户名在员工删除时会被改写，不能当主键）
  preferred_username  ERP 登录账号
  name                姓名
  staff_no            工号
  erp_role / erp_status  ERP 角色、账号状态（签发得出来的只会是 ACTIVE）
  groups              平台分组名（services/platform_groups.py，只发同步对上了的组）

不发 nickname：Authentik 取用户名时 nickname 比 preferred_username 优先。没有邮箱、手机号：员工表里没有
这两个字段（员工绑的手机卡是给闲鱼号用的工作卡，一人好几张，不是本人联系方式），没有就不给。
"""
import base64
import hashlib
import hmac
import json
import logging
import random
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwt
from sqlalchemy import delete, or_, update
from sqlalchemy.orm import Session

from app.config import settings
from app.enums import HUMAN_ROLES, StaffStatus
from app.models import AuthentikAccount, OidcAuthCode, Staff
from app.services import platform_groups

log = logging.getLogger(__name__)

# 接口挂在这个路径下（routers/oidc.py）；OIDC_ISSUER 的路径必须以它结尾，发现文档里的地址才走得到这里
ROUTE_PREFIX = "/api/oidc"
CODE_TTL = timedelta(seconds=60)
ACCESS_TOKEN_TTL = timedelta(minutes=10)
ID_TOKEN_TTL = timedelta(minutes=10)
MIN_CLIENT_SECRET_LEN = 24
MIN_RSA_BITS = 2048
# RFC 7636：code_verifier / S256 的 code_challenge 都是这个字符集，43~128 位
_PKCE_RE = re.compile(r"^[A-Za-z0-9\-._~]{43,128}$")
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

# 同步还没给他开号（或者用户名还没对上）时，ERP 登录页给员工看的话
NOT_SYNCED = "统一登录账号还没开通好，过几分钟再试；一直不行找管理员"


class OidcDisabled(Exception):
    """总开关没开：接口当不存在（404）。"""


class OidcMisconfigured(Exception):
    """开了但没配好：接口回 503，原因写在异常里（启动日志也写一遍）。"""


@dataclass(frozen=True)
class OidcConfig:
    issuer: str
    client_id: str
    client_secret: str
    redirect_uris: frozenset[str]
    private_key_pem: str
    kid: str
    public_jwk: tuple[tuple[str, str], ...]

    def jwk(self) -> dict:
        return dict(self.public_jwk)


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def _ts(dt: datetime) -> int:
    return int((dt - datetime(1970, 1, 1)).total_seconds())


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _uint_b64(value: int) -> str:
    return _b64url(value.to_bytes((value.bit_length() + 7) // 8, "big"))


# ---------------------------------------------------------------- 配置


def _check_url(value: str, what: str) -> str:
    """https，或者本机调试用的 http://127.0.0.1；不能带 # 片段。"""
    parts = urlsplit(value)
    local = parts.hostname in _LOCAL_HOSTS
    if not parts.netloc or parts.scheme not in ("https", "http") or (parts.scheme == "http" and not local):
        raise OidcMisconfigured(f"{what} 要是 https 地址（本机调试才允许 http://127.0.0.1）：{value}")
    if parts.fragment:
        raise OidcMisconfigured(f"{what} 不能带 #：{value}")
    return value


def _read_key_pem() -> tuple[str, str]:
    """返回 (PEM 内容, 从哪读的)。"""
    path = settings.oidc_signing_key_file.strip()
    if path:
        try:
            return Path(path).read_text(encoding="utf-8"), f"OIDC_SIGNING_KEY_FILE（{path}）"
        except OSError as exc:
            raise OidcMisconfigured(f"OIDC_SIGNING_KEY_FILE 读不了：{path}（{exc.strerror or exc}）") from exc
    inline = settings.oidc_signing_key.strip()
    if inline:
        return inline.replace("\\n", "\n"), "OIDC_SIGNING_KEY"
    raise OidcMisconfigured(
        "没配签名私钥：OIDC_SIGNING_KEY_FILE 或 OIDC_SIGNING_KEY 填一个"
        "（生成：openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out oidc-signing.pem）"
    )


@lru_cache(maxsize=4)
def _signing_key(pem: str, source: str) -> tuple[str, str, tuple[tuple[str, str], ...]]:
    """私钥 → (规整后的 PEM, kid, 公钥 JWK)。同一把钥匙只算一次。"""
    try:
        key = serialization.load_pem_private_key(pem.encode(), password=None)
    except (ValueError, TypeError) as exc:
        raise OidcMisconfigured(f"{source} 不是不带密码的 PEM 私钥：{exc}") from exc
    if not isinstance(key, rsa.RSAPrivateKey):
        raise OidcMisconfigured(f"{source} 要是 RSA 私钥（id_token 用 RS256 签）")
    if key.key_size < MIN_RSA_BITS:
        raise OidcMisconfigured(f"{source} 是 {key.key_size} 位，RSA 私钥至少 {MIN_RSA_BITS} 位")
    numbers = key.public_key().public_numbers()
    core = {"e": _uint_b64(numbers.e), "kty": "RSA", "n": _uint_b64(numbers.n)}
    # RFC 7638 指纹：只取 e/kty/n，键排好序、不留空格
    kid = _b64url(hashlib.sha256(json.dumps(core, sort_keys=True, separators=(",", ":")).encode()).digest())
    jwk = {**core, "kid": kid, "alg": "RS256", "use": "sig"}
    normalized = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    return normalized, kid, tuple(sorted(jwk.items()))


def load_config() -> OidcConfig:
    """没开 → OidcDisabled；开了没配齐 → OidcMisconfigured(缺什么)。"""
    if not settings.oidc_enabled:
        raise OidcDisabled()
    issuer = settings.oidc_issuer.strip().rstrip("/")
    if not issuer:
        raise OidcMisconfigured(f"没配 OIDC_ISSUER（例：http://127.0.0.1:8000）")
    _check_url(issuer, "OIDC_ISSUER")
    if urlsplit(issuer).query or not urlsplit(issuer).path.endswith(ROUTE_PREFIX):
        raise OidcMisconfigured(f"OIDC_ISSUER 的路径要以 {ROUTE_PREFIX} 结尾、不带查询串（接口挂在这里）：{issuer}")
    client_id = settings.oidc_client_id.strip()
    if not client_id or len(client_id) > 128:
        raise OidcMisconfigured("OIDC_CLIENT_ID 没配或超过 128 位")
    secret = settings.oidc_client_secret.strip()
    if len(secret) < MIN_CLIENT_SECRET_LEN:
        raise OidcMisconfigured(f"OIDC_CLIENT_SECRET 没配或短于 {MIN_CLIENT_SECRET_LEN} 位（openssl rand -hex 24）")
    uris = frozenset(u.strip() for u in settings.oidc_redirect_uris.split(",") if u.strip())
    if not uris:
        raise OidcMisconfigured("没配 OIDC_REDIRECT_URIS（Authentik 登录源的回调地址）")
    for uri in uris:
        _check_url(uri, "OIDC_REDIRECT_URIS 里的地址")
        if len(uri) > 512:
            raise OidcMisconfigured(f"OIDC_REDIRECT_URIS 里的地址超过 512 位：{uri[:60]}…")
    pem, source = _read_key_pem()
    private_pem, kid, jwk = _signing_key(pem, source)
    return OidcConfig(issuer, client_id, secret, uris, private_pem, kid, jwk)


def startup_check() -> None:
    """启动时调一次：开了但没配好就把原因写进日志（接口照样回 503，ERP 别的功能不受影响）。"""
    try:
        cfg = load_config()
    except OidcDisabled:
        return
    except OidcMisconfigured as exc:
        log.error("统一登录（ERP 账号来源）开了但没配好，/api/oidc 先回 503：%s", exc)
        return
    log.info("统一登录（ERP 账号来源）已启用：%s/.well-known/openid-configuration，kid=%s", cfg.issuer, cfg.kid)


def client_authenticated(cfg: OidcConfig, client_id: str, client_secret: str) -> bool:
    return hmac.compare_digest(client_id.encode(), cfg.client_id.encode()) and hmac.compare_digest(
        client_secret.encode(), cfg.client_secret.encode()
    )


def discovery(cfg: OidcConfig) -> dict:
    return {
        "issuer": cfg.issuer,
        "authorization_endpoint": f"{cfg.issuer}/authorize",
        "token_endpoint": f"{cfg.issuer}/token",
        "userinfo_endpoint": f"{cfg.issuer}/userinfo",
        "jwks_uri": f"{cfg.issuer}/jwks",
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "scopes_supported": ["openid", "profile"],
        "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
        "code_challenge_methods_supported": ["S256"],
        "claims_supported": [
            "sub", "iss", "aud", "exp", "iat", "auth_time", "nonce",
            "preferred_username", "name", "staff_no", "erp_role", "erp_status", "groups",
        ],
    }


def jwks(cfg: OidcConfig) -> dict:
    return {"keys": [cfg.jwk()]}


# ---------------------------------------------------------------- 授权请求


@dataclass(frozen=True)
class AuthRequest:
    client_id: str
    redirect_uri: str
    scope: str
    state: str | None
    nonce: str | None
    code_challenge: str


class AuthorizeError(Exception):
    """授权请求不对。

    redirect_uri 为 None：客户端或回调地址没登记，按 OAuth 的规矩不能往那跳，只能在 ERP 页面上报错；
    否则带 error / error_description / state 跳回客户端。
    """

    def __init__(self, error: str, description: str, *, redirect_uri: str | None = None, state: str | None = None):
        super().__init__(description)
        self.error = error
        self.description = description
        self.redirect_uri = redirect_uri
        self.state = state

    def redirect_url(self) -> str:
        return with_query(self.redirect_uri, {
            "error": self.error, "error_description": self.description, "state": self.state,
        })


def with_query(url: str, params: dict[str, str | None]) -> str:
    """在 url 原有的查询串后面追加参数（值为 None 的不加）。"""
    parts = urlsplit(url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    query += [(k, v) for k, v in params.items() if v is not None]
    return urlunsplit(parts._replace(query=urlencode(query)))


def parse_authorize(cfg: OidcConfig, params) -> AuthRequest:
    """校验授权请求（GET 进来的查询串，和登录页 POST 回来的隐藏字段走同一个校验）。"""
    get = lambda k: (params.get(k) or "").strip()  # noqa: E731
    client_id, redirect_uri = get("client_id"), get("redirect_uri")
    if not hmac.compare_digest(client_id.encode(), cfg.client_id.encode()):
        raise AuthorizeError("invalid_client", "这个登录链接不是统一登录发起的（客户端没登记）")
    if redirect_uri not in cfg.redirect_uris:
        raise AuthorizeError("invalid_request", "这个登录链接的回调地址没登记")
    state = params.get("state") or None

    def bad(error: str, description: str) -> AuthorizeError:
        return AuthorizeError(error, description, redirect_uri=redirect_uri, state=state)

    if state is not None and len(state) > 1024:
        raise AuthorizeError("invalid_request", "state 太长", redirect_uri=redirect_uri)
    if get("response_type") != "code":
        raise bad("unsupported_response_type", "只支持授权码（response_type=code）")
    if get("response_mode") not in ("", "query"):
        raise bad("invalid_request", "只支持 response_mode=query")
    scope = " ".join(get("scope").split())
    if "openid" not in scope.split(" "):
        raise bad("invalid_scope", "scope 里要有 openid")
    if len(scope) > 255:
        raise bad("invalid_scope", "scope 太长")
    if "none" in get("prompt").split():
        # ERP 这边没有登录会话，不输密码给不出身份
        raise bad("login_required", "要输 ERP 账号密码才能登录")
    challenge, method = get("code_challenge"), get("code_challenge_method")
    if not challenge:
        raise bad("invalid_request", "要带 PKCE（code_challenge，S256）")
    if method != "S256":
        raise bad("invalid_request", "PKCE 只收 S256")
    if not _PKCE_RE.match(challenge):
        raise bad("invalid_request", "code_challenge 格式不对")
    nonce = params.get("nonce") or None
    if nonce is not None and len(nonce) > 255:
        raise bad("invalid_request", "nonce 太长")
    return AuthRequest(client_id, redirect_uri, scope, state, nonce, challenge)


def refusal(db: Session, staff: Staff | None) -> str | None:
    """这个员工现在能不能拿到统一登录的身份；不能就返回给人看的原因。

    登录页上前三条由 authenticate_staff 先挡（话术、防暴力计数和别的门一致），这里补最后一条；
    换令牌、读 userinfo 时整套再查一遍（这几十秒里被停用了也算）。
    """
    if not staff or staff.deleted_at:
        return "账号不存在"
    if staff.role not in HUMAN_ROLES:
        return "这个账号不能登录统一登录"
    if staff.status != StaffStatus.ACTIVE:
        return "账号未激活"
    account = db.get(AuthentikAccount, staff.id)
    if account is None or account.authentik_username != staff.username:
        return NOT_SYNCED
    return None


def issue_code(db: Session, req: AuthRequest, staff: Staff) -> str:
    code = secrets.token_urlsafe(32)
    now = _now()
    db.add(OidcAuthCode(
        code_hash=_sha256(code), client_id=req.client_id, staff_id=staff.id,
        redirect_uri=req.redirect_uri, scope=req.scope, nonce=req.nonce,
        code_challenge=req.code_challenge, auth_time=now, expires_at=now + CODE_TTL,
    ))
    db.commit()
    if random.random() < 0.02:
        # 顺手清掉一天前就过期了的码和令牌，表不会越长越大
        cutoff = now - timedelta(days=1)
        db.execute(delete(OidcAuthCode).where(
            OidcAuthCode.expires_at < cutoff,
            or_(OidcAuthCode.access_expires_at.is_(None), OidcAuthCode.access_expires_at < cutoff),
        ))
        db.commit()
    return code


# ---------------------------------------------------------------- 换令牌


class TokenError(Exception):
    """按 RFC 6749 §5.2 回给客户端的错误。"""

    def __init__(self, error: str, description: str, status: int = 400):
        super().__init__(description)
        self.error = error
        self.description = description
        self.status = status


def pkce_matches(verifier: str, challenge: str) -> bool:
    if not verifier or not _PKCE_RE.match(verifier):
        return False
    return hmac.compare_digest(_b64url(hashlib.sha256(verifier.encode()).digest()), challenge)


def redeem_code(db: Session, cfg: OidcConfig, *, code: str, redirect_uri: str,
                code_verifier: str) -> tuple[OidcAuthCode, Staff]:
    """授权码 → (授权记录, 员工)。码先抢占再校验：不管后面哪一条没过，这个码都用掉了，不给第二次机会。"""
    row = db.query(OidcAuthCode).filter(OidcAuthCode.code_hash == _sha256(code or "")).first()
    if row is None or row.client_id != cfg.client_id:
        raise TokenError("invalid_grant", "授权码不对")
    now = _now()
    claimed = db.execute(
        update(OidcAuthCode).where(OidcAuthCode.id == row.id, OidcAuthCode.used_at.is_(None)).values(used_at=now)
    ).rowcount
    db.commit()
    if claimed != 1:
        # 同一个码第二次来换：码可能被截走了，先换到令牌的那一方不一定是正主，一起作废
        db.execute(
            update(OidcAuthCode).where(OidcAuthCode.id == row.id, OidcAuthCode.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        db.commit()
        log.warning("统一登录：授权码重放，已作废（staff=%s）", row.staff_id)
        raise TokenError("invalid_grant", "授权码已经用过")
    if row.expires_at < now:
        raise TokenError("invalid_grant", "授权码过期了")
    if redirect_uri != row.redirect_uri:
        raise TokenError("invalid_grant", "redirect_uri 和授权时的不一致")
    if not pkce_matches(code_verifier, row.code_challenge):
        raise TokenError("invalid_grant", "PKCE 校验没过")
    staff = db.get(Staff, row.staff_id)
    reason = refusal(db, staff)
    if reason:
        raise TokenError("invalid_grant", reason)
    return row, staff


def profile_claims(db: Session, staff: Staff) -> dict:
    return {
        "sub": staff.id,
        "preferred_username": staff.username,
        "name": staff.name or staff.username,
        "staff_no": staff.staff_no,
        "erp_role": staff.role,
        "erp_status": staff.status,
        "groups": platform_groups.groups_for_staff(db, staff),
    }


def issue_tokens(db: Session, cfg: OidcConfig, row: OidcAuthCode, staff: Staff) -> dict:
    access_token = secrets.token_urlsafe(32)
    now = _now()
    row.access_token_hash = _sha256(access_token)
    row.access_expires_at = now + ACCESS_TOKEN_TTL
    db.commit()
    claims = {
        **profile_claims(db, staff),
        "iss": cfg.issuer,
        "aud": cfg.client_id,
        "iat": _ts(now),
        "exp": _ts(now + ID_TOKEN_TTL),
        "auth_time": _ts(row.auth_time),
    }
    if row.nonce:
        claims["nonce"] = row.nonce
    id_token = jwt.encode(claims, cfg.private_key_pem, algorithm="RS256", headers={"kid": cfg.kid})
    return {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": int(ACCESS_TOKEN_TTL.total_seconds()),
        "id_token": id_token,
        "scope": row.scope,
    }


def staff_for_access_token(db: Session, token: str) -> Staff | None:
    """userinfo 用：令牌有效、没作废、没过期，员工此刻也还能登录，才返回员工。"""
    if not token:
        return None
    row = db.query(OidcAuthCode).filter(OidcAuthCode.access_token_hash == _sha256(token)).first()
    if row is None or row.revoked_at or row.access_expires_at is None or row.access_expires_at < _now():
        return None
    staff = db.get(Staff, row.staff_id)
    return None if refusal(db, staff) else staff
