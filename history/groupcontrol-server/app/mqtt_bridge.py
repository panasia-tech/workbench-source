"""MQTT 桥:后端以超级用户连 EMQX。

两条通道并存:
1. 老的任务链路:订 gc/+/report、gc/+/status;发 gc/{id}/cmd(控制类任务、在线态)。
2. 新的原语 RPC 链路(V2 大脑在服务端):发 gc/{id}/rpc {req_id,op,args},
   订 gc/+/rpc_resp {req_id,ok,data,err};每个 req_id 挂一个 Future,收到 resp 唤醒。
   流程引擎(app/flow/)用它把「截屏/点/滑/dump/输入」等原语同步派到手机。

同步 SQLAlchemy 写库放线程池,避免阻塞事件循环。
"""

import asyncio
import json
import logging
import threading
from datetime import datetime
from uuid import uuid4

import aiomqtt

from app.config import settings
from app.database import SessionLocal
from app.models import (
    LOGIN_LOST_NOTE,
    LOGIN_LOST_NOTIFIED,
    REPORT_STATUS_MAP,
    is_login_lost_freeze,
    TERMINAL_TASK_STATUS,
    Account,
    AccountStatus,
    Device,
    DeviceStatus,
    RiskState,
    Task,
    TaskStatus,
)

logger = logging.getLogger("gc.bridge")

# 账号未设昵称时闲鱼昵称位的占位文案(旧版 App 不过滤会上报);不作为绑定依据,
# 否则多台未命名设备会按 nick 挤进同一个 Account 互相顶设备。
# identity 帧 nick 的占位文案:未登录/未读到的兜底值,不参与账号 upsert。
# 「登录」是闲鱼网页版未登录态 header 的登录入口文案(浏览器执行端锚点会误读到它,2026-09-09 线上实测)。
_NICK_PLACEHOLDERS = frozenset({"昵称未填写", "登录", "登录/注册", "注册", "立即登录"})

# chat_hint 的同账号最小间隔闸(account_id → 上次建单时刻)。进程内即可:它防的是
# 执行端异常刷帧,不是业务正确性——真正的去重是 jobs.create_chat_scan 的在途判定。
_LAST_HINT_AT: dict[str, datetime] = {}


class RpcError(Exception):
    """原语 RPC 失败(设备回 ok=false 或超时)。"""


class MqttBridge:
    def __init__(self) -> None:
        self._client: aiomqtt.Client | None = None
        self._ready = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._stop = False
        # req_id -> Future,收到 rpc_resp 时唤醒
        self._pending: dict[str, asyncio.Future] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop = True
        if self._task:
            self._task.cancel()

    async def _run(self) -> None:
        while not self._stop:
            try:
                async with aiomqtt.Client(
                    hostname=settings.mqtt_host,
                    port=settings.mqtt_port,
                    username=settings.mqtt_backend_username,
                    password=settings.mqtt_backend_password,
                    identifier="gc-backend",
                ) as client:
                    self._client = client
                    self._ready.set()
                    await client.subscribe("gc/+/report", qos=1)
                    await client.subscribe("gc/+/status", qos=1)
                    await client.subscribe("gc/+/rpc_resp", qos=1)
                    # 端上纯文本日志(QoS0)。此前没订这个 topic,执行端 mqtt_client.log()
                    # 发出去没人收,端侧日志只存在于那台机器的 logs/ 文件里——出了问题
                    # 服务端这边什么都看不到。落到 gc-api 的 journal,排查时和派发/流程
                    # 日志在同一条时间线上。
                    await client.subscribe("gc/+/log", qos=0)
                    logger.info("bridge 已连 EMQX %s:%s", settings.mqtt_host, settings.mqtt_port)
                    async for message in client.messages:
                        await self._handle(message)
            except aiomqtt.MqttError as e:
                self._ready.clear()
                self._client = None
                # 断线时唤醒所有挂起的 RPC,避免流程永久卡住
                self._fail_all_pending(f"MQTT 断开:{e}")
                logger.warning("bridge 连接断开:%s(3s 后重连)", e)
                await asyncio.sleep(3)
            except asyncio.CancelledError:
                break

    # ==================== 老链路:控制类任务下发 ====================
    async def publish_cmd(self, device_id: str, obj: dict) -> None:
        await asyncio.wait_for(self._ready.wait(), timeout=5)
        assert self._client is not None
        await self._client.publish(f"gc/{device_id}/cmd", json.dumps(obj), qos=1)

    # ==================== 新链路:原语 RPC ====================
    async def rpc(self, device_id: str, op: str, args: dict | None = None, timeout: float = 15.0) -> dict:
        """向设备发一个原语,同步等待其结果。失败/超时抛 RpcError。

        流程引擎调用:如 await bridge.rpc(dev, "screencap") / rpc(dev, "tap", {"x":1,"y":2})。
        """
        await asyncio.wait_for(self._ready.wait(), timeout=5)
        assert self._client is not None and self._loop is not None
        req_id = uuid4().hex
        fut: asyncio.Future = self._loop.create_future()
        self._pending[req_id] = fut
        frame = {"req_id": req_id, "op": op, "args": args or {}}
        try:
            await self._client.publish(f"gc/{device_id}/rpc", json.dumps(frame), qos=1)
            resp = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            raise RpcError(f"原语 {op} 超时({timeout}s) device={device_id}")
        finally:
            self._pending.pop(req_id, None)
        if not resp.get("ok"):
            raise RpcError(f"原语 {op} 失败:{resp.get('err')}")
        return resp.get("data") or {}

    def _fail_all_pending(self, reason: str) -> None:
        for req_id, fut in list(self._pending.items()):
            if not fut.done():
                fut.set_exception(RpcError(reason))
        self._pending.clear()

    @property
    def connected(self) -> bool:
        return self._ready.is_set()

    # ==================== 收帧分发 ====================
    async def _handle(self, message) -> None:
        topic = str(message.topic)
        parts = topic.split("/")
        if len(parts) != 3 or parts[0] != "gc":
            return
        device_id, kind = parts[1], parts[2]
        if kind == "log":
            # log 是纯文本,不能进下面的 json.loads(会被当成解析失败丢掉)
            text = message.payload.decode("utf-8", "replace").strip()
            if text:
                logger.info("设备 %s log: %s", device_id, text[:1000])
            return
        try:
            data = json.loads(message.payload)
        except Exception:
            logger.warning("无法解析 %s: %r", topic, message.payload[:200])
            return
        if kind == "status":
            await asyncio.to_thread(_apply_status, device_id, data)
        elif kind == "report":
            await asyncio.to_thread(_apply_report, device_id, data)
        elif kind == "rpc_resp":
            self._resolve_rpc(data)

    def _resolve_rpc(self, data: dict) -> None:
        req_id = data.get("req_id")
        fut = self._pending.get(req_id)
        if fut and not fut.done():
            fut.set_result(data)


def _apply_status(device_id: str, data: dict) -> None:
    with SessionLocal() as db:
        device = db.get(Device, device_id)
        if not device or device.status == DeviceStatus.DISABLED:
            return
        online = bool(data.get("online"))
        device.status = DeviceStatus.ONLINE if online else DeviceStatus.OFFLINE
        if online:
            device.last_online_at = datetime.utcnow()
            if data.get("app_version"):
                device.app_version = data["app_version"]
        elif device.busy_task_id:
            # 掉线**不能**无条件释放占用:服务端那条流程的线程还活着(设备掉线后它要等下一个
            # 原语 RPC 超时 15s 才崩)。一清占用,调度器 3s 内就把下一个任务派到同一台机器,
            # 两条流程同时驱动同一部手机 —— 而每条流程开场都是 force_stop(闲鱼)(见
            # flow/ready.py 范式),后进来的那条直接把前一条正在编辑的页面连草稿一起杀掉。
            # 2026-08-18 生产实测:设备 ea4de557 两次 MQTT 抖动后,13:44:35 派下的 chat_scan
            # 还在跑,13:45:39 又被派进 goods_publish,发布在最后一步崩掉。
            # 正确的释放点只有一个:流程线程自己收尾时的 runner._finish。
            # 这里只清「占用指向的任务已终态/已不存在」的陈旧占用(report 帧丢包等),
            # 真正在跑的占用留给 _finish;线程都没了的残留(如 gc-api 重启)由 watchdog 自愈。
            busy = db.get(Task, device.busy_task_id)
            if busy is None or busy.status in TERMINAL_TASK_STATUS:
                device.busy_task_id = None
        db.commit()
        logger.info("设备 %s -> %s", device_id, device.status)


def _apply_report(device_id: str, data: dict) -> None:
    # identity 帧(app 连上/昵称变化/自检后经 gc/{id}/report 上报):持久化就绪态 + 自动绑 nick。
    # 走 report 通道但没有 task_id,必须在 task 逻辑之前拦下,且**绝不**碰 Device.status(online 归 status 帧)。
    if data.get("kind") == "identity":
        _apply_identity(device_id, data)
        return
    # event 帧(kind=event):无障碍断链等系统事件告警,无 task_id,同样要在 task 逻辑前拦下。
    # 契约:只记最近一次事件到 Device.last_event/last_event_at,**绝不**碰 Device.status。
    if data.get("kind") == "event":
        _apply_event(device_id, data)
        return
    # chat_hint 帧(kind=chat_hint):浏览器执行端常驻 /im 页看到未读上涨,提示「现在就扫一轮」。
    # 无 task_id,同样要在 task 逻辑前拦下。契约:只建 chat_scan 任务,**不写**会话/消息表
    # (消息仍由 chat_scan 正式入库,门铃只负责提前触发),也不碰 Device.status。
    if data.get("kind") == "chat_hint":
        _apply_chat_hint(device_id, data)
        return
    # exit_info 帧(kind=exit_info):设备上次进程死因(ApplicationExitInfo),无 task_id。
    # 契约:只记死因到 Device.last_exit_reason/last_exit_at,**绝不**碰 Device.status。
    if data.get("kind") == "exit_info":
        _apply_exit_info(device_id, data)
        return
    task_id = data.get("task_id")
    if not task_id:
        return
    with SessionLocal() as db:
        device = db.get(Device, device_id)
        if device:
            device.last_report_at = datetime.utcnow()
        task = db.get(Task, task_id)
        if not task:
            db.commit()
            return
        # 终态守卫:QoS1 会重投,已 SUCCESS/FAILED 的任务不被迟到的 run/wait 帧回退
        if task.status in TERMINAL_TASK_STATUS:
            db.commit()
            return
        raw = (data.get("status") or "").lower()
        mapped = REPORT_STATUS_MAP.get(raw)
        if mapped:
            task.status = mapped
            if mapped == TaskStatus.RUNNING and not task.started_at:
                task.started_at = datetime.utcnow()
            if mapped in (TaskStatus.SUCCESS, TaskStatus.FAILED):
                task.finished_at = datetime.utcnow()
                if device and device.busy_task_id == task_id:
                    device.busy_task_id = None
        if data.get("progress") is not None:
            task.progress = str(data["progress"])
        if data.get("mark") is not None:
            task.mark = data["mark"]
        if data.get("error"):
            task.error = data["error"]
        if data.get("result") is not None:
            task.result = data["result"]
        db.commit()
        logger.info("任务 %s -> %s", task_id, task.status)


def _apply_event(device_id: str, data: dict) -> None:
    """event 帧持久化:最近一次系统事件落 Device(供后台/排障查看),**不动** Device.status。

    帧:{"kind":"event","event":"accessibility_lost","detail":"...","ts":ms}
    """
    event = data.get("event") or "unknown"
    detail = data.get("detail")
    last_event = f"{event}: {detail}" if detail else event
    with SessionLocal() as db:
        device = db.get(Device, device_id)
        if device:
            device.last_event = last_event[:255]
            device.last_event_at = datetime.utcnow()
            device.last_report_at = datetime.utcnow()
            db.commit()
    logger.info("设备 %s event: %s", device_id, last_event)


def _apply_chat_hint(device_id: str, data: dict) -> None:
    """chat_hint 帧:未读上涨 → 立刻给该设备的账号建一单 chat_scan。

    帧:{"kind":"chat_hint","reason":"unread_up",
        "convs":[{"nick":"x***8","from":0,"to":1}],"unread_total":1,"ts":ms}

    为什么需要它:会话此前只靠 chat_scan 每 chat_scan_interval_sec(300s)一轮拉取。
    浏览器执行端驱动的是**采购账号**(2026-09-13 定的划分:AdsPower 这批环境是采购端,
    销售留在安卓 App 群控),采购要跟卖家谈价抢单,五分钟才知道对面回了话就晚了。
    门铃把「知道」的延迟压到秒级,判定本身仍以消息自带的时间戳为准。

    去重两道:jobs.create_chat_scan 对在途任务本就去重(账号维度);这里再加一道同账号
    最小间隔,防执行端异常刷帧把任务表刷满。周期扫描保持不动——门铃是加速通道,
    不是替代品,长连接断了照样有人兜底。
    """
    from app import jobs  # 延迟导入避免环

    if not settings.chat_hint_enabled:
        return
    now = datetime.utcnow()
    with SessionLocal() as db:
        device = db.get(Device, device_id)
        if device:
            device.last_report_at = now
            db.commit()
        account = (
            db.query(Account)
            .filter(Account.device_id == device_id,
                    Account.status == AccountStatus.ACTIVE,
                    Account.risk_state == RiskState.NORMAL)
            .first()
        )
        if not account:
            # 设备还没绑账号(identity 帧未到/账号冻结)。门铃无处可投,记一行就算了——
            # 不是错误,周期扫描那条路照常。
            logger.info("设备 %s chat_hint 无可用账号,忽略", device_id)
            return
        last = _LAST_HINT_AT.get(account.id)
        if last and (now - last).total_seconds() < settings.chat_hint_min_interval_sec:
            # 响得太勤不新建单;但正在扫的那单可能已经读过列表、漏掉这条,让它收尾后补扫
            jobs.mark_chat_rescan(db, account.id)
            logger.debug("账号 %s chat_hint 距上次不足 %.0fs,不新建单",
                         account.id, settings.chat_hint_min_interval_sec)
            return
        _LAST_HINT_AT[account.id] = now
        convs = data.get("convs") or []
        job = jobs.create_chat_scan(db, account.id, source="HINT")
        # create_chat_scan 返回 None 只有一种情形:已有在途 chat_scan 且它没挂 job。
        # 返回了 job 则可能是新建的、也可能是在途那单——「确实新建了」以 jobs 自己那行
        # 「扇出 1 个任务」为准,这里不替它下结论。
        logger.info("设备 %s chat_hint:%d 个会话未读上涨(共 %s 未读)→ chat_scan %s",
                    device_id, len(convs), data.get("unread_total"),
                    f"job={job.id}" if job else "已有在途任务,不重复建单")


def _apply_exit_info(device_id: str, data: dict) -> None:
    """exit_info 帧持久化:上次进程死因落 Device(灰度观察设备群死因),**不动** Device.status。

    帧:{"kind":"exit_info","reason":int,"reason_name":"ANR|FREEZER|LOW_MEMORY|USER_STOPPED|...",
         "importance":int,"description":"...","exit_ts":ms,"ts":ms}
    last_exit_at 取 exit_ts(进程真实死亡时刻),缺省回落到收帧时刻。
    """
    reason_name = data.get("reason_name") or f"REASON_{data.get('reason')}"
    exit_ts = data.get("exit_ts")
    exit_at = (
        datetime.utcfromtimestamp(exit_ts / 1000) if isinstance(exit_ts, (int, float)) else datetime.utcnow()
    )
    with SessionLocal() as db:
        device = db.get(Device, device_id)
        if device:
            device.last_exit_reason = str(reason_name)[:64]
            device.last_exit_at = exit_at
            device.last_report_at = datetime.utcnow()
            db.commit()
    logger.info(
        "设备 %s exit_info: %s(reason=%s importance=%s) exit_at=%s desc=%r",
        device_id, reason_name, data.get("reason"), data.get("importance"),
        exit_at, (data.get("description") or "")[:200],
    )


def _apply_identity(device_id: str, data: dict) -> None:
    """identity 帧持久化:就绪态落 Device + xianyu_nick 非空则自动绑 Account(nick 唯一键,激活设备唯一)。

    帧:{"kind":"identity","xianyu_installed":bool,"xianyu_nick":str|null,
         "ready":bool,"blocking":str,"app_version":str?}
    契约:**不动** Device.status(online 只由 status 帧决定)。

    掉登录冻结的号在这里自动解冻:这台机上一帧报的不是它(没登录/占位文案/别的号)、这一帧
    报出了它的昵称,就是人已经重新登录了。只认这一下变化——刚冻号时页面可能还没刷新,页头
    挂着旧昵称,光看「报了昵称」会刚冻就解、下一单又冻,来回刷通知。风控冻结
    (risk_state=FROZEN,要扫码认证之类)不在此列,仍要人在行情台点「解冻」。
    """
    relogged = notify_nick = None
    with SessionLocal() as db:
        device = db.get(Device, device_id)
        if not device:
            return
        nick = data.get("xianyu_nick")
        prev_nick = device.reported_nick
        now = datetime.utcnow()
        device.last_report_at = now
        device.last_ready = bool(data.get("ready"))
        device.last_check_at = now
        device.blocking = data.get("blocking")
        device.reported_nick = nick   # 未登录(null)时如实清空
        if data.get("app_version"):
            device.app_version = data["app_version"]
        # 设备硬件信息(App 尽力采集,读不到不来字段;空值不覆盖已有值——adb 兜底经 /device-info 补)
        for f in ("serial", "imei1", "imei2", "phone_number", "xianyu_member_name"):
            v = data.get(f)
            if v:
                setattr(device, f, v)
        # 自动绑定:**昵称为账号唯一键**——按 nick upsert(不存在即自动注册);激活设备唯一
        # (device_id 指到本机);设备史挂 Device.account_id(一账号可有多台设备,激活的始终一台)。
        if _is_real_nick(nick):
            acc = db.query(Account).filter(Account.nick == nick).first()
            if not acc:
                acc = Account(nick=nick)
                db.add(acc)
                db.flush()   # 取 acc.id
            # 一机一号:本机不再充当其它账号的激活设备(本机换号 → 清掉旧账号的激活指向)
            db.query(Account).filter(
                Account.device_id == device.id, Account.id != acc.id
            ).update({"device_id": None}, synchronize_session=False)
            acc.device_id = device.id   # 账号的激活设备 = 本机
            device.account_id = acc.id  # 本机归入该账号的设备史
            if prev_nick != nick and _is_login_lost_freeze(acc):
                # 还没叫过人就不用发「已恢复」,免得白占 Server酱额度
                if LOGIN_LOST_NOTIFIED in (acc.risk_note or ""):
                    notify_nick = acc.nick
                acc.status = AccountStatus.ACTIVE
                acc.risk_note = None
                relogged = acc.nick
        db.commit()
        logger.info("设备 %s identity: ready=%s nick=%r blocking=%r",
                    device_id, device.last_ready, nick, device.blocking)
    if relogged:
        logger.info("账号 %r 已重新登录,自动解冻(设备 %s)", relogged, device_id)
        # 发通知是同步 HTTP,放后台线程:这里占着 MQTT 收消息的循环,不能让它等推送。
        if notify_nick:
            threading.Thread(target=_notify_relogged, args=(notify_nick,), daemon=True).start()


def _is_real_nick(nick: str | None) -> bool:
    """identity 帧里的昵称是不是真登录了(空/占位文案都算没登录)。"""
    return bool(nick) and nick not in _NICK_PLACEHOLDERS


def _is_login_lost_freeze(acc: Account) -> bool:
    return is_login_lost_freeze(acc)   # 判据收在 models,调度器派保活用同一份


def _notify_relogged(nick: str) -> None:
    try:
        from app.notify import _send
        _send("闲鱼账号已恢复", f"账号「{nick}」重新登录了,自动操作已恢复。")
    except Exception:
        logger.exception("重新登录通知失败 nick=%s", nick)


bridge = MqttBridge()
