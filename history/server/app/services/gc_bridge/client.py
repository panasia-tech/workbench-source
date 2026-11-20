"""ERP → groupcontrol-server(:8100)HTTP 客户端。

只封薄薄一层:账号 upsert(设备号↔账号名映射)+ publish/delist 作业 + 作业状态查询。
gc 上架是**异步**的(建 job → 调度器驱动真机,分钟级),故这里拿到 job 即返回,
在架/失败由后续状态回写(轮询 get_job 或 gc 回调)决定,建作业接口只负责受理。
"""

from __future__ import annotations

import httpx

from app.config import settings


class GcBridgeError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def _base() -> str:
    return settings.gc_server_base_url.rstrip("/")


async def _post(path: str, json: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        resp = await c.post(f"{_base()}{path}", json=json)
    if resp.status_code == 400:
        # gc 侧 validate_publish_spec 拒(缺图/隐私图/库位图/无效价)→ 明确抛出原因
        detail = ""
        try:
            detail = resp.json().get("detail") or ""
        except Exception:
            detail = resp.text
        raise GcBridgeError(detail or "上架失败，请稍后再试", status=400)
    resp.raise_for_status()
    return resp.json()


async def _get(path: str, params: dict | None = None) -> dict | list:
    async with httpx.AsyncClient(timeout=30) as c:
        resp = await c.get(f"{_base()}{path}", params=params)
    resp.raise_for_status()
    return resp.json()


async def _patch(path: str, json: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        resp = await c.patch(f"{_base()}{path}", json=json)
    resp.raise_for_status()
    return resp.json()


async def bind_account(nick: str, device_id: str | None = None) -> dict:
    """按闲鱼账号名 upsert gc 账号(= 设备号↔账号名 映射;同名只更新设备号)。返回 gc account。"""
    return await _post("/api/gc/accounts/bind", {"nick": nick, "device_id": device_id})


async def resolve_account(nick: str) -> dict | None:
    """闲鱼账号名 → gc 账号(含 device_id;没有返回 None)。

    发布用它解析:账号必须由管理员先在群控注册并绑好设备(= 设备号↔账号名 映射表),
    否则该店铺没设备可发。调用方须校验返回值非空且 device_id 存在。
    """
    rows = await _get("/api/gc/accounts", params={"nick": nick})
    return rows[0] if rows else None


async def get_account(account_id: str) -> dict | None:
    """gc 账号 id → gc 账号(/accounts 只支持 nick 过滤,拉全量按 id 索引)。没有返回 None。"""
    rows = await list_accounts()
    return {a.get("id"): a for a in rows}.get(account_id)


async def list_accounts() -> list[dict]:
    """全部 gc 账号(= 设备号↔账号名 映射表全量)。供小程序绑定 UI 一次性拉取后按 nick 索引。"""
    rows = await _get("/api/gc/accounts")
    return rows if isinstance(rows, list) else []


async def list_devices() -> list[dict]:
    """全部 gc 真机设备(含在线状态/型号)。供绑定 UI 的设备选择器。"""
    rows = await _get("/api/gc/devices")
    return rows if isinstance(rows, list) else []


async def create_publish_job(sku: str, account_ids: list[str], spec: dict, source: str = "ERP",
                             worry_free_by_account: dict[str, bool] | None = None) -> dict:
    """建发布作业(扇出到各 gc 账号)。spec 由 assembler.build_publish_spec 组装。
    worry_free_by_account:按账号覆盖无忧卖({account_id: bool},ERP 已解析);gc 侧烤进各任务 spec。
    spec 不合法(缺图/隐私图/无效价)时 gc 返回 400 → 抛 GcBridgeError。返回 job。"""
    payload = {
        "job_type": "publish_batch", "sku": sku,
        "account_ids": account_ids, "spec": spec, "source": source,
    }
    if worry_free_by_account is not None:
        payload["worry_free_by_account"] = worry_free_by_account
    return await _post("/api/gc/jobs", payload)


async def create_delist_job(sku: str, source: str = "ERP", account_ids: list[str] | None = None) -> dict:
    """建下架作业:对该 SKU 的在架 listing 下架。返回 job。
    account_ids:只下这些 gc 账号上的(「下架所选店铺」);None = 全账号(下架全部 / 售出后全网下架)。"""
    payload = {"job_type": "delist_sku", "sku": sku, "source": source}
    if account_ids is not None:
        payload["account_ids"] = account_ids
    return await _post("/api/gc/jobs", payload)


class GcRefreshSkipped(GcBridgeError):
    """群控说这条今天不焕新（状态不对/有任务在动它/这个号今天额度满了）。不是出错，跳过即可。"""


async def list_refresh_candidates() -> dict:
    """今天该焕新的链接 + 每个号今天还能开几单：{items, rooms, min_age_days, held_for_buyers}。"""
    data = await _get("/api/gc/listings/refresh-candidates")
    return data if isinstance(data, dict) else {"items": [], "rooms": {}}


async def get_refresh_status(sku: str) -> dict:
    """这件货各条链接的焕新情况：{min_age_days, items: [{listing_id, account_id, status, published_at, blocker}]}。"""
    data = await _get("/api/gc/listings/refresh-status", params={"sku": sku})
    return data if isinstance(data, dict) else {"items": []}


async def create_refresh_job(listing_id: str, spec: dict, source: str = "ERP") -> dict:
    """建链接焕新作业：群控先删旧链接，删成功再用 spec 在同一账号重发。返回 job。

    409 → GcRefreshSkipped（今天不做）；400 → GcBridgeError（发布内容不合格，原因可直接给人看）。
    不走 _post：它把 409 当异常状态码直接抛 httpx 错误，这里要把原因带出来。
    """
    payload = {"job_type": "refresh_listing", "listing_id": listing_id, "spec": spec, "source": source}
    async with httpx.AsyncClient(timeout=30) as c:
        resp = await c.post(f"{_base()}/api/gc/jobs", json=payload)
    if resp.status_code in (400, 409):
        try:
            detail = resp.json().get("detail") or ""
        except Exception:
            detail = resp.text
        cls = GcRefreshSkipped if resp.status_code == 409 else GcBridgeError
        raise cls(detail or "群控拒绝焕新", status=resp.status_code)
    resp.raise_for_status()
    return resp.json()


async def get_job(job_id: str) -> dict:
    """查作业聚合状态(PENDING/RUNNING/DONE/PARTIAL/FAILED)。供状态回写轮询用。"""
    return await _get(f"/api/gc/jobs/{job_id}")


async def list_tasks(job_id: str) -> list[dict]:
    """按作业查扇出任务(每条含 account_id/status/error/failed_step)。
    状态回写用它按「本店铺的 gc 账号」精确定位任务成败——聚合 job 状态分不清单账号
    (PARTIAL 时成功的账号已由账本 LIVE 收敛,剩下没收敛的账号要靠任务级状态判 FAILED)。"""
    rows = await _get("/api/gc/tasks", params={"job_id": job_id, "page_size": 200})
    return rows if isinstance(rows, list) else []


_LISTING_PAGE = 200


async def list_listings(
    sku: str | None = None, account_id: str | None = None, status: str | None = None
) -> list[dict]:
    """查 gc 上架账本(SKU×账号×状态)。回写时按此把 SkuShopListing 收敛到 LISTED/DELISTED;
    status="SOLD" 轮询真机检出的已售账本(sold_sync)。"""
    params = {}
    if sku:
        params["sku"] = sku
    if account_id:
        params["account_id"] = account_id
    if status:
        params["status"] = status
    # gc 默认一页 50、最多 200:不翻页的话已售账本过了 50 条,后面的售出就永远同步不到
    out: list[dict] = []
    page = 1
    while True:
        rows = await _get("/api/gc/listings", params={**params, "page": page, "page_size": _LISTING_PAGE})
        rows = rows if isinstance(rows, list) else []
        out.extend(rows)
        if len(rows) < _LISTING_PAGE:
            return out
        page += 1


async def recode_listings(pairs: list[dict]) -> int:
    """ERP 换了货号,让 gc 账本跟着换。pairs=[{old,new}] 按换码先后排;幂等。返回改了几条。"""
    data = await _post("/api/gc/listings/recode", {"pairs": pairs})
    return int((data or {}).get("updated") or 0)


# ==================== 群控运维(设备/任务 代理,供 gc_ops 路由) ====================


async def list_tasks_paged(device_id: str | None = None, status: str | None = None,
                           exclude_type: str | None = None,
                           page: int = 1, page_size: int = 50) -> dict:
    """分页查任务(with_total=true → {"items": [...], "total": N})。供运维看板。
    exclude_type 逗号多值(如 "chat_scan")从结果中排除该类型任务。"""
    params: dict = {"page": page, "page_size": page_size, "with_total": "true"}
    if device_id:
        params["device_id"] = device_id
    if status:
        params["status"] = status
    if exclude_type:
        params["exclude_type"] = exclude_type
    rows = await _get("/api/gc/tasks", params=params)
    return rows if isinstance(rows, dict) else {"items": rows, "total": len(rows)}


async def get_task(task_id: str) -> dict:
    """任务详情。gc 侧不存在时 404(httpx.HTTPStatusError),由路由层 _safe_gc 透传。"""
    return await _get(f"/api/gc/tasks/{task_id}")


async def get_task_trace(task_id: str) -> dict:
    """任务回放(逐步动作 + 动作后截图的限时链接)。gc 侧不存在时 404,由路由层透传。"""
    return await _get(f"/api/gc/tasks/{task_id}/trace")


async def create_task(payload: dict) -> dict:
    """建单设备任务({device_id, account_id?, job_id?, task_type, spec?, source?, ...})。返回 TaskOut。"""
    return await _post("/api/gc/tasks", payload)


async def restart_device(device_id: str) -> dict:
    """重启设备(下发 restart 任务)。返回 gc 的 TaskOut。"""
    return await _post(f"/api/gc/devices/{device_id}/restart", {})


async def self_check_device(device_id: str) -> dict:
    """设备自检。返回 {ok, preflight};设备离线时 gc 侧 409。"""
    return await _post(f"/api/gc/devices/{device_id}/self-check", {})


async def update_device(device_id: str, fields: dict) -> dict:
    """改设备资料({name?, status?, note?})。返回 DeviceOut。"""
    return await _patch(f"/api/gc/devices/{device_id}", fields)


async def _put(path: str, json: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        resp = await c.put(f"{_base()}{path}", json=json)
    resp.raise_for_status()
    return resp.json()


# 消息响应考核（groupcontrol-server/app/chat_sla.py）
async def chat_sla_settings() -> dict:
    return await _get("/api/gc/chat-sla/settings")


async def chat_sla_save_settings(data: dict) -> dict:
    return await _put("/api/gc/chat-sla/settings", data)


async def chat_sla_owners() -> dict:
    return await _get("/api/gc/chat-sla/owners")


async def chat_sla_set_owners(account_id: str, owners: list[dict]) -> list:
    return await _put(f"/api/gc/chat-sla/owners/{account_id}", {"owners": owners})


async def chat_sla_waiting() -> dict:
    return await _get("/api/gc/chat-sla/waiting")


async def chat_sla_stats(date_from: str, date_to: str) -> dict:
    return await _get("/api/gc/chat-sla/stats", params={"date_from": date_from, "date_to": date_to})


async def virtual_paid(item_ids: list[str]) -> list[dict]:
    """虚拟商品：这些闲鱼商品的会话 + 每条买家「我已付款」消息（群控 /api/gc/virtual/paid，本机直连）。"""
    return await _get("/api/gc/virtual/paid", {"item_ids": ",".join(item_ids)})


async def virtual_send(conversation_id: str, text: str, by_name: str | None = None) -> dict:
    """替人往会话里发一条文字（发卡券），返回 {task_id}；真正发出去要等设备执行。"""
    return await _post(f"/api/gc/virtual/send/{conversation_id}", {"text": text, "by_name": by_name})
