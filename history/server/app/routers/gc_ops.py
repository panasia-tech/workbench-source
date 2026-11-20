"""群控运维代理:设备/任务 看板与操作(小程序+管理后台)。

小程序只连 ERP;设备/任务真源在**新群控** groupcontrol-server(:8100),
故这里经 gc_bridge.client 代理其 /api/gc/devices、/api/gc/tasks 接口。
与 gc_bind.py(店铺↔账号绑定)同代际。(ERP 内嵌的旧群控 /api/gc/* 已于 2026-09-16 删除。)

安全红线:设备 DeviceOut 含 token(真机接入凭证),**绝不能下发前端**——本路由自定义响应模型,
逐字段挑拣,token 不进模型。
"""

from datetime import datetime
from decimal import Decimal
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import ShopListingStatus, StaffRole
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing, Staff
from app.schemas._tz import CNDatetime
from app.services.gc_bridge import client as gc
from app.services.gc_bridge.client import GcBridgeError
from app.services.oss_media import thumb_url_for_cover

router = APIRouter(prefix="/api/gc-ops", tags=["gc-ops"])

# 查看类(设备/任务查询):后台四角色;操作类(重启/自检/改设备/重试):仅 ADMIN
_VIEW_ROLES = (StaffRole.ADMIN, StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.PURCHASER)


class GcOpsDeviceOut(BaseModel):
    """设备看板行。**不含 token**。account_nick 由 gc 账号表本地 join(该设备绑定账号的昵称)。"""

    id: str = Field(description="设备 ID")
    name: str = Field(description="设备名称")
    kind: str = Field(default="android", description="执行端类型 android(手机)/browser(AdsPower 浏览器)")
    status: str = Field(description="设备状态 ONLINE/OFFLINE/DISABLED")
    brand: str | None = Field(default=None, description="设备品牌")
    model: str | None = Field(default=None, description="设备型号")
    serial: str | None = Field(default=None, description="设备序列号")
    reported_nick: str | None = Field(default=None, description="设备当前实际登录上报的闲鱼昵称")
    account_id: str | None = Field(default=None, description="绑定账号 ID")
    account_nick: str | None = Field(default=None, description="绑定账号昵称(join gc 账号表)")
    last_ready: bool = Field(default=False, description="Preflight 是否就绪")
    blocking: bool = Field(default=False, description="是否阻塞中(有未处理阻断事件)")
    busy_task_id: str | None = Field(default=None, description="正在执行的任务 ID")
    app_version: str | None = Field(default=None, description="执行端 App 版本")
    last_heartbeat_at: str | None = Field(default=None, description="最近心跳时间")
    last_online_at: str | None = Field(default=None, description="最近上线时间")
    last_event: str | None = Field(default=None, description="最近事件")
    last_exit_reason: str | None = Field(default=None, description="最近退出原因")


class GcOpsTaskOut(BaseModel):
    """任务看板行(gc TaskOut + device_name/account_nick 本地 join)。"""

    id: str = Field(description="任务 ID")
    job_id: str | None = Field(default=None, description="所属作业 ID")
    device_id: str | None = Field(default=None, description="执行设备 ID")
    device_name: str | None = Field(default=None, description="执行设备名称(join gc 设备表)")
    account_id: str | None = Field(default=None, description="执行账号 ID")
    account_nick: str | None = Field(default=None, description="执行账号昵称(join gc 账号表)")
    task_type: str = Field(description="任务类型")
    status: str = Field(description="任务状态 PENDING/DISPATCHED/RUNNING/SUCCESS/FAILED/TIMEOUT/CANCELLED")
    spec: Any = Field(default=None, description="任务参数")
    result: Any = Field(default=None, description="任务结果")
    progress: Any = Field(default=None, description="任务进度")
    mark: str | None = Field(default=None, description="人工标记")
    error: str | None = Field(default=None, description="失败原因")
    failed_step: str | None = Field(default=None, description="失败步骤")
    shot_key: str | None = Field(default=None, description="截图 key")
    created_at: str | None = Field(default=None, description="创建时间")
    dispatched_at: str | None = Field(default=None, description="下发时间")
    finished_at: str | None = Field(default=None, description="完成时间")


class GcOpsTaskListOut(BaseModel):
    items: list[GcOpsTaskOut] = Field(description="当前页任务")
    total: int = Field(description="符合条件的任务总数")


class GcOpsReplayStepOut(BaseModel):
    """回放的一步:流程发出的一个动作 + 动作后的截图。"""

    seq: int | None = Field(default=None, description="第几步")
    at: float | None = Field(default=None, description="距任务开跑的秒数")
    action: str = Field(description="动作 tap/swipe/set_text/launch_app/push_media 等")
    args: str = Field(default="", description="动作参数(坐标/网址/输入的字)")
    ms: int | None = Field(default=None, description="动作耗时(毫秒)")
    error: str | None = Field(default=None, description="动作出错原因")
    shot_url: str | None = Field(default=None, description="动作后的截图(限时链接)")
    thumb_url: str | None = Field(default=None, description="截图缩略图(限时链接)")
    shot_error: str | None = Field(default=None, description="截图失败原因")


class GcOpsReplayOut(BaseModel):
    task_id: str = Field(description="任务 ID")
    status: str = Field(description="任务状态")
    live: bool = Field(default=False, description="任务还在跑,步骤是实时的")
    steps: list[GcOpsReplayStepOut] = Field(default_factory=list, description="按顺序的动作")
    result_shot_url: str | None = Field(default=None, description="结果截图(限时链接)")
    result_thumb_url: str | None = Field(default=None, description="结果截图缩略图(限时链接)")
    note: str | None = Field(default=None, description="没有步骤时的原因")


class GcDevicePatchIn(BaseModel):
    """改设备资料;status 只允许 ONLINE/DISABLED(OFFLINE 由真机心跳决定,不允许人工设)。"""

    name: str | None = Field(default=None, description="设备名称")
    status: str | None = Field(default=None, description="设备状态,仅 ONLINE/DISABLED")
    note: str | None = Field(default=None, description="备注")


async def _safe_gc(coro, action: str):
    """统一把 gc 侧异常翻成对前端友好的错误:GcBridgeError 按自带 status 透传,
    gc 侧 404(如任务不存在)透传 404 + detail,其余按 502(群控未连)。"""
    try:
        return await coro
    except GcBridgeError as exc:
        raise HTTPException(status_code=exc.status or 400, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            detail = ""
            try:
                detail = exc.response.json().get("detail") or ""
            except Exception:
                detail = exc.response.text
            raise HTTPException(status_code=404, detail=detail or "群控侧资源不存在") from exc
        raise HTTPException(status_code=502, detail=f"群控服务未连接或异常({action})") from exc
    except Exception as exc:  # httpx 连接/超时等
        raise HTTPException(status_code=502, detail=f"群控服务未连接或异常({action})") from exc


def _device_out(d: dict, acc_by_id: dict) -> GcOpsDeviceOut:
    """gc DeviceOut → 看板行:逐字段挑拣(不含 token),补 account_nick。"""
    acc = acc_by_id.get(d.get("account_id")) if d.get("account_id") else None
    return GcOpsDeviceOut(
        id=d.get("id"),
        name=d.get("name") or d.get("id"),
        kind=d.get("kind") or "android",
        status=d.get("status") or "",
        brand=d.get("brand"),
        model=d.get("model"),
        serial=d.get("serial"),
        reported_nick=d.get("reported_nick"),
        account_id=d.get("account_id"),
        account_nick=(acc.get("nick") if acc else None),
        last_ready=bool(d.get("last_ready")),
        blocking=bool(d.get("blocking")),
        busy_task_id=d.get("busy_task_id"),
        app_version=d.get("app_version"),
        last_heartbeat_at=d.get("last_heartbeat_at"),
        last_online_at=d.get("last_online_at"),
        last_event=d.get("last_event"),
        last_exit_reason=d.get("last_exit_reason"),
    )


def _task_out(t: dict, dev_by_id: dict, acc_by_id: dict) -> GcOpsTaskOut:
    """gc TaskOut → 看板行:补 device_name/account_nick。"""
    dev = dev_by_id.get(t.get("device_id")) if t.get("device_id") else None
    acc = acc_by_id.get(t.get("account_id")) if t.get("account_id") else None
    return GcOpsTaskOut(
        id=t.get("id"),
        job_id=t.get("job_id"),
        device_id=t.get("device_id"),
        device_name=(dev.get("name") if dev else None),
        account_id=t.get("account_id"),
        account_nick=(acc.get("nick") if acc else None),
        task_type=t.get("task_type") or "",
        status=t.get("status") or "",
        spec=t.get("spec"),
        result=t.get("result"),
        progress=t.get("progress"),
        mark=t.get("mark"),
        error=t.get("error"),
        failed_step=t.get("failed_step"),
        shot_key=t.get("shot_key"),
        created_at=t.get("created_at"),
        dispatched_at=t.get("dispatched_at"),
        finished_at=t.get("finished_at"),
    )


async def _load_join_maps() -> tuple[dict, dict]:
    """一次性拉 gc 设备+账号全量,返回 (dev_by_id, acc_by_id) 供本地 join。"""
    devices = await _safe_gc(gc.list_devices(), "拉取设备")
    accounts = await _safe_gc(gc.list_accounts(), "拉取账号")
    return {d.get("id"): d for d in devices}, {a.get("id"): a for a in accounts}


@router.get("/devices", summary="查询群控设备全量", response_model=list[GcOpsDeviceOut])
async def list_devices(
    _: Staff = Depends(require_roles(*_VIEW_ROLES)),
):
    """设备全量看板(在线状态/就绪/当前登录闲鱼/绑定账号昵称)。**不下发 token**。"""
    devices = await _safe_gc(gc.list_devices(), "拉取设备")
    accounts = await _safe_gc(gc.list_accounts(), "拉取账号")
    acc_by_id = {a.get("id"): a for a in accounts}
    return [_device_out(d, acc_by_id) for d in devices]


@router.get("/tasks", summary="分页查询群控任务", response_model=GcOpsTaskListOut)
async def list_tasks(
    device_id: str | None = Query(default=None, description="按设备过滤"),
    status: str | None = Query(default=None, description="按状态过滤"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    _: Staff = Depends(require_roles(*_VIEW_ROLES)),
):
    """任务分页看板({items,total});每条补 device_name/account_nick。
    chat_scan(每 5 分钟一轮扫消息)和 keepalive(浏览器号闲着每 10 分钟开一次首页保活)
    都是常驻背景任务,量大且无看板价值,固定排除。"""
    data = await _safe_gc(
        gc.list_tasks_paged(device_id=device_id, status=status, exclude_type="chat_scan,keepalive",
                            page=page, page_size=page_size),
        "拉取任务",
    )
    dev_by_id, acc_by_id = await _load_join_maps()
    return GcOpsTaskListOut(
        items=[_task_out(t, dev_by_id, acc_by_id) for t in data.get("items") or []],
        total=int(data.get("total") or 0),
    )


@router.get("/tasks/{task_id}", summary="查询群控任务详情", response_model=GcOpsTaskOut)
async def get_task(
    task_id: str,
    _: Staff = Depends(require_roles(*_VIEW_ROLES)),
):
    """任务详情(补 device_name/account_nick);gc 侧不存在时 404 透传。"""
    task = await _safe_gc(gc.get_task(task_id), "拉取任务详情")
    dev_by_id, acc_by_id = await _load_join_maps()
    return _task_out(task, dev_by_id, acc_by_id)


@router.get("/tasks/{task_id}/trace", summary="群控任务回放", response_model=GcOpsReplayOut)
async def get_task_trace(
    task_id: str,
    _: Staff = Depends(require_roles(*_VIEW_ROLES)),
):
    """逐步回放:流程发出的每个动作和动作后的截图;跑着的任务给到目前为止的步骤。
    gc 侧不存在时 404 透传。"""
    return await _safe_gc(gc.get_task_trace(task_id), "拉取任务回放")


@router.post("/devices/{device_id}/restart", summary="重启群控设备")
async def restart_device(
    device_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """下发重启任务,返回 gc 的 TaskOut 摘要。"""
    task = await _safe_gc(gc.restart_device(device_id), "重启设备")
    return {
        "ok": True,
        "task_id": task.get("id"),
        "device_id": task.get("device_id"),
        "task_type": task.get("task_type"),
        "status": task.get("status"),
    }


@router.post("/devices/{device_id}/self-check", summary="群控设备自检")
async def self_check_device(
    device_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """设备自检,返回 {ok, preflight};设备离线时 gc 侧 409(经 GcBridgeError/httpx 透传)。"""
    return await _safe_gc(gc.self_check_device(device_id), "设备自检")


@router.patch("/devices/{device_id}", summary="修改群控设备资料", response_model=GcOpsDeviceOut)
async def update_device(
    device_id: str,
    body: GcDevicePatchIn,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """改设备名称/状态/备注;status 仅允许 ONLINE/DISABLED,其余 400。"""
    fields = body.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要修改的字段")
    status = fields.get("status")
    if status is not None:
        status = status.upper()
        if status not in ("ONLINE", "DISABLED"):
            raise HTTPException(status_code=400, detail="status 只允许 ONLINE/DISABLED")
        fields["status"] = status
    device = await _safe_gc(gc.update_device(device_id, fields), "修改设备")
    acc = None
    if device.get("account_id"):
        acc = await _safe_gc(gc.get_account(device["account_id"]), "拉取账号")
    acc_by_id = {acc.get("id"): acc} if acc else {}
    return _device_out(device, acc_by_id)


@router.post("/tasks/{task_id}/retry", summary="重试群控任务")
async def retry_task(
    task_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """按原任务的 device_id/account_id/task_type/spec 重建一条新任务(source=MANUAL)。

    原任务不存在时 gc 侧 404,经 _safe_gc 透传为 404。
    """
    old = await _safe_gc(gc.get_task(task_id), "拉取原任务")
    new_task = await _safe_gc(
        gc.create_task({
            "device_id": old.get("device_id"),
            "account_id": old.get("account_id"),
            "task_type": old.get("task_type"),
            "spec": old.get("spec"),
            "source": "MANUAL",
        }),
        "重试任务",
    )
    return {
        "ok": True,
        "task_id": new_task.get("id"),
        "device_id": new_task.get("device_id"),
        "task_type": new_task.get("task_type"),
        "status": new_task.get("status"),
        "retry_of": old.get("id"),
    }



# ==================== 消息响应考核（群控 chat_sla 的转发） ====================
class ChatSlaSettingsIn(BaseModel):
    enabled: bool | None = None
    read_min: int | None = Field(default=None, ge=1, le=240, description="几分钟没看提醒负责人")
    reply_min: int | None = Field(default=None, ge=1, le=1440, description="几分钟没回通知管理员")
    quiet_start: int | None = Field(default=None, ge=0, le=23, description="夜间不考核开始(点钟)")
    quiet_end: int | None = Field(default=None, ge=0, le=23, description="夜间不考核结束(点钟)")


class ChatSlaOwnersIn(BaseModel):
    staff_ids: list[str] = Field(default_factory=list, description="负责员工 ID")


@router.get("/chat-sla/settings", summary="消息响应考核设置")
async def chat_sla_settings(_: Staff = Depends(require_roles(*_VIEW_ROLES))):
    return await _safe_gc(gc.chat_sla_settings(), "读考核设置")


@router.put("/chat-sla/settings", summary="改消息响应考核设置")
async def chat_sla_save_settings(body: ChatSlaSettingsIn, _: Staff = Depends(require_roles(StaffRole.ADMIN))):
    return await _safe_gc(gc.chat_sla_save_settings({k: v for k, v in body.model_dump().items() if v is not None}), "改考核设置")


@router.get("/chat-sla/owners", summary="闲鱼号负责人")
async def chat_sla_owners(_: Staff = Depends(require_roles(*_VIEW_ROLES))):
    return await _safe_gc(gc.chat_sla_owners(), "读负责人")


@router.put("/chat-sla/owners/{account_id}", summary="设闲鱼号负责人")
async def chat_sla_set_owners(account_id: str, body: ChatSlaOwnersIn, db: Session = Depends(get_db),
                              _: Staff = Depends(require_roles(StaffRole.ADMIN))):
    staffs = db.query(Staff).filter(Staff.id.in_(body.staff_ids), Staff.deleted_at.is_(None)).all() if body.staff_ids else []
    owners = [{"staff_id": s.id, "staff_name": s.name or s.username} for s in staffs]
    return await _safe_gc(gc.chat_sla_set_owners(account_id, owners), "设负责人")


@router.get("/chat-sla/waiting", summary="正在等回复的会话")
async def chat_sla_waiting(_: Staff = Depends(require_roles(*_VIEW_ROLES))):
    return await _safe_gc(gc.chat_sla_waiting(), "读等待中的会话")


@router.get("/chat-sla/stats", summary="按员工统计消息响应")
async def chat_sla_stats(date_from: str = Query(...), date_to: str = Query(...), _: Staff = Depends(require_roles(*_VIEW_ROLES))):
    return await _safe_gc(gc.chat_sla_stats(date_from, date_to), "读响应统计")


# ---------- 一个闲鱼号发过的商品 ----------

class GcOpsAccountListingOut(BaseModel):
    sku_id: str = Field(description="SKU ID")
    sku_code: str = Field(description="货号")
    product_name: str | None = Field(default=None, description="商品名")
    spec: str | None = Field(default=None, description="规格")
    sku_status: str | None = Field(default=None, description="库存状态")
    location_code: str | None = Field(default=None, description="库位")
    cover_url: str | None = Field(default=None, description="封面缩略图")
    title: str | None = Field(default=None, description="上架标题")
    desc: str | None = Field(default=None, description="上架描述")
    price: Decimal | None = Field(default=None, description="上架价")
    publish_status: str = Field(description="在这个号上的状态 PENDING/LISTING/LISTED/SOLD/DELISTED/FAILED")
    last_error: str | None = Field(default=None, description="上次失败原因")
    created_at: CNDatetime | None = Field(default=None, description="第一次在这个号上发的时间")
    updated_at: CNDatetime | None = Field(default=None, description="状态最后变化时间")
    sold_at: CNDatetime | None = Field(default=None, description="卖出时间")
    delisted_at: CNDatetime | None = Field(default=None, description="下架时间")


class GcOpsAccountListingsOut(BaseModel):
    account_id: str = Field(description="群控账号 ID")
    shop_labels: list[str] = Field(description="这个号对应的店铺名")
    counts: dict[str, int] = Field(description="按状态计数")
    items: list[GcOpsAccountListingOut] = Field(description="商品,在售的排前面")


_LISTING_ORDER = {
    ShopListingStatus.LISTED: 0, ShopListingStatus.LISTING: 1, ShopListingStatus.PENDING: 2,
    ShopListingStatus.FAILED: 3, ShopListingStatus.SOLD: 4, ShopListingStatus.DELISTED: 5,
}


@router.get("/accounts/{account_id}/listings", summary="一个闲鱼号发过的商品",
            response_model=GcOpsAccountListingsOut)
def account_listings(
    account_id: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(*_VIEW_ROLES)),
):
    """设备列表点进一个号:它发过的每件货(在售、上架中、卖掉、下架、失败),带上架标题、价格、描述。

    店铺行和号的对应以行上的 gc_account_id 为准,没写就看店铺绑的号;同一件货挂在
    同一个号的两个店铺上只算一条,留在架的那条。
    """
    shops = db.query(SaleShop).filter(SaleShop.gc_account_id == account_id).all()
    shop_ids = [s.id for s in shops]
    cond = SkuShopListing.gc_account_id == account_id
    if shop_ids:
        cond = or_(cond, and_(SkuShopListing.gc_account_id.is_(None), SkuShopListing.sale_shop_id.in_(shop_ids)))
    rows = (
        db.query(SkuShopListing, Sku, SkuListingInfo)
        .join(Sku, Sku.id == SkuShopListing.sku_id)
        .outerjoin(SkuListingInfo, SkuListingInfo.sku_id == Sku.id)
        .filter(cond)
        .all()
    )
    by_sku: dict[str, tuple] = {}
    for row in rows:
        kept = by_sku.get(row[1].id)
        if kept is None or _LISTING_ORDER.get(row[0].publish_status, 9) < _LISTING_ORDER.get(kept[0].publish_status, 9):
            by_sku[row[1].id] = row
    items, counts = [], {}
    for sl, sku, info in by_sku.values():
        counts[sl.publish_status] = counts.get(sl.publish_status, 0) + 1
        items.append(GcOpsAccountListingOut(
            sku_id=sku.id, sku_code=sku.sku_code, product_name=sku.product_name, spec=sku.spec,
            sku_status=sku.status, location_code=sku.location_code,
            cover_url=thumb_url_for_cover(sku.cover_url),
            title=info.title if info else None, desc=info.desc if info else None,
            price=info.price if info else None,
            publish_status=sl.publish_status, last_error=sl.last_error,
            created_at=sl.created_at, updated_at=sl.updated_at,
            sold_at=sl.sold_at, delisted_at=sl.delisted_at,
        ))
    items.sort(key=lambda i: i.updated_at or i.created_at or datetime.min, reverse=True)
    items.sort(key=lambda i: _LISTING_ORDER.get(i.publish_status, 9))
    return GcOpsAccountListingsOut(account_id=account_id, shop_labels=[s.label for s in shops],
                                   counts=counts, items=items)
