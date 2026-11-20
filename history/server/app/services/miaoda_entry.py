"""员工工作台免登录进 H5：拿一次性 entry_token 去工作台换员工身份。

工作台用 iframe 打开 http://127.0.0.1:8000，H5 把 token 交给
/api/auth/miaoda-entry，这里再去工作台的 verify 端点换 miaodaUserId / erpUserId / erpVerified。
调用必须在服务端：key（.env 的 ERP_BRIDGE_API_KEY）只授权 verify 这一条路由，不能出现在浏览器里。
token 只能成功换一次、60 秒内有效，所以收到就换，不缓存、不重试。

erpUserId 是工作台「ERP 账号绑定」里填的，妙搭时期是员工自己填、没校验过，只当"他说他是谁"，真正放行看
miaoda_binding（本人输过一次 ERP 密码）。工作台搬出妙搭后员工用 ERP 账号从统一登录登进工作台，工作台用户 ID
就是 ERP 员工 ID；工作台能担保的时候在 verify 里回 erpVerified=true（只认 JSON 的 true，没有这个字段、给的不是
true 都按没担保）：这个 token 是本人登录时开的（不是老板的演示视角）、他的工作台 ID 来自 ERP 身份（Authentik 的
erp_sub）、绑定的 erpUserId 就是这个 ID。怎么用见 routers/auth.py 的 miaoda_entry。
"""
from dataclasses import dataclass
from datetime import datetime, timedelta

import httpx
from jose import JWTError, jwt

from app.config import settings

# 第一次进入的确认票据：verify 换出来的身份要留到用户输完密码，token 已经用掉了，只能自己签一张
_TICKET_TYPE = "miaoda_confirm"
_TICKET_MINUTES = 10


class EntryRejected(Exception):
    """工作台说这个 token 不行（作废、过期、没绑定 ERP 账号），按没登录处理。"""


class EntryUnavailable(Exception):
    """没配 key、连不上工作台、工作台出错：这一次进不来，不是 token 的问题。"""


class TicketInvalid(Exception):
    """确认票据伪造、过期或者不是这一种。"""


@dataclass(frozen=True)
class MiaodaUser:
    miaoda_user_id: str
    # 工作台绑定时填的 ERP 账号 ID，未经确认
    erp_user_id: str
    # 工作台担保：本人登录、工作台 ID 来自 ERP 身份、绑定的 erpUserId 就是这个 ID（见开头）
    erp_verified: bool = False


def verify(entry_token: str) -> MiaodaUser:
    if not settings.erp_bridge_api_key:
        raise EntryUnavailable("ERP_BRIDGE_API_KEY 没配置")
    try:
        resp = httpx.post(
            settings.erp_bridge_verify_url,
            json={"token": entry_token},
            headers={"Authorization": f"Bearer {settings.erp_bridge_api_key}"},
            timeout=8,
        )
    except httpx.HTTPError as exc:
        raise EntryUnavailable(f"连不上工作台：{exc}") from exc
    if resp.status_code == 400:
        raise EntryRejected(_error_message(resp) or "工作台进入链接无效，请从工作台重新进入")
    if resp.status_code != 200:
        raise EntryUnavailable(f"工作台 verify 回 HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise EntryUnavailable("工作台 verify 回的不是 JSON") from exc
    miaoda_user_id = _id_text(data.get("miaodaUserId")) if isinstance(data, dict) else ""
    erp_user_id = _id_text(data.get("erpUserId")) if isinstance(data, dict) else ""
    if not miaoda_user_id or not erp_user_id:
        raise EntryUnavailable("工作台 verify 回的身份缺 miaodaUserId / erpUserId")
    # 只认 JSON 的 true："true"、1 这类都不算担保
    erp_verified = data.get("erpVerified") is True
    return MiaodaUser(miaoda_user_id=miaoda_user_id, erp_user_id=erp_user_id, erp_verified=erp_verified)


def _id_text(value) -> str:
    # 工作台的 ID 是一长串数字，JSON 里给成数字也认
    if isinstance(value, bool):
        return ""
    if isinstance(value, int):
        return str(value)
    return value.strip() if isinstance(value, str) else ""


def _error_message(resp: httpx.Response) -> str:
    """400 的原因在 error.message 里（作废 / 过期 / 没绑定），照抄给 H5。"""
    try:
        body = resp.json()
    except ValueError:
        return ""
    err = body.get("error") if isinstance(body, dict) else None
    message = err.get("message") if isinstance(err, dict) else None
    return message if isinstance(message, str) else ""


def issue_ticket(miaoda_user_id: str, staff_id: str) -> str:
    """不带 sub：拿它当登录令牌，get_current_user 查不到人，回 401。"""
    expire = datetime.utcnow() + timedelta(minutes=_TICKET_MINUTES)
    claims = {"typ": _TICKET_TYPE, "mid": miaoda_user_id, "sid": staff_id, "exp": expire}
    return jwt.encode(claims, settings.jwt_secret, algorithm="HS256")


def read_ticket(ticket: str) -> tuple[str, str]:
    """返回 (miaoda_user_id, staff_id)。"""
    try:
        claims = jwt.decode(ticket, settings.jwt_secret, algorithms=["HS256"])
    except JWTError as exc:
        raise TicketInvalid() from exc
    if claims.get("typ") != _TICKET_TYPE or not claims.get("mid") or not claims.get("sid"):
        raise TicketInvalid()
    return claims["mid"], claims["sid"]
