"""调度四循环:Dispatcher / Watchdog / Aging(+风控闸=派发前的 eligibility 判定)。

都是主事件循环上的 asyncio 任务;派发时把流程执行提交到有界线程池(流程引擎是阻塞的)。
DB 操作用 asyncio.to_thread 包住,不阻塞事件循环。

时区:DB 存 naive UTC(见 [[erp-timezone-convention]]);账号 active_window 是北京时间,
配额按北京日界计。本服务独立,内联 UTC+8 换算(不依赖 ERP 的 CNDatetime 工具)。
"""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time as dtime, timedelta

from sqlalchemy import and_, case, func, or_

from app.config import settings
from app.database import SessionLocal
from app.flow.runner import QUOTA_CATEGORY, DISPATCHABLE_TYPES, run_task
from app.models import (
    LOGIN_LOST_NOTE,
    REFRESH_TASK_SOURCE,
    REFRESH_UNDO_SOURCE,
    TERMINAL_TASK_STATUS,
    Account,
    AccountStatus,
    Device,
    DeviceStatus,
    Job,
    JobStatus,
    RiskState,
    Task,
    TaskStatus,
    is_login_lost_freeze,
    login_lost_since,
)

logger = logging.getLogger("gc.scheduler")

_CN_OFFSET = timedelta(hours=8)

# 派发优先级(数值小的先派;同级内仍按 created_at 先到先得)。
# chat_scan 垫底:它每 chat_scan_interval_sec 就给每个活跃账号建一单,而生产日志里绝大多数轮次
# 扫出来是「未读 0 行,本轮进 0」——属于可以等的背景巡检。发布/改价/回复是有时效的业务动作,
# 被背景巡检抢走设备就得干等一整轮(一轮 read_chats 含强杀+冷启动闲鱼,几十秒起)。
_BACKGROUND_TASK_TYPES = ("chat_scan", "keepalive", "sold_scan")
# 不受账号作息窗口限制的任务:保活要在夜里也开页面,早上第一单之前就发现掉登录(见 _keepalive_pass)
_ROUND_THE_CLOCK_TYPES = ("keepalive",)
# 员工手动回复:人在等着,设备空着就马上发,不排操作间隔和作息窗口(用户 2026-11-01 定)。
# 自动兜底回复是机器发的,照样节流
_IS_MANUAL_REPLY = (Task.task_type == "chat_reply") & (Task.source == "MANUAL")
_SOLD_SCAN_STARTUP_DELAY_SEC = 120
# 链接焕新(jobs.create_refresh_listing)两种插队:删完旧链接之后的重发——这时闲鱼上什么都没挂,
# 排在别的上架后面等就是让链接空着;以及撤回(重发途中货卖了,新链接得马上删,不然一货多卖)。
_DISPATCH_PRIORITY = case(
    (Task.source == REFRESH_UNDO_SOURCE, -20),
    ((Task.task_type == "goods_publish") & (Task.source == REFRESH_TASK_SOURCE), -10),
    (_IS_MANUAL_REPLY, -5),
    (Task.task_type.in_(_BACKGROUND_TASK_TYPES), 100),
    else_=0,
)

# 配额字段名(按类别)
_QUOTA_FIELD = {
    "publish": "daily_publish_quota",
    "reprice": "daily_reprice_quota",
    "delist": "daily_delist_quota",
}


def _cn_now() -> datetime:
    return datetime.utcnow() + _CN_OFFSET


def _cn_today_utc_range() -> tuple[datetime, datetime]:
    """北京时间「今天」00:00~24:00 对应的 UTC naive 区间。"""
    cn = _cn_now()
    start_cn = datetime.combine(cn.date(), dtime.min)
    start_utc = start_cn - _CN_OFFSET
    return start_utc, start_utc + timedelta(days=1)


def _in_window(window: str) -> bool:
    """当前北京时间是否落在 active_window(如 "09:00-23:00")内。解析失败=放行。"""
    try:
        a, b = window.split("-")
        ah, am = map(int, a.split(":"))
        bh, bm = map(int, b.split(":"))
        now = _cn_now().time()
        lo, hi = dtime(ah, am), dtime(bh, bm)
        return lo <= now <= hi if lo <= hi else (now >= lo or now <= hi)
    except Exception:
        return True


class Scheduler:
    def __init__(self, bridge):
        self.bridge = bridge
        self.pool = ThreadPoolExecutor(max_workers=settings.flow_pool_size, thread_name_prefix="gc-flow")
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: list[asyncio.Task] = []
        self._stop = False
        # task_id → 上次记过的派发拒绝理由。Dispatcher 每 3s 一轮,不去重会把日志刷爆;
        # 只在「理由变了」时打一行,任务派出去/理由消失就清掉。
        self._reject_reason: dict[str, str] = {}

    async def start(self):
        self._loop = asyncio.get_running_loop()
        self._tasks = [
            asyncio.create_task(self._dispatch_loop()),
            asyncio.create_task(self._watchdog_loop()),
            asyncio.create_task(self._aging_loop()),
            asyncio.create_task(self._chat_scan_loop()),
            asyncio.create_task(self._keepalive_loop()),
            asyncio.create_task(self._sold_scan_loop()),
            asyncio.create_task(self._chat_autoreply_loop()),
            asyncio.create_task(self._chat_sla_loop()),
            asyncio.create_task(self._heartbeat_loop()),
        ]
        logger.info("调度器已启动(pool=%d)", settings.flow_pool_size)

    async def stop(self):
        self._stop = True
        for t in self._tasks:
            t.cancel()
        self.pool.shutdown(wait=False, cancel_futures=True)

    # ---------- Dispatcher ----------
    async def _dispatch_loop(self):
        while not self._stop:
            try:
                await asyncio.to_thread(self._dispatch_pass)
            except Exception:
                logger.exception("dispatch pass 异常")
            await asyncio.sleep(settings.dispatch_interval_sec)

    # ---------- Heartbeat(HTTP 心跳离线扫描)----------
    async def _heartbeat_loop(self):
        """app 每 5s HTTP 心跳刷新 last_heartbeat_at;这里扫超时的 ONLINE 设备判 OFFLINE。
        只扫「发过心跳」(last_heartbeat_at 非空)的设备——没升级心跳版 app 的机器该列为 NULL,
        仍走 MQTT status/LWT,不被本扫描误杀,新旧机制并存。"""
        while not self._stop:
            try:
                await asyncio.to_thread(self._heartbeat_pass)
            except Exception:
                logger.exception("heartbeat pass 异常")
            await asyncio.sleep(settings.heartbeat_scan_interval_sec)

    def _heartbeat_pass(self):
        cutoff = datetime.utcnow() - timedelta(seconds=settings.heartbeat_timeout_sec)
        with SessionLocal() as db:
            stale = (
                db.query(Device)
                .filter(
                    Device.status == DeviceStatus.ONLINE,
                    Device.last_heartbeat_at.isnot(None),
                    Device.last_heartbeat_at < cutoff,
                )
                .all()
            )
            for d in stale:
                d.status = DeviceStatus.OFFLINE
                logger.info("设备 %s 心跳超时(%ds 无心跳)-> OFFLINE", d.id, settings.heartbeat_timeout_sec)
            if stale:
                db.commit()

    def _dispatch_pass(self):
        with SessionLocal() as db:
            pending = (
                db.query(Task)
                .filter(Task.status == TaskStatus.PENDING, Task.task_type.in_(list(DISPATCHABLE_TYPES)))
                .order_by(_DISPATCH_PRIORITY.asc(), Task.created_at.asc())
                .limit(100)
                .all()
            )
            # 只保留还在候选里的任务的理由缓存,避免字典随历史任务无限涨
            pending_ids = {t.id for t in pending}
            self._reject_reason = {k: v for k, v in self._reject_reason.items()
                                   if k in pending_ids}
            used_devices: set[str] = set()
            for task in pending:
                device, account, reason = self._eligibility(db, task, used_devices)
                if reason:
                    self._log_reject(task, reason)
                    continue
                self._reject_reason.pop(task.id, None)
                # 占用设备 + 置 RUNNING(先落库,再提交线程池)
                now = datetime.utcnow()
                device.busy_task_id = task.id
                task.device_id = device.id
                task.status = TaskStatus.RUNNING
                task.started_at = now
                task.dispatched_at = now
                account.last_op_at = now  # 提前占位,避免同账号本轮再被选
                used_devices.add(device.id)
                db.commit()
                self.pool.submit(run_task, task.id, self.bridge, self._loop)
                logger.info("派发 task=%s type=%s device=%s account=%s",
                            task.id, task.task_type, device.id, account.id)

    def _log_reject(self, task: Task, reason: str) -> None:
        """记一次「为什么没派出去」。此前这个 reason 算完就丢,任务干挂在 PENDING 而
        服务端日志一个字都没有,只能靠翻库反推(2026-09-10 排查上架任务不执行,实为
        账号作息窗口 09:00-23:00 卡住凌晨下的单,查了一圈才定位)。

        chat_scan 是每 5 分钟给每个活跃账号自动建的背景巡检,设备常年离线的号会稳定
        产出拒绝理由,压到 DEBUG,别把业务任务的信号埋了。
        """
        if self._reject_reason.get(task.id) == reason:
            return
        self._reject_reason[task.id] = reason
        level = logging.DEBUG if task.task_type in _BACKGROUND_TASK_TYPES else logging.INFO
        logger.log(level, "暂不派发 task=%s type=%s account=%s:%s",
                   task.id, task.task_type, task.account_id, reason)

    def _eligibility(self, db, task: Task, used_devices: set[str]):
        """风控闸:返回 (device, account, reject_reason)。reason 非空即不派发。"""
        if not task.account_id:
            return None, None, "无账号"
        account = db.get(Account, task.account_id)
        # 掉登录冻的号只放保活过去:它就是去点「快速进入」把号救回来的,登回去执行端报出昵称就自动解冻
        relogin_attempt = task.task_type == "keepalive" and account is not None and is_login_lost_freeze(account)
        if not account or (not relogin_attempt and (
                account.status != AccountStatus.ACTIVE or account.risk_state == RiskState.FROZEN)):
            return None, None, "账号不可用/已冻结"
        device = db.get(Device, account.device_id) if account.device_id else None
        if not device or device.status != DeviceStatus.ONLINE:
            return None, None, "设备离线"
        if device.in_maintenance(datetime.utcnow()):
            return None, None, "执行端在更新(已报备)"
        if device.busy_task_id or device.id in used_devices:
            return None, None, "设备忙"
        # 双保险:busy_task_id 是单字段,任何一处漏清(掉线/重启/report 丢包)都会让互斥失效,
        # 而互斥一失效就是两条流程同时驱动一部手机、后者 force_stop 掐掉前者(2026-08-18 生产事故)。
        # 设备上只要还有 RUNNING 的任务就不派新活——以任务表为准,不依赖占用字段的正确性。
        running = (
            db.query(Task.id)
            .filter(Task.device_id == device.id, Task.status == TaskStatus.RUNNING)
            .first()
        )
        if running:
            return None, None, "设备上有在跑的任务"
        manual_reply = task.task_type == "chat_reply" and task.source == "MANUAL"
        if (not manual_reply and task.task_type not in _ROUND_THE_CLOCK_TYPES
                and not _in_window(account.active_window)):
            return None, None, "不在作息窗口"
        # 操作节流
        if (not manual_reply and account.last_op_at
                and (datetime.utcnow() - account.last_op_at).total_seconds() < settings.op_min_interval_sec):
            return None, None, "操作间隔未到"
        # 日配额
        cat = QUOTA_CATEGORY.get(task.task_type)
        field = _QUOTA_FIELD.get(cat) if cat else None
        if field:
            quota = getattr(account, field, 0)
            if quota > 0:
                lo, hi = _cn_today_utc_range()
                done = (
                    db.query(Task)
                    .filter(
                        Task.account_id == account.id,
                        Task.task_type == task.task_type,
                        Task.status == TaskStatus.SUCCESS,
                        Task.finished_at >= lo, Task.finished_at < hi,
                    ).count()
                )
                if done >= quota:
                    return None, None, f"{cat} 配额已满({done}/{quota})"
        return device, account, None

    # ---------- Watchdog ----------
    async def _watchdog_loop(self):
        while not self._stop:
            try:
                await asyncio.to_thread(self._watchdog_pass)
            except Exception:
                logger.exception("watchdog pass 异常")
            await asyncio.sleep(settings.watchdog_interval_sec)

    def _watchdog_pass(self):
        cutoff = datetime.utcnow() - timedelta(seconds=settings.task_timeout_sec)
        with SessionLocal() as db:
            stale = (
                db.query(Task)
                .filter(Task.status == TaskStatus.RUNNING, Task.started_at < cutoff)
                .all()
            )
            for task in stale:
                task.status = TaskStatus.FAILED
                task.error = f"执行超时(>{settings.task_timeout_sec}s),watchdog 收尸"
                task.finished_at = datetime.utcnow()
                device = db.get(Device, task.device_id) if task.device_id else None
                if device and device.busy_task_id == task.id:
                    device.busy_task_id = None
                logger.warning("watchdog 收尸超时任务 %s", task.id)
            if stale:
                db.commit()
                for task in stale:
                    if task.job_id:
                        from app import jobs
                        try:
                            jobs._aggregate_job(db, task.job_id)
                        except Exception:
                            logger.exception("watchdog 聚合 job 失败")
                db.commit()
            self._release_stale_busy(db)

    def _release_stale_busy(self, db) -> None:
        """自愈陈旧占用:busy_task_id 指向的任务已终态/已不存在 → 清掉。

        掉线不再释放占用(见 mqtt_bridge._apply_status),释放只认 runner._finish;
        可 _finish 跑不到的场景是存在的——gc-api 重启会连人带线程一起没,占用就永久卡在库里,
        那台设备从此再不接活。这里兜底扫回来。**只清已终态的**,在跑的绝不动。"""
        busy_devices = db.query(Device).filter(Device.busy_task_id.isnot(None)).all()
        freed = 0
        for d in busy_devices:
            task = db.get(Task, d.busy_task_id)
            if task is None or task.status in TERMINAL_TASK_STATUS:
                logger.info("watchdog 释放陈旧占用:device=%s busy_task=%s(%s)",
                            d.id, d.busy_task_id, task.status if task else "任务不存在")
                d.busy_task_id = None
                freed += 1
        if freed:
            db.commit()

    # ---------- Aging ----------
    async def _aging_loop(self):
        while not self._stop:
            try:
                await asyncio.to_thread(self._aging_pass)
            except Exception:
                logger.exception("aging pass 异常")
            await asyncio.sleep(settings.aging_interval_sec)

    def _aging_pass(self):
        # 链接老化重发原先打算在这里做(expire_at 到期 → PENDING_REPUBLISH),但 ERP 从没传过
        # ttl_days,生产库里 expire_at 一条都没有,那段从来没跑过。现在由「链接焕新」接手:
        # ERP 每天定时拉 jobs.refresh_candidates、给新鲜的发布内容,删掉重发。
        # PENDING_REPUBLISH 也随之改了意思——「旧链接已删、等重发」,再按到期把在架链接标成它,
        # 焕新会当它已经删了直接重发,一件货就挂成两条链接。所以那段标记删了,别加回来。
        now = datetime.utcnow()
        with SessionLocal() as db:
            self._reap_stale_queued_tasks(db, now)

    def _reap_stale_queued_tasks(self, db, now):
        """定时清理派不出去的僵尸任务(2026-09-01 老板要求):

        - PENDING 超龄(默认 12 小时):账号冻结/设备长期离线/账号已删等原因永远派不出去,
          而 watchdog 只收 RUNNING、PENDING 此前无老化机制,会一直挂在「待开始」。
        - DISPATCHED 卡死(默认 1 小时):已发首帧但设备始终没接(08-16 生产实例挂了两周)。

        统一置 CANCELLED + finished_at,有 job 的回聚合一次。
        """
        pending_cutoff = now - timedelta(seconds=settings.task_pending_max_age_sec)
        disp_cutoff = now - timedelta(seconds=settings.task_dispatched_max_age_sec)
        stale = (
            db.query(Task)
            .filter(
                (Task.status == TaskStatus.PENDING) & (Task.created_at < pending_cutoff)
                # dispatched_at 可能为 NULL(老数据),回退按 created_at 算龄
                | (Task.status == TaskStatus.DISPATCHED)
                & (func.coalesce(Task.dispatched_at, Task.created_at) < disp_cutoff)
            )
            .all()
        )
        for t in stale:
            t.status = TaskStatus.CANCELLED
            t.error = "超时未执行,定时清理"
            t.finished_at = now
        if stale:
            db.commit()
            logger.info("aging:清理 %d 条超时未执行任务(PENDING>=%ds / DISPATCHED>=%ds)",
                        len(stale), settings.task_pending_max_age_sec, settings.task_dispatched_max_age_sec)
            from app import jobs
            for job_id in {t.job_id for t in stale if t.job_id}:
                try:
                    jobs._aggregate_job(db, job_id)
                except Exception:
                    logger.exception("aging 聚合 job 失败")
            db.commit()

    # ---------- Chat Scan(1a 聊天接收:周期为活跃账号建 chat_scan job)----------
    async def _chat_autoreply_loop(self):
        """50 秒未回复兜底。间隔(15s)远小于阈值(50s),把平均延迟压在阈值附近。"""
        while not self._stop:
            try:
                if settings.chat_autoreply_enabled:
                    await asyncio.to_thread(self._chat_autoreply_pass)
            except Exception:
                logger.exception("chat_autoreply pass 异常")
            await asyncio.sleep(settings.chat_autoreply_interval_sec)

    def _chat_autoreply_pass(self):
        from app import chat_autoreply
        with SessionLocal() as db:
            created = chat_autoreply.run_autoreply_pass(
                db,
                threshold_sec=settings.chat_autoreply_threshold_sec,
                limit=settings.chat_autoreply_batch_limit,
            )
        if created:
            logger.info("兜底回复建单 %d 条", len(created))

    async def _chat_sla_loop(self):
        """消息响应考核：新消息推负责人、超时提醒/升级（chat_sla.py）。开关在后台设置里。"""
        while not self._stop:
            try:
                await asyncio.to_thread(self._chat_sla_pass)
            except Exception:
                logger.exception("chat_sla pass 异常")
            await asyncio.sleep(settings.chat_sla_interval_sec)

    def _chat_sla_pass(self):
        from app import chat_sla
        with SessionLocal() as db:
            out = chat_sla.run_pass(db)
        if any(out.values()):
            logger.info("消息响应考核 %s", out)

    async def _chat_scan_loop(self):
        while not self._stop:
            try:
                await asyncio.to_thread(self._chat_scan_pass)
            except Exception:
                logger.exception("chat_scan pass 异常")
            await asyncio.sleep(settings.chat_scan_interval_sec)

    async def _keepalive_loop(self):
        while not self._stop:
            try:
                await asyncio.to_thread(self._keepalive_pass)
            except Exception:
                logger.exception("keepalive pass 异常")
            try:
                await asyncio.to_thread(self._restart_pause_reminder_pass)
            except Exception:
                logger.exception("暂停提醒 pass 异常")
            await asyncio.sleep(60)

    def _keepalive_pass(self):
        """浏览器号闲着超过 keepalive_interval_sec 就建一单保活(flow/web/keepalive_web.py)。

        「闲着」看 last_op_at(任务派发和收尾都会刷新它):白天消息巡检每 5 分钟开一次页面,
        号不闲,基本轮不到;夜里作息窗口外什么都不派,每个号约 10 分钟一趟。
        只管 ACTIVE 且风控正常的号,外加因掉登录冻的号:风控冻结要人处理,掉登录冻结机器能自己
        确认——保活照样派过去点「快速进入」(点了没登回去就刷新再点),读到昵称就自动解冻。
        刚冻的号每 login_lost_retry_interval_sec 救一次,过了宽限期回到平常的频率;
        过了宽限期还没救回来 runner 才通知人(2026-10-14:南方举重雪白海胆冻着没人管,保活也不去)。
        只管浏览器号:手机 App 的登录态在 App 里,不是网页会话。
        """
        if not settings.keepalive_enabled:
            return
        from app import jobs  # 延迟导入避免环
        now = datetime.utcnow()
        cutoff = now - timedelta(seconds=settings.keepalive_interval_sec)
        retry_cutoff = now - timedelta(seconds=settings.login_lost_retry_interval_sec)
        grace = timedelta(seconds=settings.login_lost_notify_grace_sec)

        def due(acc: Account) -> bool:
            if not acc.last_op_at or acc.last_op_at < cutoff:
                return True
            since = login_lost_since(acc) if is_login_lost_freeze(acc) else None
            return bool(since) and now - since < grace

        with SessionLocal() as db:
            idle = (
                db.query(Account)
                .join(Device, Device.id == Account.device_id)
                .filter(
                    Account.risk_state == RiskState.NORMAL,
                    or_(Account.status == AccountStatus.ACTIVE,
                        and_(Account.status == AccountStatus.FROZEN,
                             Account.risk_note.like(f"{LOGIN_LOST_NOTE}%"))),
                    Device.kind == "browser",
                    Device.status == DeviceStatus.ONLINE,
                    or_(Account.last_op_at.is_(None), Account.last_op_at < retry_cutoff),
                )
                .all()
            )
            for acc in idle:
                if due(acc):
                    jobs.create_keepalive(db, acc.id)

    def _restart_pause_reminder_pass(self):
        """巡航台点了「暂停，准备重启电脑」,报备过期了执行端还没回来就提醒一声(一天一条)。
        2026-10-30 现场:16:04 暂停后没重启也没点继续,11 个执行端停了一天多,谁也不知道。"""
        from app import notify
        now = datetime.utcnow()
        with SessionLocal() as db:
            paused = (
                db.query(Device)
                .filter(
                    Device.kind == "browser",
                    Device.status != DeviceStatus.ONLINE,
                    Device.maintenance_reason == "pc_restart",
                    Device.maintenance_until < now,
                    Device.maintenance_since > now - timedelta(days=7),
                )
                .count()
            )
            if paused and notify.notify_restart_pause(db, paused, now=now):
                db.commit()

    async def _sold_scan_loop(self):
        # 刚重启时执行端要三四十秒才重新接指令(2026-10-17 发版:21:47:27 派出的 4 单售出巡检
        # 全部 launch_app 超时,执行端 21:47:52~21:48:09 才报就绪),第一轮等一会儿再建,
        # 不然每次重启都白跑一轮、再等半小时
        await asyncio.sleep(_SOLD_SCAN_STARTUP_DELAY_SEC)
        while not self._stop:
            try:
                await asyncio.to_thread(self._sold_scan_pass)
            except Exception:
                logger.exception("sold_scan pass 异常")
            await asyncio.sleep(settings.sold_scan_interval_sec)

    def _sold_scan_pass(self):
        """浏览器号每 sold_scan_interval_sec 读一次个人中心「已售出」(flow/web/sold_scan_web.py)。

        只给 ACTIVE、风控正常、设备在线的浏览器号建;手上没有带 item_id 的在架账本的号
        jobs.create_sold_scan 自己会跳过。手机号的售出仍靠 chat_scan(App 聊天页读得到商品标题)。
        """
        if not settings.sold_scan_enabled:
            return
        from app import jobs  # 延迟导入避免环
        with SessionLocal() as db:
            accounts = (
                db.query(Account)
                .join(Device, Device.id == Account.device_id)
                .filter(
                    Account.status == AccountStatus.ACTIVE,
                    Account.risk_state == RiskState.NORMAL,
                    Device.kind == "browser",
                    Device.status == DeviceStatus.ONLINE,
                )
                .all()
            )
            for acc in accounts:
                jobs.create_sold_scan(db, acc.id)

    def _chat_scan_pass(self):
        from app import jobs  # 延迟导入避免环
        with SessionLocal() as db:
            accounts = (
                db.query(Account)
                .filter(Account.status == AccountStatus.ACTIVE, Account.risk_state == RiskState.NORMAL)
                .all()
            )
            for acc in accounts:
                if acc.last_op_at and (datetime.utcnow() - acc.last_op_at).total_seconds() < settings.op_min_interval_sec:
                    continue
                jobs.create_chat_scan(db, acc.id)
