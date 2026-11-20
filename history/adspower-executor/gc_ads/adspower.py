"""AdsPower Local API 客户端。

只用到最小组面：
- GET /api/v1/browser/start?user_id=...  启动环境，返回 CDP/puppeteer ws 端点
- GET /api/v1/browser/stop?user_id=...
- GET /api/v1/browser/active?user_id=... 查询运行状态
- GET /api/v1/browser/local-active       本机所有运行中环境（supervisor 状态盘点用）

- GET /api/v1/user/list?page=&page_size= 枚举全部环境（**需付费版套餐**）

AdsPower 环境本身持久化 cookie/指纹，登录态由环境保存，执行端不管账号密码。

环境清单默认走 user/list 直接从 API 拉（见 Config.env_user_ids），config.yaml 的
environments 退化成覆盖项：只用来给环境起备注名、或用 enabled: false 把某个环境排除
在纳管之外。免费版套餐下 user/list 返回 "paid subscriptions only"，此时自动回退到
config.yaml 的清单。
"""
from __future__ import annotations

import threading
import time

import httpx

from .config import AdsPowerConfig


class PaidFeatureUnavailable(RuntimeError):
    """Local API 拒绝了一个付费版专属接口（免费版套餐）。"""


def _as_payload(resp, method: str, path: str) -> dict:
    """把响应解析成 {code,msg,data}。

    非 JSON 响应要能一眼看出病根：AdsPower 对方法不符的请求（比如往
    GET-only 的 browser/start 发 POST）会返回空体或 HTML，直接 resp.json()
    只会抛一个「Expecting value: line 1 column 1」，指不到任何地方。
    """
    try:
        return resp.json()
    except ValueError:
        body = (resp.text or "").strip().replace("\n", " ")[:160]
        return {"code": -1, "msg":
                f"{method} {path} 返回非 JSON（HTTP {resp.status_code}）: {body or '(空响应)'}"}


class AdsPowerClient:
    # Local API 限流 1 次/秒，超了会返回 code=-1 "Too many request per second"。
    # 限流是**按 AdsPower 进程**算的，不是按客户端实例，所以节流状态放类级别：
    # supervisor、config 枚举、各执行端在同一进程里共用一条时间线。
    # （跨进程仍可能撞——桌面端 seller-pilot 打的是同一个 Local API——所以下面
    #  另有一次退避重试兜底。）
    _MIN_INTERVAL_SEC = 1.1
    _throttle_lock = threading.Lock()
    _last_request_at = 0.0

    # 代理端口 → 直连端口。代理宕机不该让执行端整个停摆，只该失去
    # 跨进程节流与归属保护，所以连不上时自动降级直连 AdsPower 本体。
    _BROKER_PORT = ":50326"
    _DIRECT_PORT = ":50325"

    def __init__(self, cfg: AdsPowerConfig):
        self.cfg = cfg
        self._degraded = False

    def _direct_base(self) -> str | None:
        base = str(self.cfg.api_base or "").rstrip("/")
        return base.replace(self._BROKER_PORT, self._DIRECT_PORT) \
            if base.endswith(self._BROKER_PORT) else None

    def _headers(self) -> dict:
        """经本机代理时声明调用方身份，代理按用途登记表校验环境归属。

        直连 AdsPower 时这个头会被忽略，所以无条件带上即可。
        """
        owner = str(getattr(self.cfg, "owner", "") or "").strip()
        return {"X-Ads-Owner": owner} if owner else {}

    @classmethod
    def _throttle(cls) -> None:
        wait = cls._MIN_INTERVAL_SEC - (time.monotonic() - cls._last_request_at)
        if wait > 0:
            time.sleep(wait)

    def _get(self, path: str, params: dict | None = None, timeout: float = 30) -> dict:
        # 整个「等待 + 请求」都在锁里：只放等待会让并发调方同时醒来一起发。
        for attempt in (0, 1):
            with AdsPowerClient._throttle_lock:
                self._throttle()
                try:
                    try:
                        resp = httpx.get(f"{self.cfg.api_base}{path}",
                                         params=params, timeout=timeout,
                                         headers=self._headers())
                    except httpx.ConnectError as exc:
                        base = self._degrade(exc)
                        if base is None:
                            raise
                        resp = httpx.get(f"{base}{path}", params=params,
                                         timeout=timeout, headers=self._headers())
                    data = _as_payload(resp, "GET", path)
                finally:
                    AdsPowerClient._last_request_at = time.monotonic()
            # 撞限时 HTTP 仍是 200、code=-1，不会抛异常，只能看文案。
            if attempt == 0 and data.get("code") != 0 \
                    and "too many request" in str(data.get("msg") or "").lower():
                continue
            return data
        return data

    def _degrade(self, exc: Exception) -> str | None:
        """代理连不上 → 切直连并返回新 base；不是代理场景返回 None 让异常上抛。

        只在**连接失败**时降级：代理返回的 403 归属拒绝是正确判决，
        绕过去直连等于把归属保护作废。
        """
        base = self._direct_base()
        if base is None:
            return None
        if not self._degraded:
            self._degraded = True
            print(f"[adspower] 本机代理连不上（{exc}），本次起直连 {base}。"
                  "失去跨进程节流与环境归属保护，请起 manage.py broker。", flush=True)
        self.cfg.api_base = base
        return base

    def api_alive(self) -> bool:
        """Local API 是否可达（AdsPower 客户端已启动且开了 API 服务）。"""
        try:
            data = self._get("/api/v1/browser/local-active", timeout=8)
            return data.get("code") == 0
        except Exception:
            return False

    def start_browser(self, user_id: str | None = None) -> str:
        """启动环境并返回 ws 端点（供 Playwright connect_over_cdp 使用）。

        环境已在跑时 start 也会返回 ws；失败时调方可再试 local_active_ws() 兜底。
        """
        uid = user_id or self.cfg.user_id
        data = self._get(
            "/api/v1/browser/start",
            params={
                "user_id": uid,
                "headless": 1 if self.cfg.headless else 0,
                "open_tabs": 1,
            },
            timeout=60,
        )
        if data.get("code") != 0:
            raise RuntimeError(f"adspower start failed: {data.get('msg')}")
        ws = data["data"]["ws"]["puppeteer"]
        return ws

    def list_users(self, page_size: int = 100) -> list[dict]:
        """枚举全部环境 [{user_id, name, serial_number, group_name}]，自动翻页。

        ⚠️ 只回传这五个字段：user/list 的原始条目里还有 user_proxy_config
        （明文 proxy_user / proxy_password）、环境账号密码和真实出口 IP。执行端
        不需要这些，也不该让它们进日志或落盘，所以这里是白名单而不是原样透传。

        付费版专属；免费版返回 code=-1 "paid subscriptions only"，此处抛
        PaidFeatureUnavailable 由调方决定回退策略。
        """
        out: list[dict] = []
        page = 1
        while True:
            data = self._get("/api/v1/user/list",
                             params={"page": page, "page_size": page_size}, timeout=20)
            if data.get("code") != 0:
                msg = str(data.get("msg") or "")
                if "paid subscription" in msg.lower():
                    raise PaidFeatureUnavailable(msg)
                raise RuntimeError(f"adspower user/list failed: {msg}")
            items = (data.get("data") or {}).get("list") or []
            for item in items:
                uid = str(item.get("user_id") or "").strip()
                if not uid:
                    continue
                # has_proxy 只是个布尔：代理**配没配**是运维要看的就绪信号，
                # 但 proxy_user / proxy_password 是明文凭据，绝不能进这个白名单。
                proxy_soft = str((item.get("user_proxy_config") or {}).get("proxy_soft") or "").strip()
                out.append({
                    "user_id": uid,
                    "name": str(item.get("name") or "").strip(),
                    "serial_number": str(item.get("serial_number") or "").strip(),
                    "group_name": str(item.get("group_name") or "").strip(),
                    "has_proxy": bool(proxy_soft) and proxy_soft != "no_proxy",
                })
            if len(items) < page_size:
                return out
            page += 1

    # ---------- 分组（环境归属边界） ----------

    def _post(self, path: str, body: dict, timeout: float = 20) -> dict:
        for attempt in (0, 1):
            with AdsPowerClient._throttle_lock:
                self._throttle()
                try:
                    try:
                        resp = httpx.post(f"{self.cfg.api_base}{path}", json=body,
                                          timeout=timeout, headers=self._headers())
                    except httpx.ConnectError as exc:
                        base = self._degrade(exc)
                        if base is None:
                            raise
                        resp = httpx.post(f"{base}{path}", json=body,
                                          timeout=timeout, headers=self._headers())
                    data = _as_payload(resp, "POST", path)
                finally:
                    AdsPowerClient._last_request_at = time.monotonic()
            if attempt == 0 and data.get("code") != 0 \
                    and "too many request" in str(data.get("msg") or "").lower():
                continue
            return data
        return data

    def list_groups(self) -> list[dict]:
        """全部分组 [{group_id, group_name}]；付费版专属。"""
        data = self._get("/api/v1/group/list", params={"page": 1, "page_size": 200}, timeout=20)
        if data.get("code") != 0:
            msg = str(data.get("msg") or "")
            if "paid subscription" in msg.lower():
                raise PaidFeatureUnavailable(msg)
            raise RuntimeError(f"adspower group/list failed: {msg}")
        return (data.get("data") or {}).get("list") or []

    def ensure_group(self, group_name: str) -> str:
        """按名字取分组 id，没有就建一个。返回 group_id。

        ⚠️ Local API 没有 group/delete，建错了只能改名（group/update），
        所以这里先查后建，避免留下同名垃圾分组。
        """
        name = group_name.strip()
        for g in self.list_groups():
            if str(g.get("group_name") or "").strip() == name:
                return str(g.get("group_id"))
        data = self._post("/api/v1/group/create", {"group_name": name})
        if data.get("code") != 0:
            raise RuntimeError(f"adspower group/create failed: {data.get('msg')}")
        return str((data.get("data") or {}).get("group_id"))

    def assign_group(self, user_ids: list[str], group_id: str) -> None:
        """把环境批量移进分组。

        ⚠️ 用 /api/v1/user/regroup，不要用 /api/v1/user/update：后者带
        {user_id, group_id} 调用会返回 code=0 "Success"，但环境的 group_id
        原封不动——静默失败。所以这里改完还要**读回校验**，不信返回码。
        """
        ids = [str(u).strip() for u in user_ids if str(u).strip()]
        if not ids:
            return
        data = self._post("/api/v1/user/regroup",
                          {"user_ids": ids, "group_id": str(group_id)})
        if data.get("code") != 0:
            raise RuntimeError(f"adspower user/regroup failed: {data.get('msg')}")

        landed = {u["user_id"] for u in self.list_users_in_group(group_id)}
        missed = [u for u in ids if u not in landed]
        if missed:
            raise RuntimeError(
                f"adspower 接口报成功但环境未落到分组 {group_id}: {', '.join(missed)}")

    def create_env(self, name: str, group_id: str, proxy: dict | None = None) -> dict:
        """新建环境，返回 {user_id, serial_number}。

        group_id 是**必填**——这正是我们要的：环境从出生起就带用途归属，
        不会出现「建完忘了分组，谁也不认领」的空档。
        proxy 留空 = 不走代理（no_proxy）；生产环境应显式传 socks5 配置。
        """
        body = {
            "group_id": str(group_id),
            "name": name.strip(),
            "user_proxy_config": proxy or {"proxy_soft": "no_proxy"},
        }
        data = self._post("/api/v1/user/create", body, timeout=30)
        if data.get("code") != 0:
            raise RuntimeError(f"adspower user/create failed: {data.get('msg')}")
        d = data.get("data") or {}
        return {"user_id": str(d.get("id") or ""), "serial_number": str(d.get("serial_number") or "")}

    def delete_envs(self, user_ids: list[str]) -> None:
        """删除环境（不可逆：指纹与 cookie 一并消失）。"""
        ids = [str(u).strip() for u in user_ids if str(u).strip()]
        if not ids:
            return
        data = self._post("/api/v1/user/delete", {"user_ids": ids}, timeout=30)
        if data.get("code") != 0:
            raise RuntimeError(f"adspower user/delete failed: {data.get('msg')}")
        still = {u["user_id"] for u in self.list_users()}
        left = [u for u in ids if u in still]
        if left:
            raise RuntimeError(f"adspower 接口报成功但环境仍在: {', '.join(left)}")

    def list_users_in_group(self, group_id: str) -> list[dict]:
        """某分组下的环境（读回校验用）。"""
        out: list[dict] = []
        page = 1
        while True:
            data = self._get("/api/v1/user/list",
                             params={"page": page, "page_size": 100,
                                     "group_id": str(group_id)}, timeout=20)
            if data.get("code") != 0:
                raise RuntimeError(f"adspower user/list failed: {data.get('msg')}")
            items = (data.get("data") or {}).get("list") or []
            out.extend({"user_id": str(i.get("user_id") or "").strip()} for i in items)
            if len(items) < 100:
                return [i for i in out if i["user_id"]]
            page += 1

    def local_active(self) -> list[dict]:
        """本机所有运行中环境 [{user_id, ws, debug_port, ...}]；API 不可达返回 []。"""
        try:
            data = self._get("/api/v1/browser/local-active", timeout=15)
        except Exception:
            return []
        if data.get("code") != 0:
            return []
        return data.get("data", {}).get("list", []) or []

    def local_active_ws(self, user_id: str | None = None) -> str | None:
        """探测本机运行中环境的 ws 端点（start 失败时的兜底）。"""
        uid = user_id or self.cfg.user_id
        for item in self.local_active():
            if item.get("user_id") == uid:
                ws = (item.get("ws") or {}).get("puppeteer")
                if ws:
                    return ws
        return None

    def stop_browser(self, user_id: str | None = None) -> None:
        self._get("/api/v1/browser/stop",
                  params={"user_id": user_id or self.cfg.user_id}, timeout=30)

    def is_active(self, user_id: str | None = None) -> bool:
        try:
            data = self._get("/api/v1/browser/active",
                             params={"user_id": user_id or self.cfg.user_id}, timeout=15)
        except Exception:
            return False
        return data.get("code") == 0 and data.get("data", {}).get("status") == "Active"
