"""个人 API Key(wk_ 前缀,工作台签发)的链式验证:转发给 ERP /api/auth/me 换员工身份。

ERP 已接 wk_(2026-10-22):它拿 key 去工作台 verify 换 userId 再做在职校验。gc 不直接调工作台——
gc 的权限模型(CHAT_ROLES/OPS_ROLES/ADMIN)全是 ERP 员工角色,链式调 ERP 一步拿到 staff 角色,
免角色映射、免配新密钥(wk_ key 本身就是凭证)。吊销/停用/角色变更最迟 60 秒收敛(进程内 TTL
缓存,含 401 负缓存);ERP 连不上不放行(401,不降级)。

HTTP 用 stdlib urllib(项目惯例,见 app/notify.py 的说明)。
"""
import json
import logging
import threading
import time
import urllib.error
import urllib.request

from app.config import settings

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 60
_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()
_NEGATIVE = object()  # 负缓存:key 无效/吊销/停用


class WkUnavailable(Exception):
    """连不上 ERP / ERP 出错:这次验不了,不是 key 的问题(也回 401,不放行)。"""


def resolve_wk_staff(token: str) -> dict | None:
    """有效返回 {"staff_id", "role", "name", "via": "wk"};无效/吊销/停用返回 None。"""
    cached = _cache_get(token)
    if cached is not None:
        return None if cached is _NEGATIVE else cached
    try:
        staff = _resolve_remote(token)
    except WkUnavailable:
        raise
    if staff is None:
        _cache_put(token, _NEGATIVE)
        return None
    _cache_put(token, staff)
    return staff


def _resolve_remote(token: str) -> dict | None:
    req = urllib.request.Request(
        settings.erp_auth_me_url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            return None
        raise WkUnavailable(f"ERP /api/auth/me 回 HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise WkUnavailable(f"连不上 ERP: {exc}") from exc
    staff = data.get("staff") if isinstance(data, dict) else None
    if not isinstance(staff, dict):
        raise WkUnavailable("ERP /api/auth/me 回的身份缺 staff")
    staff_id = staff.get("id")
    role = staff.get("role")
    status = staff.get("status")
    if not isinstance(staff_id, str) or not staff_id or not isinstance(role, str):
        raise WkUnavailable("ERP /api/auth/me 回的身份缺 id/role")
    if status != "ACTIVE":
        return None
    name = staff.get("name")
    return {
        "staff_id": staff_id,
        "role": role,
        "name": name if isinstance(name, str) else "",
        "via": "wk",
    }


def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        expires_at, value = entry
        if expires_at <= time.monotonic():
            _cache.pop(key, None)
            return None
        return value


def _cache_put(key: str, value) -> None:
    with _cache_lock:
        if len(_cache) > 10_000:
            _cache.clear()
        _cache[key] = (time.monotonic() + _CACHE_TTL_SECONDS, value)


def _clear_cache() -> None:
    """测试用。"""
    with _cache_lock:
        _cache.clear()
