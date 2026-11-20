"""个人 API Key（wk_ 前缀，员工工作台签发）验证：拿 key 去工作台换身份。

工作台「我的 → API Key」签的 key（库里只有 sha256 digest）是全公司系统的个人通行证：
ERP 收到 wk_ 开头的 Bearer，就在这里调工作台的 POST /openapi/api-keys/verify（系统级 key
WORKBENCH_VERIFY_KEY 鉴权，个人 key 调不了那个端点）换回 userId（= ERP 员工 ID）/ name / roles。
工作台连不上不放行（401，不降级）；吊销、账号停用最迟 60 秒生效（进程内 TTL 缓存，含 401 负缓存）。
"""
import threading
import time
from dataclasses import dataclass

import httpx

from app.config import settings

_CACHE_TTL_SECONDS = 60
_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()


class WkRejected(Exception):
    """key 无效 / 已吊销 / 账号停用，按未登录处理（401）。"""


class WkUnavailable(Exception):
    """没配系统 key、连不上工作台、工作台出错：这次验不了，不是 key 的问题（也回 401，不放行）。"""


@dataclass(frozen=True)
class WkIdentity:
    user_id: str
    name: str
    roles: tuple[str, ...]


def verify(raw_key: str) -> WkIdentity:
    cached = _cache_get(raw_key)
    if cached is not None:
        if cached is _NEGATIVE:
            raise WkRejected()
        return cached
    try:
        identity = _verify_remote(raw_key)
    except WkRejected:
        _cache_put(raw_key, _NEGATIVE)
        raise
    _cache_put(raw_key, identity)
    return identity


def _verify_remote(raw_key: str) -> WkIdentity:
    if not settings.workbench_verify_key:
        raise WkUnavailable("WORKBENCH_VERIFY_KEY 没配置")
    try:
        resp = httpx.post(
            settings.workbench_verify_url,
            json={"key": raw_key},
            headers={"Authorization": f"Bearer {settings.workbench_verify_key}"},
            timeout=8,
        )
    except httpx.HTTPError as exc:
        raise WkUnavailable(f"连不上工作台：{exc}") from exc
    if resp.status_code == 401:
        raise WkRejected()
    if resp.status_code != 200:
        raise WkUnavailable(f"工作台 verify 回 HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise WkUnavailable("工作台 verify 回的不是 JSON") from exc
    user_id = data.get("userId") if isinstance(data, dict) else None
    if not isinstance(user_id, str) or not user_id.strip():
        raise WkUnavailable("工作台 verify 回的身份缺 userId")
    name = data.get("name")
    roles = data.get("roles")
    return WkIdentity(
        user_id=user_id.strip(),
        name=name.strip() if isinstance(name, str) else "",
        roles=tuple(r for r in roles if isinstance(r, str)) if isinstance(roles, list) else (),
    )


_NEGATIVE = object()


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
