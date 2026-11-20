"""gc-server 鉴权:验主 ERP 签发的 JWT(同 jwt_secret,HS256),按角色白名单放行聊天接口。
gc 是独立库(无 Staff 表),只 decode 信 claims(登录时主 ERP 已校验员工)。

2026-10-06 起管理接口也要凭据:nginx 把 /gc/ 整段转给群控,群控自己又不验,
建上下架作业、改账号、看设备令牌这些事公网谁都能做。凭据有两种——
- **本机直连**:ERP 和群控在同一台机器上,经 127.0.0.1:8100 直接调;
- **员工令牌**:经 nginx 进来的(守护端、行情台、小程序)带主 ERP 签的 JWT。

2026-10-22 起第三种凭据:**个人 API Key(wk_ 前缀,工作台签发)**——链式转发给
ERP /api/auth/me 换员工身份(见 app/personal_key.py),换到的 role 是 ERP 员工角色,
之后与 JWT 完全同一套角色判断;wk_ 通道恒定抹除机密字段(见 api.py 的 wk 抹除点)。
"""
import logging
import time

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app import personal_key
from app.config import settings

_bearer = HTTPBearer(auto_error=False)

# 能上架的角色即可看全部聊天(2026-07-17 老板拍板);其它角色 403
CHAT_ROLES = {"PURCHASER", "SALES", "ADMIN"}


def _resolve_credential(cred: HTTPAuthorizationCredentials) -> dict:
    """JWT(ERP 签发)或 wk_ 个人 key(链式 ERP 验证),统一回 {"staff_id", "role", ...}。"""
    token = cred.credentials
    if token.startswith("wk_"):
        try:
            staff = personal_key.resolve_wk_staff(token)
        except personal_key.WkUnavailable as exc:
            raise HTTPException(status_code=401, detail="身份验证服务暂时不可用") from exc
        if staff is None:
            raise HTTPException(status_code=401, detail="API Key 无效")
        return staff
    if not settings.jwt_secret:
        raise HTTPException(status_code=500, detail="jwt_secret 未配置")
    try:
        payload = jwt.decode(token, settings.jwt_secret,
                             algorithms=["HS256"], options={"require_exp": True})
    except JWTError:
        raise HTTPException(status_code=401, detail="无效令牌")
    return {"staff_id": payload.get("sub"), "role": payload.get("role")}


def get_current_staff(cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict:
    if not cred:
        raise HTTPException(status_code=401, detail="未登录")
    return _resolve_credential(cred)


def require_chat_access(user: dict = Depends(get_current_staff), request: Request = None) -> dict:
    # request 在后并允许 None:注解保持裸 Request,FastAPI 才按特殊类型注入;
    # 现有测试直接调本函数只传 user,不受影响
    if user.get("role") not in CHAT_ROLES:
        raise HTTPException(status_code=403, detail="无聊天接待权限")
    _log_wk_write(request, user)
    return user


def _log_wk_write(request: Request | None, user: dict | None) -> None:
    """个人 API Key 通道的写操作记一条审计(没有审计表,先落 journalctl)。"""
    if request is not None and (user or {}).get("via") == "wk" and request.method != "GET":
        route = getattr(request.scope.get("route"), "path", request.url.path)
        logger.info("个人key写操作 %s %s staff=%s(%s)", request.method, route,
                    user.get("staff_id"), user.get("name") or "-")


_LOOPBACK = {"127.0.0.1", "::1"}


def is_internal(request: Request) -> bool:
    """本机直连:来源是本机,且没有 nginx 加的转发头。

    nginx 转发的请求一定带 X-Real-IP——proxy_set_header 会覆盖客户端自带的同名头,
    外面伪造不了;群控又只监听 127.0.0.1。所以「本机 + 没有转发头」只可能是这台
    服务器上的进程,也就是 ERP。哪天群控改成监听 0.0.0.0 或挪进容器,这条要重审。
    """
    host = request.client.host if request.client else ""
    return (host in _LOOPBACK and "x-real-ip" not in request.headers
            and "x-forwarded-for" not in request.headers)


def optional_staff(cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict | None:
    """带了有效员工令牌(或 wk_ 个人 key)就认出来;没带或无效返回 None,不报错。

    给「有凭据给全量、没凭据给删减版」的接口用——那些接口还有不带令牌的老客户端
    (守护端)在调,直接 401 会让它们当场坏掉。
    """
    if not cred:
        return None
    token = cred.credentials
    if token.startswith("wk_"):
        try:
            return personal_key.resolve_wk_staff(token)
        except personal_key.WkUnavailable:
            return None
    if not settings.jwt_secret:
        return None
    try:
        payload = jwt.decode(token, settings.jwt_secret,
                             algorithms=["HS256"], options={"require_exp": True})
    except JWTError:
        return None
    return {"staff_id": payload.get("sub"), "role": payload.get("role")}


def is_trusted(request: Request, staff: dict | None) -> bool:
    """本机直连,或带着管理员令牌(JWT 或 wk_ 个人 key,权限相同;机密抹除另在各端点按 via 判)。"""
    return is_internal(request) or (staff or {}).get("role") == "ADMIN"


def require_internal_or_admin(request: Request,
                              cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict:
    """只有 ERP 内部在调的管理接口:本机直连放行,否则要管理员令牌。"""
    if is_internal(request):
        return {"staff_id": None, "role": "INTERNAL"}
    user = get_current_staff(cred)
    if user.get("role") != "ADMIN":
        raise HTTPException(status_code=403, detail="只有管理员能用")
    _log_wk_write(request, user)
    return user


# 能用运维接口(守护端/行情台)的角色:与主 ERP workbench-login 的放行名单一致——
# 守护端就是走那条登录的。设备账号(CRAWLER/MARKET_BOT)、仓管不在内。
OPS_ROLES = {"ADMIN", "SALES", "PURCHASER"}

logger = logging.getLogger(__name__)
_anon_seen: dict[tuple, float] = {}
_ANON_LOG_EVERY_SEC = 600


def _log_anonymous(request: Request, staff: dict | None) -> None:
    """没强制前,把还在不带令牌调的客户端记下来——同一来源同一接口 10 分钟记一条
    (守护端 10 秒轮询一次任务,不节流会把日志刷满)。打开强制之前就看这里还剩谁。"""
    route = getattr(request.scope.get("route"), "path", request.url.path)
    ip = request.headers.get("x-real-ip", "")
    key = (ip, request.method, route)
    now = time.monotonic()
    if now - _anon_seen.get(key, -_ANON_LOG_EVERY_SEC) < _ANON_LOG_EVERY_SEC:
        return
    _anon_seen[key] = now
    logger.info("运维接口未带有效令牌(尚未强制) %s %s from=%s role=%s ua=%s",
                request.method, route, ip or "-", (staff or {}).get("role") or "-",
                request.headers.get("user-agent", "")[:60])


def require_ops_access(request: Request, staff: dict | None = Depends(optional_staff)) -> dict | None:
    """守护端与行情台在用的运维接口(任务、执行单元、账号、设备列表、补设备信息)。

    本机直连或运维角色的员工令牌放行。个人 API Key(wk_)通道收紧到只有 ADMIN(2026-10-22
    老板定:员工只具备基础权限=聊天,运维读写只给管理员)。都没有时看开关
    ops_auth_enforced:没开就照常放行并记日志;开了就 401/403。
    """
    if is_internal(request):
        return {"staff_id": None, "role": "INTERNAL"}
    if staff and staff.get("via") == "wk" and staff.get("role") != "ADMIN":
        raise HTTPException(status_code=403, detail="个人 API Key 的群控运维权限只开放给管理员")
    if staff and staff.get("role") in OPS_ROLES:
        _log_wk_write(request, staff)
        return staff
    if not settings.ops_auth_enforced:
        _log_anonymous(request, staff)
        return None
    if staff:
        raise HTTPException(status_code=403, detail="这个账号没有群控权限")
    raise HTTPException(status_code=401, detail="没登录或登录已过期")
