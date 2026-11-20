"""回归:两条流程同时驱动同一部手机(2026-08-18 生产事故)。

现场(设备 ea4de557):
    13:44:33 gc.bridge 设备 -> OFFLINE          ← MQTT 抖动,busy_task_id 被无条件清空
    13:44:35 派发 task=378a4445 type=chat_scan
    13:45:34 gc.bridge 设备 -> OFFLINE          ← 又抖一次,占用又被清空
    13:45:39 派发 task=2fbbb56c type=goods_publish   ← ★ 同一台设备,chat_scan 还在跑
    13:45:40 goods_publish -> FAILED(screencap 失败)
    13:45:50 chat_scan     -> FAILED

根因:mqtt_bridge._apply_status 掉线即 `device.busy_task_id = None`,可服务端那条流程的
线程还活着(设备掉线后要等下一个原语 RPC 超时 15s 才崩)。占用一清,调度器 3s 内就把下一个
任务派到同一台机器;而每条流程开场都是 force_stop(闲鱼)(flow/ready.py 范式),后进来的那条
直接把前一条正在编辑的页面连草稿一起杀掉——表现为「就差最后一步发布,闲鱼自己退了」。

修复三层:
1. 掉线只清「已终态」的陈旧占用,在跑的留给 runner._finish(唯一正确的释放点);
2. _eligibility 补一道以任务表为准的兜底(设备上有 RUNNING 任务就不派新活);
3. watchdog._release_stale_busy 自愈线程都没了的残留(如 gc-api 重启),避免设备永久卡死。
"""

from datetime import datetime, timedelta

from sqlalchemy.orm import sessionmaker

import app.mqtt_bridge as mb
import app.scheduler as scheduler_module
from app.models import (
    Account,
    AccountStatus,
    Device,
    DeviceStatus,
    Task,
    TaskStatus,
)
from app.scheduler import Scheduler


def _bind(module, db, monkeypatch):
    monkeypatch.setattr(
        module, "SessionLocal",
        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False),
    )


def _device_account(db, window="00:00-23:59"):
    device = Device(name="phone", status=DeviceStatus.ONLINE)
    db.add(device)
    db.flush()
    account = Account(nick="铺子A", device_id=device.id,
                      status=AccountStatus.ACTIVE, active_window=window)
    db.add(account)
    db.flush()
    return device, account


def _dispatch(db, monkeypatch):
    """跑一轮 _dispatch_pass,返回被提交到线程池的 task_id 列表。"""
    _bind(scheduler_module, db, monkeypatch)
    sched = Scheduler(bridge=None)
    submitted = []
    try:
        monkeypatch.setattr(sched.pool, "submit",
                            lambda fn, *a, **kw: submitted.append(a[0]))
        sched._dispatch_pass()
    finally:
        sched.pool.shutdown(wait=False, cancel_futures=True)
    db.expire_all()
    return submitted


# ---------- 1. 掉线不释放「在跑」的占用 ----------

def test_offline_keeps_busy_of_running_task(db, monkeypatch):
    """设备掉线时,占用指向的任务仍在 RUNNING → 占用必须留着(否则下一个任务会插进来)。"""
    _bind(mb, db, monkeypatch)
    device, account = _device_account(db)
    task = Task(task_type="chat_scan", account_id=account.id, device_id=device.id,
                status=TaskStatus.RUNNING, started_at=datetime.utcnow(), spec={})
    db.add(task)
    db.flush()                      # id 由 default=new_id 在 flush 时生成,先 flush 再取
    device.busy_task_id = task.id
    db.commit()
    did, tid = device.id, task.id

    mb._apply_status(did, {"online": False})

    db.expire_all()
    device = db.get(device.__class__, did)
    assert device.status == DeviceStatus.OFFLINE
    assert device.busy_task_id == tid, "掉线不能释放还在跑的流程的设备占用"


def test_offline_clears_busy_of_finished_task(db, monkeypatch):
    """占用指向的任务已终态(report 帧丢包等)→ 属于陈旧占用,掉线时顺手清掉。"""
    _bind(mb, db, monkeypatch)
    device, account = _device_account(db)
    task = Task(task_type="chat_scan", account_id=account.id, device_id=device.id,
                status=TaskStatus.SUCCESS, finished_at=datetime.utcnow(), spec={})
    db.add(task)
    db.flush()                      # id 由 default=new_id 在 flush 时生成,先 flush 再取
    device.busy_task_id = task.id
    db.commit()
    did = device.id

    mb._apply_status(did, {"online": False})

    db.expire_all()
    assert db.get(Device, did).busy_task_id is None


def test_offline_clears_busy_of_missing_task(db, monkeypatch):
    """占用指向的任务已不存在 → 同样是陈旧占用,清掉,别让设备白卡着。"""
    _bind(mb, db, monkeypatch)
    device, _ = _device_account(db)
    device.busy_task_id = "已经没有这个任务了"
    db.commit()
    did = device.id

    mb._apply_status(did, {"online": False})

    db.expire_all()
    assert db.get(Device, did).busy_task_id is None


# ---------- 2. _eligibility 兜底:以任务表为准 ----------

def test_running_task_blocks_dispatch_even_if_busy_lost(db, monkeypatch):
    """核心回归:占用字段丢了(模拟旧版掉线清空),但设备上还有 RUNNING 任务 → 不许派新活。"""
    device, account = _device_account(db)
    running = Task(task_type="chat_scan", account_id=account.id, device_id=device.id,
                   status=TaskStatus.RUNNING, started_at=datetime.utcnow(), spec={})
    pending = Task(task_type="goods_publish", account_id=account.id,
                   status=TaskStatus.PENDING, spec={})
    db.add_all([running, pending])
    device.busy_task_id = None          # ← 事故现场:占用被掉线逻辑清掉了
    account.last_op_at = None           # 不受操作节流影响
    db.commit()
    pending_id = pending.id

    assert _dispatch(db, monkeypatch) == [], "设备上有在跑的任务时不该再派发"
    assert db.get(Task, pending_id).status == TaskStatus.PENDING


def test_dispatch_proceeds_once_device_really_idle(db, monkeypatch):
    """反向用例:设备真空闲(无占用、无 RUNNING)时照常派发,别把兜底做成死锁。"""
    device, account = _device_account(db)
    db.add(Task(task_type="goods_publish", account_id=account.id,
                status=TaskStatus.PENDING, spec={}))
    db.commit()

    assert len(_dispatch(db, monkeypatch)) == 1


# ---------- 3. watchdog 自愈陈旧占用 ----------

def test_watchdog_releases_stale_busy(db, monkeypatch):
    """gc-api 重启后线程没了、占用留在库里 → watchdog 扫回来,否则该设备永久不接活。"""
    _bind(scheduler_module, db, monkeypatch)
    device, account = _device_account(db)
    done = Task(task_type="chat_scan", account_id=account.id, device_id=device.id,
                status=TaskStatus.SUCCESS, finished_at=datetime.utcnow(), spec={})
    db.add(done)
    db.flush()                      # id 由 default=new_id 在 flush 时生成,先 flush 再取
    device.busy_task_id = done.id
    db.commit()
    did = device.id

    sched = Scheduler(bridge=None)
    try:
        sched._watchdog_pass()
    finally:
        sched.pool.shutdown(wait=False, cancel_futures=True)

    db.expire_all()
    assert db.get(Device, did).busy_task_id is None


def test_watchdog_keeps_busy_of_running_task(db, monkeypatch):
    """自愈只针对已终态的占用;任务还在 RUNNING(未超时)时绝不能动。"""
    _bind(scheduler_module, db, monkeypatch)
    device, account = _device_account(db)
    running = Task(task_type="goods_publish", account_id=account.id, device_id=device.id,
                   status=TaskStatus.RUNNING, started_at=datetime.utcnow(), spec={})
    db.add(running)
    db.flush()                      # id 由 default=new_id 在 flush 时生成,先 flush 再取
    device.busy_task_id = running.id
    db.commit()
    did, tid = device.id, running.id

    sched = Scheduler(bridge=None)
    try:
        sched._watchdog_pass()
    finally:
        sched.pool.shutdown(wait=False, cancel_futures=True)

    db.expire_all()
    assert db.get(Device, did).busy_task_id == tid


# ---------- 4. 派发优先级:goods_publish 先于 chat_scan ----------

def test_publish_dispatched_before_older_chat_scan(db, monkeypatch):
    """chat_scan 建单更早也得让路:背景巡检不该把有时效的发布挤到下一轮。"""
    device, account = _device_account(db)
    old = datetime.utcnow() - timedelta(minutes=5)
    scan = Task(task_type="chat_scan", account_id=account.id,
                status=TaskStatus.PENDING, spec={}, created_at=old)
    publish = Task(task_type="goods_publish", account_id=account.id,
                   status=TaskStatus.PENDING, spec={}, created_at=datetime.utcnow())
    db.add_all([scan, publish])
    db.commit()
    publish_id = publish.id

    submitted = _dispatch(db, monkeypatch)

    # 一机一任务:本轮只派得下一个,必须是 publish
    assert submitted == [publish_id]
    assert db.get(Task, publish_id).status == TaskStatus.RUNNING
