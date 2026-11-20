"""流程 runner:把一个 Task 跑成一条闲鱼流程,结果写回 Task + Listing。

在有界线程池里同步执行(流程引擎是阻塞的:OCR + sleep + RPC 往返)。
MqttRpcTransport 把每个原语经 run_coroutine_threadsafe 投给主事件循环上的 MQTT 桥。

映射:
- ok            → Task.SUCCESS,按流程类型做 Listing 记账
- risk(风控) → Task.FAILED + 熔断账号(冻结其所有待跑任务),绝不重试
- 其它失败      → Task.FAILED,存 failed_step / reason / shot_key
"""

import logging
from datetime import datetime

from app.config import settings
from app.database import SessionLocal
from app.flow.delist_flow import run_delist
from app.flow.polish_flow import run_polish
from app.flow.publish_flow import run_publish
from app.flow.publish_flow_v2 import run_publish_v2
from app.flow.read_chats import run_read_chats
from app.flow.relist_flow import run_relist
from app.flow.reply_chat import run_reply_chat
from app.flow.reprice_flow import run_reprice
from app.flow.transport import MqttRpcTransport
from app.models import (
    LOGIN_LOST_NOTE,
    LOGIN_LOST_NOTIFIED,
    Account,
    AccountStatus,
    Device,
    RiskState,
    Task,
    TaskStatus,
    is_login_lost_freeze,
    login_lost_since,
)
from app import erp_precheck, storage

logger = logging.getLogger("gc.runner")

# task_type → 流程函数
FLOWS = {
    # 2026-07-26 起发布走 V2(节点/坐标驱动,运行态零 OCR);OCR 版保留 publish_flow.py 备查
    "goods_publish": run_publish_v2,
    "goods_delist": run_delist,
    "goods_reprice": run_reprice,
    "goods_relist": run_relist,
    "goods_polish": run_polish,
    "chat_scan": run_read_chats,
    # 人工回复(1b):不设日配额类别——回复是人工触发的刚需,靠 op_min_interval 节流即可
    "chat_reply": run_reply_chat,
}

# 只有网页版才有的流程(手机端没有对应实现),调度器照样要派。
# goods_delete:链接焕新删旧链接用,网页版详情页有「删除」;手机端要先下架再进仓库删,没做——
# 销售号 09-15 起都在浏览器上,焕新挑单子时也只挑浏览器号(jobs.refresh_candidates)。
# sold_scan:读个人中心「已售出」按 item_id 确认卖掉的链接(flow/web/sold_scan_web.py),
# 网页版聊天页的商品卡没有标题,靠聊天对不上售出;手机端仍走 chat_scan 那条。
# 冻结现场留多少页面原文
RISK_TEXT_LIMIT = 5
RISK_TEXT_LEN = 120

WEB_ONLY_FLOWS = frozenset({"keepalive", "goods_delete", "sold_scan"})
# 调度器会去派的任务类型 = 手机版全集 + 网页版独有
DISPATCHABLE_TYPES = frozenset(FLOWS) | WEB_ONLY_FLOWS

# task_type → 配额类别(风控闸计数用)
QUOTA_CATEGORY = {
    "goods_publish": "publish",
    "goods_delist": "delist",
    "goods_reprice": "reprice",
    "goods_relist": "relist",
    "goods_polish": "polish",
    "goods_delete": "delist",   # 删链接按账号的日下架配额限量(和下架各数各的,_eligibility 按任务类型计数)
    "chat_scan": "chat_scan",
}


def _web_flows() -> dict:
    """browser 设备(AdsPower 闲鱼网页版)的流程集。延迟导入:Playwright 依赖只在本地 dev venv 有。

    各流程模块若尚未实现,导入失败即视为暂不支持(任务 FAILED,不影响其它流程)。
    """
    flows = {}
    try:
        from app.flow.web.read_chats_web import run_read_chats_web
        flows["chat_scan"] = run_read_chats_web
    except ImportError:
        pass
    try:
        from app.flow.web.goods_flows_web import (run_delete_web, run_delist_web,
                                                  run_relist_web, run_reprice_web)
        flows["goods_delist"] = run_delist_web
        flows["goods_delete"] = run_delete_web
        flows["goods_relist"] = run_relist_web
        flows["goods_reprice"] = run_reprice_web
    except ImportError:
        pass
    try:
        from app.flow.web.reply_chat_web import run_reply_chat_web
        flows["chat_reply"] = run_reply_chat_web
    except ImportError:
        pass
    try:
        from app.flow.web.publish_flow_web import run_publish_web
        flows["goods_publish"] = run_publish_web
    except ImportError:
        pass
    try:
        from app.flow.web.keepalive_web import run_keepalive_web
        flows["keepalive"] = run_keepalive_web
    except ImportError:
        pass
    try:
        from app.flow.web.sold_scan_web import run_sold_scan_web
        flows["sold_scan"] = run_sold_scan_web
    except ImportError:
        pass
    return flows


def _pick_flow(task_type: str, kind: str | None):
    """按设备 kind 选流程集:android 走 FLOWS(全集);browser 走 FLOWS_WEB(网页版等价流程)。"""
    if kind == "browser":
        return _web_flows().get(task_type)
    return FLOWS.get(task_type)


def run_task(task_id: str, bridge, loop) -> None:
    """线程池入口。自开 DB 会话,不与主循环共享 session。"""
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        if not task or task.status != TaskStatus.RUNNING:
            return  # 已被 watchdog 收尸或状态异常
        device = db.get(Device, task.device_id) if task.device_id else None
        if not device:
            _finish(db, task, ok=False, reason="任务无绑定设备")
            return
        flow = _pick_flow(task.task_type, device.kind)
        if not flow:
            _finish(db, task, ok=False,
                    reason=f"设备类型 {device.kind or 'android'} 暂不支持流程 {task.task_type}")
            return
        precheck = erp_precheck.request_for(db, task)

    # ERP 来的发布:交给执行端之前回 ERP 再核一次,期间货卖了/锁了/审批作废了就不发(问不到照常发)
    if precheck and erp_precheck.stop_if_blocked(task_id, precheck):
        return

    # 跑流程(不持 DB 会话,避免长事务;流程可能几分钟)
    import time as _time

    from app.flow.trace import TraceTransport, track_live, untrack_live
    from app.flow.transport import FlowTimeout
    transport = MqttRpcTransport(bridge, task.device_id, loop, rpc_timeout=15.0,
                                 deadline=_time.monotonic() + settings.flow_hard_timeout_sec)
    tracer = None
    skip_trace = {x.strip() for x in settings.gc_trace_skip_task_types.split(",") if x.strip()}
    if settings.gc_trace_actions and task.task_type not in skip_trace:
        tracer = TraceTransport(transport, storage.save_shot, label=task.id)
        transport = tracer
        # 后台「回放」在任务跑着时读它看走到哪一步;结果写回库之后才撤,中间不留空档
        track_live(tracer)
    try:
        try:
            result = flow(transport, task.spec or {}, shot_sink=storage.save_shot)
        except FlowTimeout as e:
            # 流程级硬超时:线程必须退出(否则挂死线程堆积→OOM,08-06 实测)。
            # 与 watchdog 收尸语义一致但更早、且真正终止线程。
            logger.warning("流程硬超时 task=%s: %s", task_id, e)
            result = {"ok": False, "failed_step": "runner", "reason": str(e),
                      "shot": None, "risk": None}
        except Exception as e:  # 传输层/意外崩溃兜底
            logger.exception("流程崩溃 task=%s", task_id)
            result = {"ok": False, "failed_step": "runner", "reason": f"流程崩溃:{e}",
                      "shot": None, "risk": None}

        _capture_freeze_evidence(transport, result, task_id)

        # 自救失败的现场清单(web/login.py),查「为什么没救回来」从这里进
        if getattr(transport, "login_diag", None):
            result["login_diag"] = transport.login_diag

        # 动作留痕收尾:成功/失败/崩溃都 flush(崩溃现场往往最关键)
        if tracer:
            try:
                trace_key = tracer.flush()
                if trace_key:
                    result["trace_key"] = trace_key
            except Exception:
                logger.warning("trace flush 失败 task=%s", task_id, exc_info=True)

        # 写回
        with SessionLocal() as db:
            task = db.get(Task, task_id)
            if not task:
                return
            _apply_result(db, task, result)
    finally:
        if tracer:
            untrack_live(tracer.label)


def _capture_freeze_evidence(transport, result: dict, task_id: str) -> None:
    """要冻号的任务留现场:截图 + 命中关键词的页面原文,给人判断是真风控还是误判。

    关键词匹配会扫到买家消息、别人的商品标题(11-01 土星读聊天命中「违规」,没有截图,查不出是哪句话),
    所以不能只留一个词。流程抛出时页面还停在原地,统一在这里取。取不到不影响冻结本身。
    """
    if not result.get("risk") and not result.get("login"):
        return
    if not result.get("shot"):
        try:
            result["shot"] = storage.save_shot(f"{task_id}_freeze", transport.screencap())
        except Exception:
            logger.warning("冻结现场截图失败 task=%s", task_id, exc_info=True)
    anchor = result.get("risk")
    if not anchor:
        return
    try:
        result["risk_text"] = _texts_with_anchor(transport.dump_nodes(), anchor)
    except Exception:
        logger.warning("冻结现场原文读取失败 task=%s", task_id, exc_info=True)


def _texts_with_anchor(nodes, anchor: str) -> list[str]:
    """节点里含关键词的文字,去重后最多留 RISK_TEXT_LIMIT 条,每条截到 RISK_TEXT_LEN 字。"""
    found: list[str] = []
    for node in nodes or []:
        text = (node.get("desc") or "").strip()[:RISK_TEXT_LEN]
        if anchor in text and text not in found:
            found.append(text)
    return found[:RISK_TEXT_LIMIT]


def _apply_result(db, task: Task, result: dict) -> None:
    from app import jobs  # 延迟导入避免环

    ok = bool(result.get("ok"))
    task.result = result
    task.failed_step = result.get("failed_step")
    task.shot_key = result.get("shot")
    if not ok:
        task.error = result.get("reason")

    # 风控命中:熔断账号 + 冻结其 PENDING 任务
    if result.get("risk") and task.account_id:
        acc = db.get(Account, task.account_id)
        if acc:
            acc.risk_state = RiskState.FROZEN
            acc.status = AccountStatus.FROZEN
            risk_text = " / ".join(result.get("risk_text") or [])
            quoted = f"(页面原文:{risk_text})" if risk_text else ""
            acc.risk_note = f"命中风控:{result.get('risk')}{quoted} @ {datetime.utcnow().isoformat()}"
            db.query(Task).filter(
                Task.account_id == acc.id, Task.status == TaskStatus.PENDING
            ).update({Task.status: TaskStatus.CANCELLED}, synchronize_session=False)
            logger.warning("账号 %s 命中风控熔断:%s", acc.id, result.get("risk"))
            # 通知人工:冻结之后什么都不会再发生,不告诉人就只能等谁碰巧去看「机器现状」。
            # 说清是哪个号、卡在什么、去哪台设备处理(网页版流程不会跳走,弹窗还在原页等着)。
            # (2026-10-06 现场:「完成认证才可继续发布」要扫码,当时没有任何提醒。)
            # 走 _send(企微优先,不通回退 Server酱):换到腾讯云后企微报 60020(新 IP 不在
            # 「企业可信IP」里),只发企微等于没发。
            try:
                from app.notify import send_alert_with_shot
                dev = db.get(Device, task.device_id) if task.device_id else None
                where = (f"浏览器环境 {dev.hw_id} 的窗口" if dev and dev.kind == "browser"
                         else f"手机 {dev.name}" if dev else "它的设备")
                send_alert_with_shot("闲鱼账号要人工处理",
                                     f"账号「{acc.nick or acc.id}」遇到「{result.get('risk')}」{quoted},自动操作已全部停下。"
                                     f"这是按页面文字判断的,可能误判,请先看截图。"
                                     f"请到{where}里处理(要认证就用手机扫码),"
                                     f"处理完在行情台「运维 → 机器现状」点「解冻」。",
                                     shot_key=result.get("shot"), task=task)
            except Exception:
                logger.exception("风控通知失败 account=%s", acc.id)

    # 掉登录:冻结账号,机器先自己救(scheduler 派保活:刷新 + 快速进入),救回来自动解冻。
    # 浏览器号过了宽限期还没登回才通知人,待办留着等登回去;手机没有保活,当场取消并通知。
    if result.get("login") and task.account_id:
        acc = db.get(Account, task.account_id)
        if acc and is_login_lost_freeze(acc):
            # 本来就因掉登录冻着,这是保活去自救没救回来:不重复冻,也别取消冻结期间排进来的单。
            logger.info("账号 %s 掉登录自救未成,继续自救", acc.id)
            _notify_login_lost_after_grace(db, acc, task)
        elif acc:
            acc.status = AccountStatus.FROZEN
            acc.risk_note = f"{LOGIN_LOST_NOTE},重新登录后自动恢复 @ {datetime.utcnow().isoformat()}"
            dev = db.get(Device, task.device_id) if task.device_id else None
            if dev and dev.kind == "browser":
                logger.warning("账号 %s 掉登录,冻结并自救", acc.id)
            else:
                db.query(Task).filter(
                    Task.account_id == acc.id, Task.status == TaskStatus.PENDING
                ).update({Task.status: TaskStatus.CANCELLED}, synchronize_session=False)
                logger.warning("账号 %s 掉登录,冻结并取消待办任务", acc.id)
                _notify_login_lost(acc, task, dev)

    # 保活读到了页头昵称:号是登着的。误判冻的号执行端一直报着昵称,等不到 identity 的那一下变化
    if ok and task.task_type == "keepalive" and task.account_id:
        acc = db.get(Account, task.account_id)
        if acc and is_login_lost_freeze(acc):
            notified = LOGIN_LOST_NOTIFIED in (acc.risk_note or "")
            acc.status = AccountStatus.ACTIVE
            acc.risk_note = None
            logger.info("账号 %s 保活读到昵称,自动解冻", acc.id)
            if notified:
                try:
                    from app.notify import _send
                    _send("闲鱼账号已恢复", f"账号「{acc.nick or acc.id}」登回来了,自动操作已恢复。")
                except Exception:
                    logger.exception("恢复通知失败 account=%s", acc.id)

    _finish(db, task, ok=ok, reason=task.error)

    # 账号 last_op_at
    if task.account_id:
        acc = db.get(Account, task.account_id)
        if acc:
            acc.last_op_at = datetime.utcnow()

    db.commit()

    # Listing 记账 + Job 聚合(独立事务里做,失败不影响 task 落库)
    try:
        jobs.on_task_result(task.id, ok)
    except Exception:
        logger.exception("Listing/Job 记账失败 task=%s", task.id)


def _notify_login_lost(acc: Account, task: Task, dev: Device | None) -> None:
    acc.risk_note = f"{acc.risk_note}{LOGIN_LOST_NOTIFIED}"
    try:
        from app.notify import send_alert_with_shot
        where = (f"浏览器环境 {dev.hw_id} 的窗口" if dev and dev.kind == "browser"
                 else f"手机 {dev.name}" if dev else "它的设备")
        send_alert_with_shot("闲鱼账号掉登录",
                             f"账号「{acc.nick or acc.id}」掉登录了,机器刷新、点「快速进入」都没救回来,自动操作已停。"
                             f"请到{where}里重新登录,登上后会自动恢复,不用点解冻。",
                             shot_key=task.shot_key, task=task)
    except Exception:
        logger.exception("掉登录通知失败 account=%s", acc.id)


def _notify_login_lost_after_grace(db, acc: Account, task: Task) -> None:
    """自救过了宽限期还没成才叫人,一次冻结只叫一次。"""
    if LOGIN_LOST_NOTIFIED in (acc.risk_note or ""):
        return
    since = login_lost_since(acc)
    if since and (datetime.utcnow() - since).total_seconds() < settings.login_lost_notify_grace_sec:
        return
    _notify_login_lost(acc, task, db.get(Device, task.device_id) if task.device_id else None)


def _finish(db, task: Task, ok: bool, reason: str | None) -> None:
    task.status = TaskStatus.SUCCESS if ok else TaskStatus.FAILED
    task.finished_at = datetime.utcnow()
    if reason and not ok:
        task.error = reason
    device = db.get(Device, task.device_id) if task.device_id else None
    if device and device.busy_task_id == task.id:
        device.busy_task_id = None  # 释放设备
    db.commit()
    logger.info("任务 %s -> %s%s", task.id, task.status, f"({reason})" if reason else "")
