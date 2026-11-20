"""企微应用消息：按员工的企微账号发文字。

用 urllib 不用 httpx：httpx 的 INFO 日志会把整条 URL 打出来，gettoken 的 URL 里带着 corpsecret。
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.parse
import urllib.request

from app.config import settings

logger = logging.getLogger(__name__)

_API = "https://qyapi.weixin.qq.com/cgi-bin"
_token_lock = threading.Lock()
_token_cache: dict = {"token": None, "expires_at": 0.0}

# 企微返回码 → 页面上能看懂的原因
_ERRORS = {
    60020: "企微拒绝：服务器 IP 不在应用的可信 IP 里",
    40014: "企微凭证失效",
    42001: "企微凭证过期",
    81013: "企微里找不到这个账号",
}


def configured() -> bool:
    return bool(settings.wecom_corpid and settings.wecom_corpsecret and settings.wecom_agentid)


def _get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def _post_json(url: str, payload: dict) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def _token(getter) -> str:
    with _token_lock:
        now = time.time()
        if _token_cache["token"] and _token_cache["expires_at"] > now + 60:
            return _token_cache["token"]
        query = urllib.parse.urlencode({"corpid": settings.wecom_corpid, "corpsecret": settings.wecom_corpsecret})
        body = getter(f"{_API}/gettoken?{query}")
        token = isinstance(body, dict) and body.get("access_token")
        if not token:
            raise WecomError(_describe(body))
        _token_cache.update(token=token, expires_at=now + float(body.get("expires_in", 7200)) - 300)
        return token


class WecomError(Exception):
    pass


def _describe(body) -> str:
    if not isinstance(body, dict):
        return "企微返回无法解析"
    code = body.get("errcode")
    return _ERRORS.get(code) or f"企微返回 {code}：{body.get('errmsg') or ''}".strip()


def send_text(userid: str, content: str, *, getter=None, poster=None) -> tuple[bool, str]:
    """给一个人发文字。返回 (是否发出, 说明)。不抛异常，调用方按结果记账。"""
    if not configured():
        return False, "ERP 没配企微应用"
    getter = getter or _get_json
    poster = poster or _post_json
    try:
        token = _token(getter)
        # text 上限 2048 字节，中文 3 字节一个字，保守截 600 字
        body = poster(
            f"{_API}/message/send?access_token={token}",
            {"touser": userid, "msgtype": "text", "agentid": int(settings.wecom_agentid), "text": {"content": content[:600]}},
        )
    except WecomError as exc:
        return False, str(exc)
    except Exception:  # noqa: BLE001 - 网络错误也只记一笔，不影响业务
        logger.exception("企微推送失败")
        return False, "连不上企微"
    if not isinstance(body, dict) or body.get("errcode") != 0:
        if isinstance(body, dict) and body.get("errcode") in (40014, 42001):
            _token_cache.update(token=None, expires_at=0.0)
        logger.warning("企微推送返回非成功: %r", body)
        return False, _describe(body)
    # errcode 0 但对方账号无效时，企微把它放在 invaliduser 里
    if body.get("invaliduser"):
        return False, _ERRORS[81013]
    return True, "企微已发出"
