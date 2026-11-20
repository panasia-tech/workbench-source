"""店铺↔群控账号 绑定(管理员):小程序绑定 UI 的 ERP 侧代理。

小程序只连 ERP;真正的账号/设备数据在**新群控** groupcontrol-server(:8100),
故这里经 gc_bridge.client 代理其账号/设备接口。前缀 `/api/gc-bind`。

(ERP 里那套内嵌的旧群控 `/api/gc/*` 已于 2026-09-16 删除:表 0 行、无人调用,
 而两个同名前缀并存让人改错地方。此处原有的「别与旧内嵌混」警告随之作废。)

店铺→群控账号 = **显式绑定**(SaleShop.gc_account_id,POST /bind-shop 维护),群控侧为真源,
ERP 的闲鱼账号名(xianyu_user_name)不再参与上架解析;未显式绑定的店铺才回退按名匹配。
账号↔设备绑定(nick↔device_id)仍在群控侧,经 POST /bind 代理。
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import SaleShop, Staff
from app.services.gc_bridge import client as gc
from app.services.gc_bridge.client import GcBridgeError

router = APIRouter(prefix="/api/gc-bind", tags=["gc-bind"])


class GcBindShopOut(BaseModel):
    shop_id: str = Field(description="店铺 ID")
    shop_code: str = Field(description="店铺编码")
    shop_label: str = Field(description="店铺名称")
    nick: str = Field(description="期望闲鱼账号名:显式绑定时=gc 账号 nick,否则=SaleShop.xianyu_user_name")
    bound: bool = Field(description="是否已在群控注册且绑定了设备")
    gc_account_id: str | None = Field(description="gc 账号 id(显式绑定时=SaleShop.gc_account_id)")
    bound_explicit: bool = Field(description="是否显式绑定(SaleShop.gc_account_id 已设)")
    device_id: str | None = Field(description="绑定设备 ID")
    device_name: str | None = Field(description="绑定设备名称")
    device_kind: str | None = Field(default=None, description="绑定设备类型 android(手机)/browser(AdsPower 浏览器)")
    # 浏览器设备的 hw_id 就是 AdsPower 环境 ID:行情台删环境时靠它找到对应店铺一并停用
    device_hw_id: str | None = Field(default=None, description="绑定设备硬件标识:手机为 ANDROID_ID,浏览器为 AdsPower 环境 ID")
    device_status: str | None = Field(description="绑定设备状态")
    device_online: bool = Field(description="绑定设备是否在线")
    # ---- 对账看板字段(自动绑定后用「该店闲鱼是否真有一台在线且就绪、且登着对的账号」对账)----
    expected_nick: str = Field(description="店铺期望的闲鱼账号名(= nick)")
    reported_nick: str | None = Field(description="绑定设备当前实际登录上报的闲鱼昵称(device.reported_nick)")
    ready: bool = Field(description="绑定设备 Preflight 是否就绪(device.last_ready)")
    match: bool = Field(description="存在一台在线且就绪、且登录闲鱼 == expected_nick 的设备")


class GcBindAccountOut(BaseModel):
    id: str = Field(description="群控账号 ID")
    nick: str = Field(description="闲鱼账号昵称")
    device_id: str | None = Field(description="绑定设备 ID")
    device_name: str | None = Field(description="绑定设备名称")
    device_kind: str | None = Field(default=None, description="绑定设备类型 android(手机)/browser(AdsPower 浏览器)")
    device_status: str | None = Field(description="绑定设备状态")
    device_online: bool = Field(description="绑定设备是否在线")


class GcBindDeviceOut(BaseModel):
    id: str = Field(description="设备 ID")
    name: str = Field(description="设备名称")
    kind: str = Field(default="android", description="执行端类型 android(手机)/browser(AdsPower 浏览器)")
    status: str = Field(description="设备状态 ONLINE/OFFLINE/DISABLED")
    online: bool = Field(description="是否在线")
    model: str | None = Field(default=None, description="设备型号")
    brand: str | None = Field(default=None, description="设备品牌")


class GcBindRequest(BaseModel):
    nick: str = Field(description="闲鱼账号昵称")
    device_id: str | None = Field(default=None, description="绑定的设备 ID;传 None 或空串表示解绑")


class GcBindShopRequest(BaseModel):
    shop_id: str = Field(description="店铺 ID")
    gc_account_id: str | None = Field(default=None, description="绑定的群控账号 ID;传 None 或空串表示解绑")


def _is_online(status: str | None) -> bool:
    # gc DeviceStatus: ONLINE / OFFLINE / DISABLED —— 仅 ONLINE 视为在线可用。
    return (status or "").upper() == "ONLINE"


async def _safe_gc(coro, action: str):
    """统一把 gc 侧异常翻成对小程序友好的错误:400 透传拒因,其余按 502(群控未连)。"""
    try:
        return await coro
    except GcBridgeError as exc:
        raise HTTPException(status_code=exc.status or 400, detail=str(exc)) from exc
    except Exception as exc:  # httpx 连接/超时/5xx 等
        raise HTTPException(status_code=502, detail=f"群控服务未连接或异常({action})") from exc


@router.get("/shops", summary="查询店铺绑定对账", response_model=list[GcBindShopOut])
async def bind_shops(
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """每个启用店铺一行:期望闲鱼账号 + 当前绑定的设备(名称/在线)。一次性拉全量 gc 账号+设备再本地 join。

    显式绑定(SaleShop.gc_account_id)的店铺以 gc 账号为真源;未绑的回退按 xianyu_user_name 名匹配。
    """
    shops = (
        db.query(SaleShop)
        .filter(SaleShop.enabled.is_(True))
        .order_by(SaleShop.sort_order, SaleShop.code)
        .all()
    )
    accounts = await _safe_gc(gc.list_accounts(), "拉取账号")
    devices = await _safe_gc(gc.list_devices(), "拉取设备")
    acc_by_id = {a.get("id"): a for a in accounts}
    acc_by_nick = {a.get("nick"): a for a in accounts}
    dev_by_id = {d.get("id"): d for d in devices}

    out: list[GcBindShopOut] = []
    for shop in shops:
        explicit = bool(shop.gc_account_id)
        if explicit:
            acc = acc_by_id.get(shop.gc_account_id)
            nick = (acc.get("nick") or "").strip() if acc else ""
        else:
            nick = (shop.xianyu_user_name or "").strip()
            acc = acc_by_nick.get(nick) if nick else None
        device_id = acc.get("device_id") if acc else None
        dev = dev_by_id.get(device_id) if device_id else None
        # 对账:该店期望账号 nick → gc Account → 其设备的 online/ready/当前登录闲鱼(reported_nick)。
        # 没有对应 Account/设备 = 没有设备登着这个闲鱼。
        online = _is_online(dev.get("status")) if dev else False
        ready = bool(dev.get("last_ready")) if dev else False
        reported_nick = dev.get("reported_nick") if dev else None
        # match:一台在线且就绪、且实际登录闲鱼 == 期望 nick 的设备(自动绑定已对上)
        match = bool(nick and online and ready and reported_nick == nick)
        out.append(
            GcBindShopOut(
                shop_id=shop.id,
                shop_code=shop.code,
                shop_label=shop.label,
                nick=nick,
                bound=bool(device_id),
                gc_account_id=acc.get("id") if acc else (shop.gc_account_id if explicit else None),
                bound_explicit=explicit,
                device_id=device_id,
                device_name=dev.get("name") if dev else None,
                device_kind=(dev.get("kind") or "android") if dev else None,
                device_hw_id=dev.get("hw_id") if dev else None,
                device_status=dev.get("status") if dev else None,
                device_online=online,
                expected_nick=nick,
                reported_nick=reported_nick,
                ready=ready,
                match=match,
            )
        )
    return out


@router.get("/accounts", summary="查询群控账号列表", response_model=list[GcBindAccountOut])
async def bind_accounts(
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """群控账号清单(含绑定设备/在线),供店铺→账号绑定的选择器。"""
    accounts = await _safe_gc(gc.list_accounts(), "拉取账号")
    devices = await _safe_gc(gc.list_devices(), "拉取设备")
    dev_by_id = {d.get("id"): d for d in devices}
    out: list[GcBindAccountOut] = []
    for a in accounts:
        dev = dev_by_id.get(a.get("device_id")) if a.get("device_id") else None
        out.append(
            GcBindAccountOut(
                id=a.get("id"),
                nick=a.get("nick") or "",
                device_id=a.get("device_id"),
                device_name=dev.get("name") if dev else None,
                device_kind=(dev.get("kind") or "android") if dev else None,
                device_status=dev.get("status") if dev else None,
                device_online=_is_online(dev.get("status")) if dev else False,
            )
        )
    return out


@router.get("/devices", summary="查询群控设备列表", response_model=list[GcBindDeviceOut])
async def bind_devices(
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """群控真机设备清单(供绑定选择器)。"""
    devices = await _safe_gc(gc.list_devices(), "拉取设备")
    return [
        GcBindDeviceOut(
            id=d.get("id"),
            name=d.get("name") or d.get("id"),
            kind=d.get("kind") or "android",
            status=d.get("status") or "",
            online=_is_online(d.get("status")),
            model=d.get("model"),
            brand=d.get("brand"),
        )
        for d in devices
    ]


@router.post("/bind", summary="绑定群控账号设备")
async def bind(
    body: GcBindRequest,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """按闲鱼账号名 upsert 绑定(device_id 传 null/"" 即解绑)。代理 gc /accounts/bind。"""
    nick = (body.nick or "").strip()
    if not nick:
        raise HTTPException(status_code=400, detail="缺少闲鱼账号名")
    device_id = (body.device_id or "").strip() or None
    acc = await _safe_gc(gc.bind_account(nick, device_id), "绑定")
    return {
        "ok": True,
        "nick": nick,
        "device_id": acc.get("device_id"),
        "bound": bool(acc.get("device_id")),
    }


@router.post("/bind-shop", summary="绑定店铺群控账号")
async def bind_shop(
    body: GcBindShopRequest,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """店铺→群控账号 显式绑定(写 SaleShop.gc_account_id;gc_account_id 传 null/"" 即解绑)。

    上架解析以显式绑定为真源,ERP 闲鱼账号名不再参与。
    """
    shop = db.get(SaleShop, body.shop_id)
    if not shop:
        raise HTTPException(status_code=404, detail="店铺不存在")
    gc_account_id = (body.gc_account_id or "").strip() or None
    acc = None
    if gc_account_id:
        acc = await _safe_gc(gc.get_account(gc_account_id), "校验账号")
        if not acc:
            raise HTTPException(status_code=400, detail="群控账号不存在,请刷新后重试")
    shop.gc_account_id = gc_account_id
    db.commit()
    return {
        "ok": True,
        "shop_id": shop.id,
        "gc_account_id": gc_account_id,
        "nick": acc.get("nick") if acc else None,
        "bound": bool(gc_account_id),
    }
