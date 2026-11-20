"""钉钉企业内部应用「ERP」：读通讯录、发工作通知、开 Stream 长连接。

用 urllib 不用 httpx：httpx 的 INFO 日志会把整条 URL 打出来，带着 access_token（同 wecom.py）。
读人要应用的「通讯录接口权限范围」覆盖到这个人，否则返回 50004，不代表人不在了。
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request

from app.config import settings

logger = logging.getLogger(__name__)

_NEW_API = "https://api.dingtalk.com"
_OAPI = "https://oapi.dingtalk.com"
_token_lock = threading.Lock()
_token_cache: dict = {"token": None, "expires_at": 0.0}

USER_NOT_FOUND = 60121  # 通讯录里没有这个人（离职了或 userid 不对）
OUT_OF_SCOPE = 50004  # 不在应用的通讯录接口权限范围里

_ERRORS = {
    USER_NOT_FOUND: "钉钉里找不到这个人",
    OUT_OF_SCOPE: "不在应用的通讯录接口权限范围里",
    60011: "应用没开通所需的权限",
    40014: "钉钉凭证失效",
    42001: "钉钉凭证过期",
}


class DingtalkError(Exception):
    def __init__(self, code, message: str):
        super().__init__(message)
        self.code = code


def configured() -> bool:
    return bool(settings.dingtalk_client_id and settings.dingtalk_client_secret and settings.dingtalk_agent_id)


def _post_json(url: str, payload: dict) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:  # 新版接口出错是 4xx + JSON
        try:
            return json.loads(exc.read().decode("utf-8") or "{}")
        except ValueError:
            return {"code": exc.code, "message": f"HTTP {exc.code}"}


def _token(poster=None) -> str:
    poster = poster or _post_json
    with _token_lock:
        now = time.time()
        if _token_cache["token"] and _token_cache["expires_at"] > now + 60:
            return _token_cache["token"]
        body = poster(
            f"{_NEW_API}/v1.0/oauth2/accessToken",
            {"appKey": settings.dingtalk_client_id, "appSecret": settings.dingtalk_client_secret},
        )
        token = isinstance(body, dict) and body.get("accessToken")
        if not token:
            raise DingtalkError(body.get("code") if isinstance(body, dict) else None, "钉钉拿不到凭证，检查 Client ID / Secret")
        _token_cache.update(token=token, expires_at=now + float(body.get("expireIn", 7200)) - 300)
        return token


def _oapi(path: str, payload: dict, poster=None) -> dict:
    """调旧版 topapi，errcode 非 0 抛 DingtalkError。"""
    poster = poster or _post_json
    body = poster(f"{_OAPI}{path}?access_token={_token(poster)}", payload)
    if not isinstance(body, dict):
        raise DingtalkError(None, "钉钉返回无法解析")
    code = body.get("errcode")
    if code != 0:
        if code in (40014, 42001):
            _token_cache.update(token=None, expires_at=0.0)
        raise DingtalkError(code, _ERRORS.get(code) or f"钉钉返回 {code}：{body.get('errmsg') or ''}".strip())
    return body


def get_user(userid: str, *, poster=None) -> dict:
    """通讯录里的一个人：name / mobile / title / dept_id_list / active …"""
    return _oapi("/topapi/v2/user/get", {"userid": userid, "language": "zh_CN"}, poster)["result"]


def userinfo_by_auth_code(code: str, *, poster=None) -> dict:
    """H5 / 微应用免登：把前端 dd.requestAuthCode 拿到的临时 code 换成 userid。

    对应钉钉 topapi/v2/user/getuserinfo。code 一次有效、很快过期；只返回在职成员。
    """
    code = (code or "").strip()
    if not code or len(code) > 512:
        raise DingtalkError(None, "钉钉登录凭证无效")
    body = _oapi("/topapi/v2/user/getuserinfo", {"code": code}, poster)
    result = body.get("result") or {}
    userid = (result.get("userid") or "").strip()
    if not userid:
        raise DingtalkError(None, "钉钉未返回成员身份")
    return result


def h5_sso_ready() -> bool:
    """H5 钉钉免登：应用凭证齐了就能换 code；corpId 只给前端 requestAuthCode 用。"""
    return configured()


def department_names(dept_ids, *, poster=None) -> list[str]:
    """这些部门和它们的上级部门的名字（不含根部门=公司名），去重保序。
    挂在「技术部」下面的小组也要按技术部算，所以往上找。"""
    names, seen = [], set()
    for dept_id in dept_ids or []:
        while dept_id and dept_id != 1 and dept_id not in seen:
            seen.add(dept_id)
            dept = _oapi("/topapi/v2/department/get", {"dept_id": dept_id, "language": "zh_CN"}, poster)["result"]
            name = (dept.get("name") or "").strip()
            if name and name not in names:
                names.append(name)
            dept_id = dept.get("parent_id")
    return names


def list_users(*, poster=None) -> list[dict]:
    """权限范围里的所有人（按部门逐个翻，同一人在多个部门只算一次）。范围不是全部员工时会抛 50004。"""
    depts, seen, users = [1], set(), {}
    while depts:
        dept_id = depts.pop()
        if dept_id in seen:
            continue
        seen.add(dept_id)
        subs = _oapi("/topapi/v2/department/listsub", {"dept_id": dept_id}, poster).get("result") or []
        depts.extend(d["dept_id"] for d in subs)
        cursor = 0
        while True:
            page = _oapi("/topapi/v2/user/list", {"dept_id": dept_id, "cursor": cursor, "size": 100}, poster)["result"]
            for u in page.get("list") or []:
                users.setdefault(u["userid"], u)
            if not page.get("has_more"):
                break
            cursor = page["next_cursor"]
    return list(users.values())


def send_text(userids: list[str], content: str, *, poster=None) -> tuple[bool, str]:
    """工作通知发文字。返回 (是否发出, 说明)。不抛异常，调用方按结果记账。"""
    return _send(userids, {"msgtype": "text", "text": {"content": content[:1000]}}, poster)


def send_card(userids: list[str], title: str, markdown: str, url: str, button: str, *, poster=None) -> tuple[bool, str]:
    """工作通知发卡片（标题 + 正文 + 一个按钮），点按钮在钉钉里打开 url。"""
    msg = {"msgtype": "action_card", "action_card": {"title": title, "markdown": markdown, "single_title": button, "single_url": url}}
    return _send(userids, msg, poster)


def _send(userids: list[str], msg: dict, poster=None) -> tuple[bool, str]:
    userids = [u for u in userids if u]
    if not configured():
        return False, "ERP 没配钉钉应用"
    if not userids:
        return False, "没有收件人"
    try:
        body = _oapi(
            "/topapi/message/corpconversation/asyncsend_v2",
            {
                "agent_id": int(settings.dingtalk_agent_id),
                "userid_list": ",".join(userids),
                "msg": msg,
            },
            poster,
        )
    except DingtalkError as exc:
        logger.warning("钉钉工作通知没发出: %s", exc)
        return False, str(exc)
    except Exception:  # noqa: BLE001 - 网络错误也只记一笔，不影响业务
        logger.exception("钉钉工作通知失败")
        return False, "连不上钉钉"
    return True, f"钉钉已发出（任务 {body.get('task_id')}）"


def open_stream(*, poster=None) -> tuple[str, str]:
    """申请 Stream 长连接，返回 (endpoint, ticket)。只订阅事件（EVENT *），订阅哪些事件在开发者后台勾。"""
    poster = poster or _post_json
    body = poster(
        f"{_NEW_API}/v1.0/gateway/connections/open",
        {
            "clientId": settings.dingtalk_client_id,
            "clientSecret": settings.dingtalk_client_secret,
            "subscriptions": [{"type": "EVENT", "topic": "*"}],
            "ua": "erp-dingtalk-sync",
        },
    )
    if not isinstance(body, dict) or not body.get("endpoint") or not body.get("ticket"):
        raise DingtalkError(body.get("code") if isinstance(body, dict) else None, "钉钉 Stream 连接申请失败")
    return body["endpoint"], body["ticket"]
