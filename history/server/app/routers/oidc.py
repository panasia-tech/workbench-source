"""统一登录：ERP 当 Authentik 的账号来源（OIDC 提供方）的几个端点。逻辑在 services/oidc_provider.py。

  GET  /api/oidc/.well-known/openid-configuration   发现文档（Authentik 登录源填这个地址自动带出其余地址）
  GET  /api/oidc/jwks                                id_token 验签公钥
  GET  /api/oidc/authorize                           员工看到的 ERP 账号登录页（服务端渲染）
  POST /api/oidc/authorize                           验 ERP 账号密码，带授权码跳回统一登录
  POST /api/oidc/token                               统一登录服务端拿授权码换令牌
  GET  /api/oidc/userinfo                            统一登录服务端读员工身份

总开关 OIDC_ENABLED 关着时全部 404；开了没配好回 503（原因只写启动日志和后台「统一登录」页，不对外说）。

登录页没有 CSRF 令牌：ERP 这边不留登录会话，伪造一次提交得不到任何东西；跳回去的授权码 Authentik 会拿
它自己会话里的 state 核对，别人塞过来的码对不上。
"""
import base64
import html
import logging
from urllib.parse import unquote_plus

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import authenticate_staff
from app.services import login_throttle, oidc_provider
from app.services.oidc_provider import AuthorizeError, AuthRequest, OidcConfig, TokenError

router = APIRouter(prefix=oidc_provider.ROUTE_PREFIX, tags=["oidc"])
log = logging.getLogger(__name__)

_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}
_PAGE_HEADERS = {
    **_NO_STORE,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    # 不写 form-action：提交后要 303 跳到统一登录的回调，form-action 会连这一跳一起拦
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
}
_UNAVAILABLE = "统一登录（ERP 账号来源）没配好，看 ERP 后台「统一登录」页或启动日志"


class _PageError(Exception):
    def __init__(self, response: HTMLResponse):
        self.response = response


def _config() -> OidcConfig:
    try:
        return oidc_provider.load_config()
    except oidc_provider.OidcDisabled as exc:
        raise HTTPException(status_code=404, detail="Not Found") from exc
    except oidc_provider.OidcMisconfigured as exc:
        raise HTTPException(status_code=503, detail=_UNAVAILABLE) from exc


def _page_config() -> OidcConfig:
    """给登录页用：出错回一张页面，不回 JSON。"""
    try:
        return oidc_provider.load_config()
    except oidc_provider.OidcDisabled as exc:
        raise _PageError(_page("页面不存在", status=404)) from exc
    except oidc_provider.OidcMisconfigured as exc:
        raise _PageError(_page("统一登录暂时不能用 ERP 账号登录，找管理员", status=503)) from exc


# ---------------------------------------------------------------- 页面

_STYLE = """
*{box-sizing:border-box}
body{margin:0;padding:16px;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#f2f4f7;font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2329}
main{width:100%;max-width:360px;padding:28px 24px;background:#fff;border-radius:10px;
box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{margin:0 0 20px;font-size:20px;font-weight:600}
label{display:block;margin-bottom:14px;font-size:13px;color:#646a73}
input{display:block;width:100%;margin-top:6px;padding:10px 12px;font-size:15px;border:1px solid #d0d3d6;
border-radius:6px;outline:none}
input:focus{border-color:#3370ff}
button{width:100%;margin-top:6px;padding:11px;font-size:15px;color:#fff;background:#3370ff;border:0;
border-radius:6px;cursor:pointer}
.error{margin:0 0 16px;padding:10px 12px;font-size:13px;color:#d83931;background:#fdecec;border-radius:6px}
"""


def _page(message: str | None = None, *, body: str = "", status: int = 200) -> HTMLResponse:
    error = f'<p class="error">{html.escape(message)}</p>' if message else ""
    doc = (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>ERP 账号登录</title><style>{_STYLE}</style></head>"
        f"<body><main><h1>ERP 账号登录</h1>{error}{body}</main></body></html>"
    )
    return HTMLResponse(doc, status_code=status, headers=_PAGE_HEADERS)


def _login_page(req: AuthRequest, *, error: str | None = None, username: str = "", status: int = 200) -> HTMLResponse:
    hidden = {
        "client_id": req.client_id,
        "redirect_uri": req.redirect_uri,
        "response_type": "code",
        "scope": req.scope,
        "state": req.state,
        "nonce": req.nonce,
        "code_challenge": req.code_challenge,
        "code_challenge_method": "S256",
    }
    fields = "".join(
        f'<input type="hidden" name="{name}" value="{html.escape(value)}">'
        for name, value in hidden.items() if value is not None
    )
    autofocus_user = "" if username else " autofocus"
    autofocus_pw = " autofocus" if username else ""
    body = (
        '<form method="post" action="authorize">'
        f'<label>账号<input name="username" value="{html.escape(username)}" autocomplete="username"'
        f' autocapitalize="none" spellcheck="false" required{autofocus_user}></label>'
        f'<label>密码<input name="password" type="password" autocomplete="current-password" required{autofocus_pw}></label>'
        f"{fields}<button type=\"submit\">登录</button></form>"
    )
    return _page(error, body=body, status=status)


def _authorize_error(exc: AuthorizeError):
    if exc.redirect_uri is None:
        # 客户端或回调地址没登记：不能往回跳，只能在这里说
        return _page(f"{exc.description}，回统一登录重新点「ERP 账号」", status=400)
    return RedirectResponse(exc.redirect_url(), status_code=303, headers=_NO_STORE)


@router.get("/authorize", summary="统一登录：ERP 账号登录页", response_class=HTMLResponse)
def authorize(request: Request):
    try:
        cfg = _page_config()
        req = oidc_provider.parse_authorize(cfg, request.query_params)
    except _PageError as exc:
        return exc.response
    except AuthorizeError as exc:
        return _authorize_error(exc)
    return _login_page(req)


@router.post("/authorize", summary="统一登录：验 ERP 账号密码，带授权码回统一登录", response_class=HTMLResponse)
def authorize_submit(
    request: Request,
    username: str = Form(""),
    password: str = Form(""),
    client_id: str = Form(""),
    redirect_uri: str = Form(""),
    response_type: str = Form(""),
    scope: str = Form(""),
    state: str = Form(""),
    nonce: str = Form(""),
    code_challenge: str = Form(""),
    code_challenge_method: str = Form(""),
    db: Session = Depends(get_db),
):
    params = {
        "client_id": client_id, "redirect_uri": redirect_uri, "response_type": response_type,
        "scope": scope, "state": state, "nonce": nonce,
        "code_challenge": code_challenge, "code_challenge_method": code_challenge_method,
    }
    try:
        cfg = _page_config()
        # 隐藏字段是浏览器交回来的，可以被改：和 GET 时一样整套重新校验
        req = oidc_provider.parse_authorize(cfg, params)
    except _PageError as exc:
        return exc.response
    except AuthorizeError as exc:
        return _authorize_error(exc)
    username = username.strip()
    if not username or not password:
        return _login_page(req, error="输入账号和密码", username=username, status=400)
    try:
        staff = authenticate_staff(db, username, password, surface="oidc", wrong_role="这个账号不能登录统一登录",
                                   ip=login_throttle.client_ip(request))
    except HTTPException as exc:
        return _login_page(req, error=str(exc.detail), username=username, status=exc.status_code)
    reason = oidc_provider.refusal(db, staff)
    if reason:
        return _login_page(req, error=reason, username=username, status=403)
    code = oidc_provider.issue_code(db, req, staff)
    log.info("统一登录：%s（%s）用 ERP 账号登录", staff.username, staff.id)
    target = oidc_provider.with_query(req.redirect_uri, {"code": code, "state": req.state})
    return RedirectResponse(target, status_code=303, headers=_NO_STORE)


# ---------------------------------------------------------------- 给统一登录服务端调的


@router.get("/.well-known/openid-configuration", summary="统一登录：OIDC 发现文档")
def openid_configuration():
    cfg = _config()
    return JSONResponse(oidc_provider.discovery(cfg), headers={"Cache-Control": "public, max-age=300"})


@router.get("/jwks", summary="统一登录：id_token 验签公钥（JWKS）")
def jwks():
    cfg = _config()
    return JSONResponse(oidc_provider.jwks(cfg), headers={"Cache-Control": "public, max-age=300"})


def _basic_credentials(request: Request) -> list[tuple[str, str]] | None:
    """Authorization: Basic 里的 (client_id, secret)。

    RFC 6749 说两段要先做表单编码，但 Authentik 用的 requests 不编码——原样和解码后的都试一下。
    没带 Basic 返回 None；带了但格式不对返回 []（按认证失败处理）。
    """
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "basic":
        return None
    try:
        decoded = base64.b64decode(value.strip(), validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return []
    cid, sep, secret = decoded.partition(":")
    if not sep:
        return []
    candidates = [(cid, secret), (unquote_plus(cid), unquote_plus(secret))]
    return list(dict.fromkeys(candidates))


def _token_error(exc: TokenError, *, basic: bool = False) -> JSONResponse:
    headers = dict(_NO_STORE)
    if exc.status == 401 and basic:
        headers["WWW-Authenticate"] = 'Basic realm="erp-oidc"'
    return JSONResponse({"error": exc.error, "error_description": exc.description},
                        status_code=exc.status, headers=headers)


@router.post("/token", summary="统一登录：授权码换令牌（统一登录服务端调）")
def token(
    request: Request,
    grant_type: str = Form(""),
    code: str = Form(""),
    redirect_uri: str = Form(""),
    code_verifier: str = Form(""),
    client_id: str = Form(""),
    client_secret: str = Form(""),
    db: Session = Depends(get_db),
):
    cfg = _config()
    basic = _basic_credentials(request)
    if basic is not None:
        candidates = basic if not client_id else [c for c in basic if c[0] == client_id]
    else:
        candidates = [(client_id, client_secret)] if client_id else []
    if not any(oidc_provider.client_authenticated(cfg, cid, secret) for cid, secret in candidates):
        return _token_error(TokenError("invalid_client", "客户端认证没过", status=401), basic=basic is not None)
    if grant_type != "authorization_code":
        return _token_error(TokenError("unsupported_grant_type", "只支持 authorization_code"))
    if not code:
        return _token_error(TokenError("invalid_request", "缺 code"))
    try:
        row, staff = oidc_provider.redeem_code(db, cfg, code=code, redirect_uri=redirect_uri,
                                               code_verifier=code_verifier)
    except TokenError as exc:
        return _token_error(exc)
    return JSONResponse(oidc_provider.issue_tokens(db, cfg, row, staff), headers=_NO_STORE)


def _userinfo(request: Request, db: Session) -> JSONResponse:
    _config()
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    staff = oidc_provider.staff_for_access_token(db, value.strip()) if scheme.lower() == "bearer" else None
    if staff is None:
        return JSONResponse(
            {"error": "invalid_token", "error_description": "令牌无效或过期"}, status_code=401,
            headers={**_NO_STORE, "WWW-Authenticate": 'Bearer error="invalid_token"'},
        )
    return JSONResponse(oidc_provider.profile_claims(db, staff), headers=_NO_STORE)


@router.get("/userinfo", summary="统一登录：读当前员工身份（OIDC userinfo）")
def userinfo(request: Request, db: Session = Depends(get_db)):
    return _userinfo(request, db)


@router.post("/userinfo", summary="统一登录：读当前员工身份（OIDC userinfo，POST）")
def userinfo_post(request: Request, db: Session = Depends(get_db)):
    return _userinfo(request, db)
