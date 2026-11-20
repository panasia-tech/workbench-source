"""管理端 REST（设备/任务） + EMQX HTTP 鉴权/ACL 钩子。"""

import logging
import re
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import chat_media, jobs
from app.auth import (
    is_trusted, optional_staff, require_chat_access, require_internal_or_admin, require_ops_access,
)
from app.database import get_db
from app.models import (
    Account, ChatMessage, Conversation, Device, DeviceStatus, Job, JobStatus, JobType,
    Listing, ListingStatus, LogRequest, LogRequestStatus, MarketAccountConfig, Task, TaskStatus,
)
from app.mqtt_bridge import RpcError, bridge
from app.schemas import (
    ListingRecodeIn,
    MarketRoundIn,
    LogRequestIn,
    MaintenanceIn,
    AccountBind,
    AccountCreate,
    AccountOut,
    AccountUpdate,
    ChatMessageOut,
    ChatReplyIn,
    ConversationOut,
    DeviceCreate,
    DeviceInfoIn,
    DEVICE_PRIVATE_FIELDS,
    DeviceOut,
    DeviceUpdate,
    DeviceWithTokenOut,
    HeartbeatIn,
    EmqxAclIn,
    EmqxAuthIn,
    EnrollIn,
    EnrollOut,
    JobCreate,
    JobOut,
    ListingOut,
    TaskCreate,
    TaskOut,
    TaskReplayOut,
    UnitDevice,
    UnitOut,
    UnitQuota,
    UnitTask,
)
from app.config import settings
from app.flow.runner import QUOTA_CATEGORY, DISPATCHABLE_TYPES
# 配额口径必须与派发闸同源:这两个私有件是「今天」的边界和类别→字段的唯一定义,
# 复制一份出来迟早会和 scheduler 漂移,那样界面显示的余量就不是真正拦人的那个数。
from app.scheduler import _QUOTA_FIELD, _cn_today_utc_range
from app.task_replay import build_replay

logger = logging.getLogger("gc.api")

router = APIRouter()


# ---- 内存取证(临时,排查 OOM 用;定位后移除) ----
@router.post("/api/gc/debug/mem", dependencies=[Depends(require_internal_or_admin)], tags=["debug"])
def debug_mem():
    """首次调用启动 tracemalloc;后续调用返回当前 Top25 内存分配点(按行号聚合)。"""
    import tracemalloc

    if not tracemalloc.is_tracing():
        tracemalloc.start(15)
        return {"ok": True, "msg": "tracemalloc started; call again after a while"}
    snap = tracemalloc.take_snapshot()
    top = [
        {
            "size_mb": round(st.size / 1048576, 2),
            "count": st.count,
            "at": f"{st.traceback[0].filename}:{st.traceback[0].lineno}",
        }
        for st in snap.statistics("lineno")[:25]
    ]
    total_mb = round(sum(st.size for st in snap.statistics("filename")) / 1048576, 1)
    return {"traced_total_mb": total_mb, "top": top}

ALLOW = {"result": "allow"}
DENY = {"result": "deny"}


# ==================== 设备 ====================
@router.post("/api/gc/devices", response_model=DeviceWithTokenOut, tags=["device"])
def create_device(body: DeviceCreate, db: Session = Depends(get_db),
                  staff: dict = Depends(require_internal_or_admin)):
    device = Device(name=body.name, note=body.note)
    db.add(device)
    db.commit()
    db.refresh(device)
    out = DeviceWithTokenOut.model_validate(device)
    # wk_ 个人 key 通道不给设备 token(机密):建了设备后 token 从库里由管理员登录态取
    if isinstance(staff, dict) and staff.get("via") == "wk":
        out.token = ""
    return out


@router.post("/api/gc/enroll", response_model=EnrollOut, tags=["device"])
def enroll(body: EnrollIn, db: Session = Depends(get_db)):
    """app HTTP 引导:按 hw_id(Android ANDROID_ID)幂等 upsert 设备,换回 MQTT 身份(device_id/token)。

    - gc_enroll_secret 为空 → 403(未配置不放行匿名 enroll,姿势对齐 jwt_secret「空则拒验」)。
    - 请求 enroll_secret 与配置不匹配 → 403。
    - hw_id 已存在 → 返回**同一** device_id/token(幂等),顺带更新 brand/model/app_version。
    - hw_id 不存在 → 新建(gc 生成 id+token)。

    hw_id 仅作 upsert 键;online 态仍归 MQTT status 帧,enroll 不碰 status。
    """
    if not settings.gc_enroll_secret:
        raise HTTPException(403, "enroll 未启用(gc_enroll_secret 未配置)")
    if body.enroll_secret != settings.gc_enroll_secret:
        raise HTTPException(403, "enroll_secret 不匹配")

    device = db.query(Device).filter(Device.hw_id == body.hw_id).first()
    if device is None:
        # 新建:name 用 brand+model 拼一个可读名,拿不到就落 hw_id
        name = " ".join(x for x in (body.brand, body.model) if x).strip() or body.hw_id
        device = Device(hw_id=body.hw_id, name=name, kind=body.kind or "android")
        db.add(device)
    elif body.kind:
        device.kind = body.kind  # 执行端可声明类型变更(browser/android 互切)
    # 幂等更新机型/版本(不动 id/token/status)
    if body.brand is not None:
        device.brand = body.brand
    if body.model is not None:
        device.model = body.model
    if body.app_version is not None:
        device.app_version = body.app_version
    db.commit()
    db.refresh(device)
    return EnrollOut(device_id=device.id, token=device.token, kind=device.kind)


@router.post("/api/gc/devices/{device_id}/device-info", dependencies=[Depends(require_ops_access)], tags=["device"])
def report_device_info(device_id: str, body: DeviceInfoIn, db: Session = Depends(get_db)):
    """PC 守护端 adb 兜底写入设备硬件信息(SN/双IMEI/手机号)。

    App identity 帧是主上报通道(READ_PHONE_STATE,Android10+ 常读不到);本接口只补齐
    **当前为空的字段**,App 已上报的值不被覆盖。匹配方式:优先按 gc_identity.json 里的
    device_id 直调;拿不到 device_id 时可用 ?serial=ro.serialno 匹配(与 adb serial 一致)。
    """
    device = db.get(Device, device_id)
    if not device:
        # 按 serial 兜底匹配(PC 端拿不到 device_id 的场景)
        serial = body.serial
        if serial:
            device = db.query(Device).filter(Device.serial == serial).first()
    if not device:
        raise HTTPException(404, "设备不存在(按 id/serial 均未匹配)")
    filled = []
    for f in ("serial", "imei1", "imei2", "phone_number"):
        v = getattr(body, f)
        if v and not getattr(device, f):
            setattr(device, f, v)
            filled.append(f)
    db.commit()
    return {"ok": True, "device_id": device.id, "filled": filled}


@router.get("/api/gc/devices", dependencies=[Depends(require_ops_access)], response_model=list[DeviceOut], tags=["device"])
def list_devices(request: Request, db: Session = Depends(get_db),
                 staff: dict | None = Depends(optional_staff)):
    """设备全量。token 对谁都不给(DeviceOut 里就没有它)。

    没有凭据的外部请求再抹掉个人信息与机器标识——守护端还不带令牌在调这个接口,
    它只用 id→名称,直接 401 会让它的任务页当场坏掉,所以这里给删减版而不是拒绝。
    """
    rows = [DeviceOut.model_validate(d) for d in
            db.query(Device).order_by(Device.created_at.desc()).all()]
    # wk_ 个人 key 通道恒定抹除机密字段(管理员也不例外;2026-10-22 老板定)
    if is_trusted(request, staff) and (staff or {}).get("via") != "wk":
        return rows
    blank = dict.fromkeys(DEVICE_PRIVATE_FIELDS)
    return [row.model_copy(update=blank) for row in rows]


@router.post("/api/gc/devices/{device_id}/self-check", dependencies=[Depends(require_internal_or_admin)], tags=["device"])
async def trigger_self_check(device_id: str, db: Session = Depends(get_db)):
    """运维触发:让在线设备立刻跑一次自检,自检完端上会自动补报 identity(昵称+就绪态)。

    用途:设备昵称读空(identity nick=null → 账号未自动注册)时,不等重连/派活,
    手动触发一次「自检 → identity(端上会在空闲时跳「我的」页读昵称)」。
    昵称读到后按 nick 唯一键自动注册/认领账号(见 mqtt_bridge._apply_identity)。
    """
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(404, "设备不存在")
    if device.status != DeviceStatus.ONLINE:
        raise HTTPException(409, "设备不在线")
    try:
        data = await bridge.rpc(device_id, "self_check", timeout=15)
    except RpcError as e:
        raise HTTPException(504, f"设备自检失败: {e}") from e
    return {"ok": True, "preflight": data}


@router.post("/api/gc/devices/{device_id}/restart", dependencies=[Depends(require_internal_or_admin)], response_model=TaskOut, tags=["device"])
async def restart_device_engine(device_id: str, db: Session = Depends(get_db)):
    """远程解救:给设备下发 restart 控制指令(gc/{id}/cmd),端侧重建 MQTT/执行池/心跳(引擎重启)。

    帧格式与现有控制指令一致(参照 App 侧 GcProtocol):{task_id, task_type:"restart", payload:{}}。
    建一条控制类 Task(不挂 job)便于端上 ack 回落到任务状态(老 report 链路)。
    """
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(404, "设备不存在")
    task = Task(device_id=device_id, task_type="restart", source="MANUAL")
    db.add(task)
    db.commit()
    db.refresh(task)
    frame = {"task_id": task.id, "task_type": "restart", "payload": {}}
    try:
        await bridge.publish_cmd(device_id, frame)
        task.status = TaskStatus.DISPATCHED
        task.dispatched_at = datetime.utcnow()
        db.commit()
        db.refresh(task)
    except Exception as e:
        logger.warning("restart 下发失败 device=%s task=%s: %s", device_id, task.id, e)
        raise HTTPException(502, f"restart 下发失败(MQTT 桥未就绪): {e}") from e
    return task


@router.post("/api/gc/devices/{device_id}/update-code", dependencies=[Depends(require_internal_or_admin)], response_model=TaskOut, tags=["device"])
async def update_device_code(device_id: str, db: Session = Depends(get_db)):
    """远程更新执行端:给设备下发 update_code 控制指令(gc/{id}/cmd)。

    端侧收到后先尽力下载校验新代码(check_and_download),再优雅退出进程——manage.py 的
    supervisor 10s 内拉起新进程,启动时 hot_code.activate 换上已下载的新版(全程约 1 分钟,
    期间该账号任务暂停;浏览器窗口不杀,留给用户)。已是最新也会重启进程(对齐 restart 语义)。
    老执行端没有这条 cmd 分支,会静默忽略该指令,任务停在 DISPATCHED——那种机器没有热更
    加载器,仍需人工重装 exe。帧格式同 restart:{task_id, task_type:"update_code", payload:{}}。
    """
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(404, "设备不存在")
    task = Task(device_id=device_id, task_type="update_code", source="MANUAL")
    db.add(task)
    db.commit()
    db.refresh(task)
    frame = {"task_id": task.id, "task_type": "update_code", "payload": {}}
    try:
        await bridge.publish_cmd(device_id, frame)
        task.status = TaskStatus.DISPATCHED
        task.dispatched_at = datetime.utcnow()
        db.commit()
        db.refresh(task)
    except Exception as e:
        logger.warning("update-code 下发失败 device=%s task=%s: %s", device_id, task.id, e)
        raise HTTPException(502, f"update-code 下发失败(MQTT 桥未就绪): {e}") from e
    return task


# 不重新排队的后台任务:到点调度器自己会再建一单,补排只会重复
_MAINTENANCE_SKIP_TYPES = frozenset({"chat_scan", "keepalive", "sold_scan"})


def _requeue_after_maintenance(db: Session, device: Device, since: datetime) -> list[str]:
    """把维护窗口里因执行端重启失败的任务原地放回 PENDING,交调度器重新派。

    原地重置而不是另建:作业的成败按任务数聚合,另建一单会让作业多出一个永久 FAILED。
    这几类不重排:
    - 已点过「发布」(result.published):商品可能已经挂上去了,重发会多一条重复链接(勿盲重发);
    - 命中风控 / 掉登录:那是号本身的问题,不是重启造成的,账号也已冻结;
    - 消息巡检、保活、售出巡检:调度器到点会自己再建。
    """
    failed = (
        db.query(Task)
        .filter(Task.device_id == device.id, Task.status == TaskStatus.FAILED,
                Task.finished_at >= since)
        .all()
    )
    requeued = []
    for task in failed:
        result = task.result or {}
        if (task.task_type in _MAINTENANCE_SKIP_TYPES or result.get("published")
                or result.get("risk") or result.get("login")):
            continue
        task.mark = f"执行端更新中断,重新排队(原因:{(task.error or '')[:80]})"[:255]
        task.status = TaskStatus.PENDING
        task.retry = (task.retry or 0) + 1
        task.result = None
        task.error = None
        task.failed_step = None
        task.shot_key = None
        task.started_at = task.dispatched_at = task.finished_at = None
        requeued.append(task.id)
    return requeued


@router.post("/api/gc/devices/{device_id}/maintenance", dependencies=[Depends(require_ops_access)], tags=["device"])
def begin_maintenance(device_id: str, body: MaintenanceIn, db: Session = Depends(get_db)):
    """更新执行端前报备:调度器从现在起不给它派新活,返回它手上还在跑的任务。

    行情台拿到 running 非空就先别重启,等它跑完再报备一次(幂等,每次都把窗口起点挪到
    现在)——窗口起点 = 真正重启的那一刻,收尾时只重排这之后失败的任务,不会把重启前
    因为别的原因失败的也一起重排。超过 minutes 没收尾,报备自动失效。
    """
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(404, "设备不存在")
    now = datetime.utcnow()
    device.maintenance_since = now
    device.maintenance_until = now + timedelta(minutes=body.minutes)
    device.maintenance_reason = body.reason[:64]
    db.commit()
    running = (
        db.query(Task)
        .filter(Task.device_id == device_id, Task.status == TaskStatus.RUNNING)
        .order_by(Task.started_at.asc())
        .all()
    )
    logger.info("执行端维护报备 device=%s reason=%s 在跑 %d 个", device_id, body.reason, len(running))
    return {"ok": True, "maintenance_until": device.maintenance_until,
            "running": [{"id": t.id, "task_type": t.task_type, "started_at": t.started_at}
                        for t in running]}


@router.delete("/api/gc/devices/{device_id}/maintenance", dependencies=[Depends(require_ops_access)], tags=["device"])
def end_maintenance(device_id: str, db: Session = Depends(get_db)):
    """更新完成:撤掉报备,把窗口里因重启失败的任务放回队列(见 _requeue_after_maintenance)。"""
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(404, "设备不存在")
    since = device.maintenance_since
    requeued = _requeue_after_maintenance(db, device, since) if since else []
    device.maintenance_since = device.maintenance_until = device.maintenance_reason = None
    db.commit()
    for job_id in {t.job_id for t in db.query(Task).filter(Task.id.in_(requeued)) if t.job_id}:
        jobs._aggregate_job(db, job_id)
    db.commit()
    logger.info("执行端维护收尾 device=%s 重新排队 %d 个任务 %s", device_id, len(requeued), requeued)
    return {"ok": True, "requeued": requeued}


@router.post("/api/gc/devices/{device_id}/heartbeat", tags=["device"])
def device_heartbeat(device_id: str, body: HeartbeatIn, db: Session = Depends(get_db)):
    """app 每 5s 心跳:token 校验 → 刷新 last_heartbeat_at;OFFLINE 收到心跳立即回升 ONLINE。
    顺带同步端上就绪态(a11y_ready/blocking),治 identity 陈旧(如 gc-api 重启后 last_ready 卡旧值)。
    离线判定由 scheduler._heartbeat_loop 扫 last_heartbeat_at 超时完成——本端点只「刷新 + 回升」。"""
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(404, "设备不存在")
    if body.token != device.token:
        raise HTTPException(403, "token 不符")
    if device.status == DeviceStatus.DISABLED:
        raise HTTPException(409, "设备已停用")
    now = datetime.utcnow()
    device.last_heartbeat_at = now
    was_offline = device.status != DeviceStatus.ONLINE
    if was_offline:
        device.status = DeviceStatus.ONLINE
        device.last_online_at = now
    if body.a11y_ready is not None:
        device.last_ready = body.a11y_ready
        device.last_check_at = now
    if body.blocking is not None:
        device.blocking = body.blocking or None
    db.commit()
    if was_offline:
        logger.info("设备 %s 心跳恢复 -> ONLINE", device_id)
    # 捎上「有没有要你传的日志」。挂在心跳上是有意的:端上每 5s 问一次,启动后第一拍
    # 也会问——于是"在线时立刻传"和"不在线就下次启动补传"是同一条路,不必为离线单写一套。
    return {"ok": True, "log_request": _pending_log_request(db, "device", device_id)}


def _pending_log_request(db: Session, owner_kind: str, owner_id: str) -> dict | None:
    row = (
        db.query(LogRequest)
        .filter(LogRequest.owner_kind == owner_kind, LogRequest.owner_id == owner_id,
                LogRequest.status == LogRequestStatus.PENDING)
        .order_by(LogRequest.requested_at.asc())
        .first()
    )
    return {"id": row.id, "days": row.days, "note": row.note} if row else None


@router.patch("/api/gc/devices/{device_id}", dependencies=[Depends(require_internal_or_admin)], response_model=DeviceOut, tags=["device"])
def update_device(device_id: str, body: DeviceUpdate, db: Session = Depends(get_db)):
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(404, "设备不存在")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(device, k, v)
    db.commit()
    db.refresh(device)
    return device


# ==================== 任务 ====================
@router.get("/api/gc/tasks", dependencies=[Depends(require_ops_access)], tags=["task"])
def list_tasks(
    device_id: str | None = Query(None),
    job_id: str | None = Query(None),
    status: str | None = Query(None),
    exclude_type: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    with_total: bool = Query(False),
    db: Session = Depends(get_db),
):
    """任务列表。with_total=false(默认) 返回 list[TaskOut](兼容旧调用方);
    with_total=true 返回 {items, total},供管理端分页。
    status 支持逗号多值(如 status=RUNNING,PENDING),按 IN 过滤。
    exclude_type 支持逗号多值(如 exclude_type=chat_scan),按 NOT IN 排除——
    chat_scan 这类每 5 分钟一轮的常驻任务量大无看板价值,各端任务列表都应排除。"""
    q = db.query(Task)
    if device_id:
        q = q.filter(Task.device_id == device_id)
    if job_id:
        q = q.filter(Task.job_id == job_id)
    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if len(statuses) == 1:
            q = q.filter(Task.status == statuses[0])
        elif statuses:
            q = q.filter(Task.status.in_(statuses))
    if exclude_type:
        excludes = [t.strip() for t in exclude_type.split(",") if t.strip()]
        if excludes:
            q = q.filter(Task.task_type.notin_(excludes))
    q = q.order_by(Task.created_at.desc())
    if with_total:
        total = q.count()
        items = q.offset((page - 1) * page_size).limit(page_size).all()
        return {"items": [TaskOut.model_validate(t) for t in items], "total": total}
    return q.offset((page - 1) * page_size).limit(page_size).all()


@router.get("/api/gc/tasks/{task_id}", dependencies=[Depends(require_ops_access)], response_model=TaskOut, tags=["task"])
def get_task(task_id: str, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task


@router.get("/api/gc/tasks/{task_id}/trace", dependencies=[Depends(require_ops_access)], response_model=TaskReplayOut, tags=["task"])
def get_task_trace(task_id: str, db: Session = Depends(get_db)):
    """任务回放:流程发出的每个动作(打开页面/点击/输入/滑动…)、耗时、出错,和动作后的截图。
    跑着的任务给到目前为止的步骤(后台轮询看走到哪一步);截图是 30 分钟的限时直链。"""
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return build_replay(task)


@router.post("/api/gc/tasks", dependencies=[Depends(require_ops_access)], response_model=TaskOut, tags=["task"])
async def create_task(body: TaskCreate, db: Session = Depends(get_db)):
    """建任务。控制类(重启/清缓存/上报机型)直接下发 cmd;流程类由调度器/引擎接管。"""
    device = db.get(Device, body.device_id)
    if not device:
        raise HTTPException(404, "设备不存在")
    task = Task(
        device_id=body.device_id,
        account_id=body.account_id,
        job_id=body.job_id,
        task_type=body.task_type,
        spec=body.spec,
        source=body.source,
        ref_type=body.ref_type,
        ref_id=body.ref_id,
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    # 控制类任务:走老 cmd 链路直接下发到设备(payload = spec);
    # 流程类(调度器会派的 DISPATCHABLE_TYPES)保持 PENDING 交调度器——否则会卡 DISPATCHED 永不被派
    # (调度器只收 PENDING;2026-09-09 实测 goods_publish 经此入口卡死)。
    if body.task_type in DISPATCHABLE_TYPES:
        return task
    frame = {"task_id": task.id, "task_type": task.task_type, "payload": task.spec or {}}
    try:
        await bridge.publish_cmd(task.device_id, frame)
        task.status = TaskStatus.DISPATCHED
        task.dispatched_at = datetime.utcnow()
        db.commit()
        db.refresh(task)
    except Exception as e:
        logger.warning("下发失败 task=%s: %s", task.id, e)
        # 保持 PENDING，可稍后重发
    return task


# ==================== 账号 ====================
@router.post("/api/gc/accounts", dependencies=[Depends(require_internal_or_admin)], response_model=AccountOut, tags=["account"])
def create_account(body: AccountCreate, db: Session = Depends(get_db)):
    if body.device_id and not db.get(Device, body.device_id):
        raise HTTPException(404, "设备不存在")
    acc = Account(nick=body.nick, device_id=body.device_id)
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return acc


@router.post("/api/gc/accounts/bind", dependencies=[Depends(require_internal_or_admin)], response_model=AccountOut, tags=["account"])
def bind_account(body: AccountBind, db: Session = Depends(get_db)):
    """按闲鱼账号名(nick)唯一 upsert:同名只更新设备号,不存在则新建。

    这就是「设备号↔闲鱼账号名」映射表(用 gc Account 承载):ERP 上架前按
    SaleShop.xianyu_user_name 调这个接口拿到/建好对应 gc 账号,再用其 id 发 publish_batch。
    """
    if body.device_id and not db.get(Device, body.device_id):
        raise HTTPException(404, "设备不存在")
    acc = db.query(Account).filter(Account.nick == body.nick).first()
    if acc:
        if body.device_id is not None:
            acc.device_id = body.device_id   # 同名更新设备号
    else:
        acc = Account(nick=body.nick, device_id=body.device_id)
        db.add(acc)
    db.commit()
    db.refresh(acc)
    return acc


@router.get("/api/gc/accounts", dependencies=[Depends(require_ops_access)], response_model=list[AccountOut], tags=["account"])
def list_accounts(nick: str | None = Query(None), db: Session = Depends(get_db)):
    q = db.query(Account)
    if nick:
        q = q.filter(Account.nick == nick)   # ERP 按闲鱼账号名解析到 gc 账号
    return q.order_by(Account.created_at.desc()).all()


def _is_unfreeze(fields: dict) -> bool:
    """只做「解冻」:status 回 ACTIVE,另外最多把风控清掉(risk_state NORMAL、risk_note 置空)。"""
    if fields.get("status") != "ACTIVE" or not set(fields) <= {"status", "risk_state", "risk_note"}:
        return False
    return fields.get("risk_state", "NORMAL") == "NORMAL" and not fields.get("risk_note")


@router.patch("/api/gc/accounts/{account_id}", dependencies=[Depends(require_ops_access)], response_model=AccountOut, tags=["account"])
def update_account(account_id: str, body: AccountUpdate, request: Request,
                   db: Session = Depends(get_db), staff: dict | None = Depends(optional_staff)):
    """改账号。本机直连或管理员令牌什么都能改;别的请求**只能解冻**。

    其余字段(换绑设备、改昵称、改配额)以前公网谁都能改——换绑设备等于把这个号的
    上下架派到别的机器上。

    「解冻」= status 回 ACTIVE,可连带清风控(risk_state 回 NORMAL、清空 risk_note)。
    命中风控时 runner 两个都冻(status 与 risk_state),调度器两个都看——只改 status 的
    老解冻对风控冻结的号不起作用(2026-10-06 发现),所以这里允许把风控一起清掉。
    """
    fields = body.model_dump(exclude_unset=True)
    if not is_trusted(request, staff) and not _is_unfreeze(fields):
        raise HTTPException(401 if not staff else 403, "只有解冻可以不登录;改别的要管理员")
    acc = db.get(Account, account_id)
    if not acc:
        raise HTTPException(404, "账号不存在")
    for k, v in fields.items():
        setattr(acc, k, v)
    db.commit()
    db.refresh(acc)
    return acc


# ==================== 执行单元(账号 + 它当前的执行端)====================
@router.get("/api/gc/units", response_model=list[UnitOut], tags=["unit"])
def list_units(kind: str | None = Query(None), db: Session = Depends(get_db),
               user: dict | None = Depends(require_ops_access)):
    """执行单元列表:一个闲鱼账号一行,真机与浏览器混在一起。

    桌面守护端「执行单元管理」页的唯一数据源。账号是主体(风控/配额挂在账号上),
    执行端是它当前的属性——手机坏了换一台,账号不变。kind 可按 android/browser 筛。
    wk_ 个人 key 通道抹掉设备串号(机密抹除口径与设备列表一致)。

    三次查询封顶(账号全量 / 设备全量 / 今日用量 group by),不随账号数放大。
    """
    accounts = db.query(Account).order_by(Account.created_at.desc()).all()
    devices = {d.id: d for d in db.query(Device).all()}

    # 今日已用:与 scheduler 的配额闸同口径(SUCCESS + finished_at 落在北京日界内),
    # 一条 group by 覆盖所有账号,避免按账号 N 次 count。
    lo, hi = _cn_today_utc_range()
    used: dict[tuple[str, str], int] = {}
    rows = (
        db.query(Task.account_id, Task.task_type, func.count(Task.id))
        .filter(
            Task.account_id.isnot(None),
            Task.status == TaskStatus.SUCCESS,
            Task.finished_at >= lo,
            Task.finished_at < hi,
        )
        .group_by(Task.account_id, Task.task_type)
        .all()
    )
    for acc_id, task_type, n in rows:
        cat = QUOTA_CATEGORY.get(task_type)
        if cat in _QUOTA_FIELD:
            used[(acc_id, cat)] = used.get((acc_id, cat), 0) + n

    # 在跑任务:只取设备 busy_task_id 指到的那几条(端侧无队列,一机一任务)
    busy_ids = [d.busy_task_id for d in devices.values() if d.busy_task_id]
    busy = (
        {t.id: t for t in db.query(Task).filter(Task.id.in_(busy_ids)).all()}
        if busy_ids else {}
    )

    out: list[UnitOut] = []
    # 直接调本函数的测试不传 user(Depends 对象),isinstance 挡一下
    wk_channel = isinstance(user, dict) and user.get("via") == "wk"
    for acc in accounts:
        dev = devices.get(acc.device_id) if acc.device_id else None
        if kind and (dev.kind if dev else None) != kind:
            continue
        task = busy.get(dev.busy_task_id) if dev and dev.busy_task_id else None
        unit_device = UnitDevice.model_validate(dev) if dev else None
        if unit_device is not None and wk_channel:
            unit_device.serial = None
        out.append(
            UnitOut(
                account_id=acc.id,
                nick=acc.nick,
                status=acc.status,
                risk_state=acc.risk_state,
                risk_note=acc.risk_note,
                active_window=acc.active_window,
                last_op_at=acc.last_op_at,
                device=unit_device,
                quota={
                    cat: UnitQuota(
                        used=used.get((acc.id, cat), 0),
                        limit=getattr(acc, field, 0),
                    )
                    for cat, field in _QUOTA_FIELD.items()
                },
                task=UnitTask.model_validate(task) if task else None,
            )
        )
    return out


# ==================== 作业 Job(扇出闲鱼流程)====================
@router.post("/api/gc/jobs", dependencies=[Depends(require_internal_or_admin)], response_model=JobOut, tags=["job"])
def create_job(body: JobCreate, db: Session = Depends(get_db)):
    """建业务作业并扇出任务。派发由调度器接管(不在此处直接下发)。"""
    if body.job_type == "publish_batch":
        if not body.sku or not body.account_ids:
            raise HTTPException(400, "publish_batch 需 sku + account_ids")
        try:
            job = jobs.create_publish_batch(db, body.sku, body.account_ids, body.spec or {},
                                            body.source or "MANUAL",
                                            worry_free_by_account=body.worry_free_by_account)
        except ValueError as e:
            # PublishSpec 校验不过(缺图/隐私图/库位图/无效价/运费超限)→ 400,别让脏 spec 扇出上架。
            # 记 warning 留痕:HTTPException detail 只回客户端、不落 journalctl,不记则事后无从排查为何被拒。
            logger.warning("publish_batch 拒收(sku=%s account=%s): %s", body.sku, body.account_ids, e)
            raise HTTPException(400, str(e))
    elif body.job_type == "delist_sku":
        if not body.sku:
            raise HTTPException(400, "delist_sku 需 sku")
        if body.account_ids is not None and not body.account_ids:
            # 空列表 ≠ 不传:不传是全账号,空列表是谁都不下——多半是调用方算错了,别建个空作业
            raise HTTPException(400, "delist_sku 的 account_ids 不能是空列表(不传 = 全账号)")
        job = jobs.create_delist_sku(db, body.sku, body.source or "MANUAL", account_ids=body.account_ids)
    elif body.job_type == "reprice_batch":
        if not body.items:
            raise HTTPException(400, "reprice_batch 需 items")
        job = jobs.create_reprice_batch(db, body.items, body.source or "MANUAL")
    elif body.job_type == "relist_sku":
        if not body.sku:
            raise HTTPException(400, "relist_sku 需 sku")
        job = jobs.create_relist_sku(db, body.sku, body.source or "MANUAL")
    elif body.job_type == "polish_account":
        if not body.account_ids:
            raise HTTPException(400, "polish_account 需 account_ids")
        job = jobs.create_polish(db, body.account_ids, body.source or "MANUAL")
    elif body.job_type == "refresh_listing":
        if not body.listing_id or not body.spec:
            raise HTTPException(400, "refresh_listing 需 listing_id + spec")
        try:
            job = jobs.create_refresh_listing(db, body.listing_id, body.spec, body.source or "MANUAL")
        except jobs.RefreshRejected as e:
            # 今天不做(状态/在途/额度):不是请求错了,调用方跳过这条、明天再来
            raise HTTPException(409, str(e))
        except ValueError as e:
            logger.warning("refresh_listing 拒收(listing=%s): %s", body.listing_id, e)
            raise HTTPException(400, str(e))
    else:
        raise HTTPException(400, f"未知 job_type {body.job_type}")
    return job


@router.get("/api/gc/jobs", dependencies=[Depends(require_internal_or_admin)], response_model=list[JobOut], tags=["job"])
def list_jobs(
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    q = db.query(Job)
    if status:
        q = q.filter(Job.status == status)
    return q.order_by(Job.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()


@router.get("/api/gc/jobs/{job_id}", dependencies=[Depends(require_internal_or_admin)], response_model=JobOut, tags=["job"])
def get_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "作业不存在")
    return job


# ==================== 上架账本 Listing ====================
@router.get("/api/gc/listings", dependencies=[Depends(require_internal_or_admin)], response_model=list[ListingOut], tags=["listing"])
def list_listings(
    sku: str | None = Query(None),
    account_id: str | None = Query(None),
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    q = db.query(Listing)
    if sku:
        q = q.filter(Listing.sku == sku)
    if account_id:
        q = q.filter(Listing.account_id == account_id)
    if status:
        q = q.filter(Listing.status == status)
    return q.order_by(Listing.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()


@router.post("/api/gc/listings/recode", dependencies=[Depends(require_internal_or_admin)], tags=["listing"])
def listing_recode(body: ListingRecodeIn, db: Session = Depends(get_db)):
    """ERP 换了货号,账本跟着改(ERP 售出同步每轮带上全部换码记录,幂等)。"""
    pairs = []
    for p in body.pairs:
        at = None
        if p.get("at"):
            try:
                at = datetime.fromisoformat(str(p["at"]).replace("Z", "")).replace(tzinfo=None)
            except ValueError:
                at = None
        pairs.append(((p.get("old") or "").strip(), (p.get("new") or "").strip(), at))
    return {"updated": jobs.recode_listings(db, pairs)}


@router.get("/api/gc/listings/refresh-candidates", dependencies=[Depends(require_internal_or_admin)], tags=["listing"])
def listing_refresh_candidates(db: Session = Depends(get_db)):
    """今天该焕新(删掉重发)的链接 + 每个号今天还能开几单。ERP 每天定时来拉,见 jobs.refresh_candidates。"""
    return jobs.refresh_candidates(db)


@router.get("/api/gc/listings/refresh-status", dependencies=[Depends(require_internal_or_admin)], tags=["listing"])
def listing_refresh_status(sku: str = Query(...), db: Session = Depends(get_db)):
    """这件货各条链接的上架时间和现在能不能重新上架。ERP 商品详情页用,见 jobs.refresh_status。"""
    return jobs.refresh_status(db, sku)


# ==================== 聊天(会话/消息,只读)====================
@router.get("/api/gc/chat/conversations", response_model=list[ConversationOut], tags=["chat"])
def list_conversations(
    account_id: str | None = Query(None),
    page: int = Query(1, ge=1),
    size: int = Query(30, ge=1, le=100),
    user: dict = Depends(require_chat_access),
    db: Session = Depends(get_db),
):
    q = db.query(Conversation)
    if account_id:
        q = q.filter(Conversation.account_id == account_id)
    rows = (
        q.order_by(Conversation.updated_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    nicks = {a.id: a.nick for a in db.query(Account).all()}
    for r in rows:
        _decorate_conversation(r, nicks.get(r.account_id))
    return rows


def _decorate_conversation(row: Conversation, account_nick: str | None) -> Conversation:
    """查询时补的展示字段:归属账号昵称、闲鱼商品页链接。"""
    row.account_nick = account_nick
    row.item_url = f"https://www.goofish.com/item?id={row.item_id}" if row.item_id else None
    return row


@router.get("/api/gc/chat/conversations/{conversation_id}", response_model=ConversationOut, tags=["chat"])
def get_conversation(
    conversation_id: str,
    user: dict = Depends(require_chat_access),
    db: Session = Depends(get_db),
):
    """单个会话(聊天详情页):商品卡、对上的货号、闲鱼链接。"""
    row = db.get(Conversation, conversation_id)
    if not row:
        raise HTTPException(status_code=404, detail="会话不存在")
    acc = db.get(Account, row.account_id) if row.account_id else None
    return _decorate_conversation(row, acc.nick if acc else None)


@router.get(
    "/api/gc/chat/conversations/{conversation_id}/messages",
    response_model=list[ChatMessageOut],
    tags=["chat"],
)
def list_messages(
    conversation_id: str,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    tail: bool = Query(False, description="true = 取最新的 size 条(仍按时间从旧到新排);聊天页用这个"),
    user: dict = Depends(require_chat_access),
    db: Session = Depends(get_db),
):
    q = db.query(ChatMessage).filter(ChatMessage.conversation_id == conversation_id)
    if tail:
        rows = q.order_by(ChatMessage.created_at.desc()).limit(size).all()[::-1]
    else:
        rows = q.order_by(ChatMessage.created_at.asc()).offset((page - 1) * size).limit(size).all()
    return [
        ChatMessageOut(
            id=r.id, direction=r.direction, text=r.text, msg_at=r.msg_at, created_at=r.created_at,
            media=chat_media.media_out(r.media), card=r.card,
        )
        for r in rows
    ]


@router.post("/api/gc/chat/conversations/{conversation_id}/reply", tags=["chat"])
def reply_conversation(
    conversation_id: str,
    body: ChatReplyIn,
    user: dict = Depends(require_chat_access),
    db: Session = Depends(get_db),
):
    """人工回复(1b):建 chat_reply 任务,由会话归属账号的设备进会话发文本(或图片 / 视频)。

    异步链路:返回即已建单,真正发送由调度器派发到设备执行(受操作间隔节流),
    成功后 out 消息自动落库(下次 chat_scan 读到同文气泡按方向+原文认出,不重复记)。
    task_id 给小程序轮询这条发没发出去(ERP GET /api/gc-ops/tasks/{task_id})。
    图片 / 视频只在 chat_media_enabled 打开后收(网页版上传控件实测之前一律拒,不建单)。
    """
    media = None
    if body.media:
        if not settings.chat_media_enabled:
            raise HTTPException(status_code=409, detail="发图片和视频还没开通:要先用自己的号测通,再打开")
        conv = db.get(Conversation, conversation_id)
        acc = db.get(Account, conv.account_id) if conv and conv.account_id else None
        dev = db.get(Device, acc.device_id) if acc and acc.device_id else None
        if dev is not None and dev.kind != "browser":
            raise HTTPException(status_code=409, detail="安卓号还不能在聊天里发图片和视频,请用浏览器号的会话发")
        try:
            media = chat_media.prepare_images(chat_media.normalize_media([m.model_dump() for m in body.media]))
        except ValueError as ex:
            raise HTTPException(status_code=400, detail=str(ex))
    try:
        job = jobs.create_chat_reply(db, conversation_id, body.text or "", media=media,
                                     card=body.card.model_dump() if body.card else None,
                                     by_id=user.get("staff_id"), by_name=user.get("name"))
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex))
    task_id = db.query(Task.id).filter(Task.job_id == job.id).scalar()
    return {"ok": True, "job_id": job.id, "task_id": task_id}


_ITEM_ID_IN_URL = re.compile(r"(?:[?&](?:id|itemId|item_id)=|/item/)(\d{6,})")


@router.get("/api/gc/chat/resolve-item", tags=["chat"])
def resolve_item(
    url: str = Query(..., min_length=1, max_length=2048),
    user: dict = Depends(require_chat_access),
    db: Session = Depends(get_db),
):
    """粘贴的闲鱼商品链接 → 我们哪件货(ERP 货号)。聊天页对不上货时让客服贴链接用。

    只认链接里的商品 id;短链(m.tb.cn 之类)要先在闲鱼里打开拿到长链接。在架的优先。
    """
    m = _ITEM_ID_IN_URL.search(url)
    if not m:
        raise HTTPException(status_code=400, detail="链接里没找到商品 id,请贴闲鱼商品页的完整链接")
    item_id = m.group(1)
    rows = db.query(Listing).filter(Listing.item_id == item_id).order_by(Listing.created_at.desc()).all()
    if not rows:
        raise HTTPException(status_code=404, detail="这条链接不是我们店里发的货")
    live = [r for r in rows if r.status in (ListingStatus.LIVE, ListingStatus.UNCERTAIN)]
    lst = (live or rows)[0]
    return {"sku": lst.sku, "item_id": item_id, "account_id": lst.account_id, "status": lst.status}


# 闲鱼买家付款后会话里出的系统消息:「我已付款，等待你发货」。一条 = 一笔付款
_PAID_TEXT = "我已付款"


# 不放在 /api/gc/chat/ 下:那一段都要员工的聊天权限(test_chat_routes_gated),这两条只给 ERP 本机调
@router.get("/api/gc/virtual/paid", dependencies=[Depends(require_internal_or_admin)], tags=["chat"])
def chat_paid(
    item_ids: str = Query(..., min_length=1, max_length=4000, description="闲鱼商品 id,逗号分隔"),
    db: Session = Depends(get_db),
):
    """ERP 虚拟商品(卡券)用:这些闲鱼商品的会话,当前订单状态 + 每一条「我已付款」消息。

    虚拟商品不走群控上架账本(人在闲鱼上自己发的),只能从聊天认付款;一条付款消息算一单。
    """
    ids = [x.strip() for x in item_ids.split(",") if x.strip()][:200]
    convs = db.query(Conversation).filter(Conversation.item_id.in_(ids)).all() if ids else []
    paid: dict[str, list[ChatMessage]] = {}
    if convs:
        for m in (db.query(ChatMessage)
                  .filter(ChatMessage.conversation_id.in_([c.id for c in convs]),
                          ChatMessage.direction == "in", ChatMessage.text.contains(_PAID_TEXT))
                  .order_by(ChatMessage.created_at)):
            paid.setdefault(m.conversation_id, []).append(m)
    return [
        {"conversation_id": c.id, "account_id": c.account_id, "item_id": c.item_id,
         "peer_key": c.peer_key, "peer_nick": c.peer_nick, "item_price": c.item_price,
         "order_status": c.order_status, "updated_at": c.updated_at,
         "paid": [{"id": m.id, "at": m.msg_at or m.created_at} for m in paid.get(c.id, [])]}
        for c in convs
    ]


class InternalReplyIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    by_name: str | None = Field(default=None, max_length=64)


@router.post("/api/gc/virtual/send/{conversation_id}", dependencies=[Depends(require_internal_or_admin)], tags=["chat"])
def chat_send_internal(conversation_id: str, body: InternalReplyIn, db: Session = Depends(get_db)):
    """ERP 替人发一条文字(虚拟商品发卡券):和人工回复同一条链路,只是凭据是本机直连。"""
    try:
        job = jobs.create_chat_reply(db, conversation_id, body.text, by_name=body.by_name or "ERP")
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex))
    task_id = db.query(Task.id).filter(Task.job_id == job.id).scalar()
    return {"ok": True, "job_id": job.id, "task_id": task_id}


@router.get("/api/gc/chat/reply-rate", tags=["chat"])
def chat_reply_rate(
    account_id: str | None = Query(None),
    by_account: bool = Query(False, description="按账号拆分,聚合台左栏用"),
    user: dict = Depends(require_chat_access),
    db: Session = Depends(get_db),
):
    """当日消息回复率(M1 销售看板)。

    平台把回复率算进核心考核,这也是 50 秒兜底存在的理由。口径按**会话**算:
    买家连发三条、销售回一条,是一次完整接待,不该算成 1/3。
    """
    from app import chat_stats
    if by_account:
        return chat_stats.reply_rate_by_account(db)
    return chat_stats.reply_rate(db, account_id)


@router.get("/api/gc/chat/overdue", tags=["chat"])
def chat_overdue(
    threshold_sec: int | None = Query(None, ge=1, le=3600),
    user: dict = Depends(require_chat_access),
    db: Session = Depends(get_db),
):
    """当前欠回复的会话(只读预览,不建单)。

    排障用:兜底没触发时先看这里——是判定没命中,还是建了单卡在派发节流上。
    """
    from app import chat_autoreply
    convs = chat_autoreply.overdue_conversations(
        db, threshold_sec=threshold_sec or settings.chat_autoreply_threshold_sec)
    return {
        "threshold_sec": threshold_sec or settings.chat_autoreply_threshold_sec,
        "enabled": settings.chat_autoreply_enabled,
        "count": len(convs),
        "conversations": [
            {"id": c.id, "account_id": c.account_id, "peer_nick": c.peer_nick,
             "item_title": c.item_title, "item_price": c.item_price,
             "item_image": c.item_image,
             "last_message": c.last_message,
             "last_message_at": c.last_message_at}
            for c in convs
        ],
    }


@router.post("/api/gc/chat/conversations/{conversation_id}/read", tags=["chat"])
def mark_conversation_read(
    conversation_id: str,
    user: dict = Depends(require_chat_access),
    db: Session = Depends(get_db),
):
    """人工在小程序打开会话即已读:清零该会话小程序侧未读计数(不影响闲鱼端红点)。"""
    row = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="会话不存在")
    row.unread = 0
    # 消息响应考核：员工在我们这边打开了会话才算「看了」（闲鱼端已读是机器人造成的）
    from app import chat_sla
    chat_sla.on_staff_read(db, row.id, user.get("staff_id"), user.get("name"))
    db.commit()
    return {"ok": True}


# ==================== EMQX HTTP 鉴权 ====================
@router.post("/mqtt/auth", tags=["emqx"])
def mqtt_auth(body: EmqxAuthIn, db: Session = Depends(get_db)):
    """EMQX 认证：后端超级用户放行；否则按 device_id/token 校验。"""
    # 后端桥
    if body.username == settings.mqtt_backend_username:
        if body.password == settings.mqtt_backend_password:
            return {"result": "allow", "is_superuser": True}
        return DENY
    # 设备：username=device_id, password=token
    if body.username and body.password:
        device = db.get(Device, body.username)
        if device and device.token == body.password and device.status != DeviceStatus.DISABLED:
            return {"result": "allow", "is_superuser": False}
    # 拒绝必须留痕：否则设备连不上时后端一片安静，只能去翻 EMQX 日志。
    # 不记密码明文，只记长度——足以区分「没带凭据」和「凭据不对」这两种完全不同的故障。
    logger.warning(
        "MQTT 认证拒绝 clientid=%s username=%r password_len=%s",
        body.clientid, body.username, len(body.password) if body.password else 0,
    )
    return DENY


@router.post("/mqtt/acl", tags=["emqx"])
def mqtt_acl(body: EmqxAclIn):
    """EMQX 授权：设备只能收发自己 gc/{device_id}/# + 订阅广播。"""
    if body.username == settings.mqtt_backend_username:
        return ALLOW
    uid = body.username or ""
    topic = body.topic or ""
    if topic == "gc/broadcast/cmd" or topic.startswith(f"gc/{uid}/"):
        return ALLOW
    return DENY


@router.get("/health", tags=["ops"])
def health():
    return {"ok": True, "mqtt_connected": bridge.connected}


# ---------------------------------------------------------------------------
# 远程取日志：本地软件（执行端 / 桌面端）把最近若干天的日志打包传回来。
#
# 排障的现实是：要日志的时候，那台机器往往正好不在线。所以这里不做在线推送，
# 做**待办**——端上每次心跳、每次启动都问一句，在线就立刻传，不在线就下次启动补传。
# ---------------------------------------------------------------------------

LOG_INBOX = Path(settings.log_inbox_dir)
_MAX_LOG_BYTES = 64 * 1024 * 1024      # 单次上传上限：日志再大也不该把磁盘吃穿


@router.post("/api/gc/logs/request", dependencies=[Depends(require_internal_or_admin)], tags=["logs"])
def request_logs(body: LogRequestIn, db: Session = Depends(get_db)):
    """下一条取日志待办。同一个端已有待办时直接复用，不叠单。"""
    exists = (
        db.query(LogRequest)
        .filter(LogRequest.owner_kind == body.owner_kind, LogRequest.owner_id == body.owner_id,
                LogRequest.status == LogRequestStatus.PENDING)
        .first()
    )
    if exists:
        return {"ok": True, "id": exists.id, "reused": True}
    row = LogRequest(owner_kind=body.owner_kind, owner_id=body.owner_id,
                     # 夹到 1~30：本地只留 30 天，要更久也没有；0/负数夹成 1，
                     # 而不是用 `or 7` 悄悄变成默认值——那会让人以为自己填的数生效了。
                     days=max(1, min(int(body.days), 30)), note=body.note)
    db.add(row)
    db.commit()
    logger.info("取日志待办 %s: %s/%s 最近 %d 天", row.id, row.owner_kind, row.owner_id, row.days)
    return {"ok": True, "id": row.id, "reused": False}


@router.get("/api/gc/logs/pending", tags=["logs"])
def pending_logs(owner_kind: str = Query(...), owner_id: str = Query(...),
                 db: Session = Depends(get_db)):
    """桌面端没有心跳，用这条自己问。执行端走心跳回包，不必调这里。"""
    return {"log_request": _pending_log_request(db, owner_kind, owner_id)}


@router.post("/api/gc/logs/upload", tags=["logs"])
async def upload_logs(request_id: str = Form(...), file: UploadFile = File(...),
                      db: Session = Depends(get_db)):
    row = db.get(LogRequest, request_id)
    if not row:
        raise HTTPException(404, "待办不存在")
    data = await file.read()
    if len(data) > _MAX_LOG_BYTES:
        row.error = f"日志包 {len(data)} 字节，超过上限 {_MAX_LOG_BYTES}"
        db.commit()
        raise HTTPException(413, row.error)
    # 落盘路径按 owner 分目录，文件名用待办 id——同一个端多次取不会互相覆盖。
    # 扩展名跟随上传方：执行端是 Python，用 stdlib 的 zip；桌面端不能引新依赖
    # （热更新只换 out/，装了新 npm 包的机器上没有），用内置 zlib 的 .gz。
    suffix = "".join(Path(file.filename or "").suffixes[-2:]).lower()
    if suffix not in (".zip", ".gz", ".log.gz", ".tar.gz"):
        suffix = ".bin"
    target_dir = LOG_INBOX / row.owner_kind / row.owner_id
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{row.id}{suffix}"
    target.write_bytes(data)
    row.status = LogRequestStatus.UPLOADED
    row.uploaded_at = datetime.utcnow()
    row.size_bytes = len(data)
    row.path = str(target)
    db.commit()
    logger.info("收到日志包 %s: %s/%s %.1f MB", row.id, row.owner_kind, row.owner_id,
                len(data) / 1048576)
    return {"ok": True, "size": len(data)}


@router.get("/api/gc/logs", dependencies=[Depends(require_internal_or_admin)], tags=["logs"])
def list_logs(owner_kind: str | None = Query(None), owner_id: str | None = Query(None),
              limit: int = Query(50, le=200), db: Session = Depends(get_db)):
    q = db.query(LogRequest)
    if owner_kind:
        q = q.filter(LogRequest.owner_kind == owner_kind)
    if owner_id:
        q = q.filter(LogRequest.owner_id == owner_id)
    rows = q.order_by(LogRequest.requested_at.desc()).limit(limit).all()
    return [{
        "id": r.id, "owner_kind": r.owner_kind, "owner_id": r.owner_id, "days": r.days,
        "status": r.status, "note": r.note, "error": r.error,
        "requested_at": r.requested_at, "uploaded_at": r.uploaded_at,
        "size_bytes": r.size_bytes,
    } for r in rows]


# ---------------------------------------------------------------------------
# 行情采集 · 影子模式（S3-0）
#
# 本机仍然自己决定跑什么，只是把**每一次决策与结果**报上来；服务端只记录，不指挥。
# 这是 S3-1 把决策权搬过来之前唯一的对照基准——没有它，搬完只能说「好像还行」，
# 出了问题也分不清是新调度的锅还是本来就这样。
#
# 刻意复用 Job / Task 两张表，不新造一套：失败归因（failed_step / reason）、
# 状态聚合、任务查询全都现成。task_type="market_crawl" **不在 FLOWS 里**，
# 调度器的派发循环因此不会碰它；而且报上来的任务本身就是终态。
# ---------------------------------------------------------------------------

def _upsert_market_rhythm(db: Session, account: str, client_id: str | None,
                          rhythm: dict) -> None:
    """记下这个账号当前在用的节奏。**只存本机报上来的，服务端不往回发**（S3-0）。"""
    row = db.get(MarketAccountConfig, account[:64])
    if row is None:
        row = MarketAccountConfig(account=account[:64])
        db.add(row)
    row.client_id = (client_id or None) and client_id[:64]
    for field in ("throttle_min_ms", "throttle_max_ms",
                  "query_delay_min_ms", "query_delay_max_ms",
                  "daily_enabled", "daily_time"):
        setattr(row, field, rhythm.get(field))
    row.source = "LOCAL_REPORT"
    row.reported_at = datetime.utcnow()


@router.post("/api/gc/market/rounds", tags=["market"])
def report_market_round(body: MarketRoundIn, db: Session = Depends(get_db)):
    """报一轮行情采集。返回 job_id 与落库条数。"""
    if not body.decisions:
        raise HTTPException(400, "一轮至少要有一条决策记录")

    account = (
        db.query(Account).filter(Account.nick == body.account).first()
        or db.get(Account, body.account)
    )
    rhythm = body.rhythm.model_dump() if body.rhythm else None
    job = Job(
        job_type=JobType.MARKET_CRAWL,
        source="LOCAL_SHADOW",          # 与 SCHED/ERP/MANUAL 分得开：这是影子模式的产物
        ref_type="account",
        ref_id=account.id if account else body.account,
        total=len(body.decisions),
        # 节奏记在轮次上，不只记在配置表里：配置表只有"现在是什么样"，
        # 而对照要问的是"**这一轮**是在什么节奏下跑出来的"。参数改过之后，
        # 只有轮次上这份还能把结果和当时的节奏对上号。
        spec={"client_id": body.client_id, "trigger": body.trigger, "rhythm": rhythm},
    )
    db.add(job)
    db.flush()

    now = datetime.utcnow()
    for d in body.decisions:
        if d.action == "skip":
            status = TaskStatus.CANCELLED       # 没跑就不算成功也不算失败
        else:
            status = TaskStatus.SUCCESS if d.ok else TaskStatus.FAILED
        db.add(Task(
            job_id=job.id,
            account_id=account.id if account else None,
            task_type="market_crawl",
            status=status,
            source="LOCAL_SHADOW",
            ref_type="spu",
            ref_id=d.spu[:64],
            spec={"client_id": body.client_id, "account": body.account, "trigger": body.trigger},
            result={"price": d.price, "duration_ms": d.duration_ms, "waited_ms": d.waited_ms,
                    "action": d.action},
            error=d.reason,
            failed_step=d.failed_step,
            started_at=body.started_at or now,
            finished_at=body.finished_at or now,
        ))
    db.commit()

    if rhythm:
        _upsert_market_rhythm(db, body.account, body.client_id, rhythm)
        db.commit()

    from app import jobs as jobs_mod
    jobs_mod._aggregate_job(db, job.id)
    db.commit()
    logger.info("行情影子轮次 %s: 账号=%s 机器=%s %d 条（触发 %s）",
                job.id, body.account, body.client_id, len(body.decisions), body.trigger)
    return {"ok": True, "job_id": job.id, "tasks": len(body.decisions)}


@router.get("/api/gc/market/rounds", tags=["market"])
def market_rounds(days: int = Query(1, ge=1, le=30), db: Session = Depends(get_db)):
    """影子模式的汇总：跑了几轮、哪个账号失败最多、失败在哪一步。

    这三个问题就是 S3-0 的完成判据——现在只能靠翻本机日志才答得出来。
    """
    since = datetime.utcnow() - timedelta(days=days)
    rounds = (
        db.query(Job)
        .filter(Job.job_type == JobType.MARKET_CRAWL, Job.created_at >= since)
        .order_by(Job.created_at.desc()).all()
    )
    job_ids = [j.id for j in rounds]
    tasks = (
        db.query(Task).filter(Task.job_id.in_(job_ids)).all() if job_ids else []
    )

    by_account: dict[str, dict] = {}
    by_step: dict[str, int] = {}
    for t in tasks:
        who = (t.spec or {}).get("account") or "(未知账号)"
        row = by_account.setdefault(who, {"success": 0, "failed": 0, "skipped": 0})
        if t.status == TaskStatus.SUCCESS:
            row["success"] += 1
        elif t.status == TaskStatus.FAILED:
            row["failed"] += 1
            step = t.failed_step or "(未标注)"
            by_step[step] = by_step.get(step, 0) + 1
        else:
            row["skipped"] += 1

    return {
        "days": days,
        "rounds": len(rounds),
        "tasks": len(tasks),
        "by_account": by_account,
        "failed_by_step": dict(sorted(by_step.items(), key=lambda kv: -kv[1])),
        "latest": [{
            "job_id": j.id, "at": j.created_at, "account": j.ref_id,
            "total": j.total, "succeeded": j.succeeded, "failed": j.failed,
            "status": j.status,
        } for j in rounds[:20]],
    }


@router.get("/api/gc/market/config", tags=["market"])
def market_config(db: Session = Depends(get_db)):
    """各账号当前的行情节奏。

    **只读**：这里列的是各台机器**报上来**的值（source=LOCAL_REPORT），
    不是服务端下发的。S3-0 阶段刻意不提供写接口——决策权还在本机，
    服务端这时候要是能改，就成了半路指挥，出了问题两边都说不清。
    S3-1 把决策权搬过来时，才会加下发那一半。
    """
    rows = (
        db.query(MarketAccountConfig)
        .order_by(MarketAccountConfig.reported_at.desc()).all()
    )
    return {
        "writable": False,
        "accounts": [{
            "account": r.account,
            "client_id": r.client_id,
            "throttle_min_ms": r.throttle_min_ms,
            "throttle_max_ms": r.throttle_max_ms,
            "query_delay_min_ms": r.query_delay_min_ms,
            "query_delay_max_ms": r.query_delay_max_ms,
            "daily_enabled": r.daily_enabled,
            "daily_time": r.daily_time,
            "source": r.source,
            "reported_at": r.reported_at,
        } for r in rows],
    }


# ==================== 消息响应考核（chat_sla.py） ====================
# 都只给 ERP 内部调（后台「群控 → 消息响应」经 ERP /api/gc-ops/chat-sla 转发，角色在 ERP 那边管）或管理员令牌
class ChatSlaConfIn(BaseModel):
    enabled: bool | None = None
    read_min: int | None = Field(default=None, ge=1, le=240)
    reply_min: int | None = Field(default=None, ge=1, le=1440)
    quiet_start: int | None = Field(default=None, ge=0, le=23)
    quiet_end: int | None = Field(default=None, ge=0, le=23)


class AccountOwnersIn(BaseModel):
    owners: list[dict] = Field(default_factory=list, description="[{staff_id, staff_name}]")


@router.get("/api/gc/chat-sla/settings", tags=["chat"])
def chat_sla_settings(user: dict = Depends(require_internal_or_admin), db: Session = Depends(get_db)):
    from app import chat_sla
    return chat_sla.get_conf(db)


@router.put("/api/gc/chat-sla/settings", tags=["chat"])
def chat_sla_save_settings(body: ChatSlaConfIn, user: dict = Depends(require_internal_or_admin), db: Session = Depends(get_db)):
    from app import chat_sla
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    if ("quiet_start" in data) != ("quiet_end" in data):
        raise HTTPException(status_code=400, detail="夜间不考核要同时给起止点钟")
    try:
        return chat_sla.set_conf(db, data, user.get("name") or user.get("staff_id"))
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex))


@router.get("/api/gc/chat-sla/owners", tags=["chat"])
def chat_sla_owners(user: dict = Depends(require_internal_or_admin), db: Session = Depends(get_db)):
    """每个闲鱼号的负责人。没列出的号就是还没指定。"""
    from app.models import AccountOwner
    out: dict[str, list] = {}
    for o in db.query(AccountOwner).all():
        out.setdefault(o.account_id, []).append({"staff_id": o.staff_id, "staff_name": o.staff_name})
    return out


@router.put("/api/gc/chat-sla/owners/{account_id}", tags=["chat"])
def chat_sla_set_owners(account_id: str, body: AccountOwnersIn, user: dict = Depends(require_internal_or_admin),
                        db: Session = Depends(get_db)):
    from app.models import AccountOwner
    if not db.get(Account, account_id):
        raise HTTPException(status_code=404, detail="账号不存在")
    db.query(AccountOwner).filter(AccountOwner.account_id == account_id).delete()
    seen = set()
    for o in body.owners:
        sid = str(o.get("staff_id") or "").strip()
        if sid and sid not in seen:
            seen.add(sid)
            db.add(AccountOwner(account_id=account_id, staff_id=sid, staff_name=(o.get("staff_name") or None)))
    db.commit()
    return chat_sla_owners(user, db).get(account_id, [])


@router.get("/api/gc/chat-sla/waiting", tags=["chat"])
def chat_sla_waiting(user: dict = Depends(require_internal_or_admin), db: Session = Depends(get_db)):
    """现在还在等我们回复的会话：等了多久（扣掉夜间）、有没有人看、提醒/升级了没有。"""
    from app import chat_sla
    from app.models import ChatSla
    conf = chat_sla.get_conf(db)
    now = datetime.utcnow()
    rows = db.query(ChatSla).filter(ChatSla.closed_at.is_(None)).order_by(ChatSla.await_since).limit(300).all()
    items = []
    for c in rows:
        conv = db.get(Conversation, c.conversation_id)
        acc = db.get(Account, c.account_id) if c.account_id else None
        items.append({
            "conversation_id": c.conversation_id,
            "account": (acc.nick if acc else None) or c.account_id,
            "buyer": (conv.peer_nick or conv.peer_key) if conv else None,
            "item_title": conv.item_title if conv else None,
            "last_message": conv.last_message if conv else None,
            "await_since": c.await_since,
            "waited_sec": round(chat_sla.effective_seconds(c.await_since, now, conf)),
            "read_by": c.read_by_name,
            "read_at": c.read_at,
            "reminded": bool(c.reminded_at),
            "escalated": bool(c.escalated_at),
            "owners": [o.staff_name or o.staff_id for o in chat_sla.owners_of(db, c.account_id)],
        })
    return {"items": items, "conf": conf}


@router.get("/api/gc/chat-sla/stats", tags=["chat"])
def chat_sla_stats(
    date_from: str = Query(..., description="北京时间日期 YYYY-MM-DD(含)"),
    date_to: str = Query(..., description="北京时间日期 YYYY-MM-DD(含)"),
    user: dict = Depends(require_internal_or_admin),
    db: Session = Depends(get_db),
):
    from app import chat_sla
    try:
        start = datetime.strptime(date_from, "%Y-%m-%d") - chat_sla.CN
        end = datetime.strptime(date_to, "%Y-%m-%d") - chat_sla.CN + timedelta(days=1)
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式 YYYY-MM-DD")
    return chat_sla.staff_stats(db, start, end)
