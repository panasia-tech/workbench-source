"""回归:_eligibility 的日配额闸对没有配置配额字段的类别(relist/polish/chat_scan)不应 KeyError。

Bug: QUOTA_CATEGORY(app/flow/runner.py)把 chat_scan/relist/polish 也映射到了 cat,
但 _QUOTA_FIELD(app/scheduler.py)只有 publish/reprice/delist 三个 key,
`_QUOTA_FIELD[cat]` 对其余类别必炸 KeyError,导致 dispatch pass 整轮异常、这些任务永远派不出去。
修复:改用 `_QUOTA_FIELD.get(cat)`,没有配置字段的类别视为不限额(跳过配额判断,不影响其余风控闸)。
"""

from datetime import datetime
from uuid import uuid4

from app.models import Account, Device, DeviceStatus, Task, TaskStatus
from app.scheduler import Scheduler


def _mk_account_device(db, active_window="00:00-23:59"):
    device = Device(name="d1", status=DeviceStatus.ONLINE)
    db.add(device)
    db.flush()
    # nick 是账号唯一键:同一测试库里多次建厂须各自唯一
    account = Account(nick=f"a-{uuid4().hex[:8]}", device_id=device.id, active_window=active_window)
    db.add(account)
    db.flush()
    return device, account


def test_chat_scan_eligibility_no_keyerror(db):
    device, account = _mk_account_device(db)
    task = Task(task_type="chat_scan", account_id=account.id)
    db.add(task)
    db.commit()

    sched = Scheduler(bridge=None)
    # 修复前:这里会抛 KeyError('chat_scan')
    got_device, got_account, reason = sched._eligibility(db, task, set())

    assert reason is None
    assert got_device.id == device.id
    assert got_account.id == account.id


def test_relist_and_polish_eligibility_no_keyerror(db):
    sched = Scheduler(bridge=None)
    for task_type in ("goods_relist", "goods_polish"):
        device, account = _mk_account_device(db)
        task = Task(task_type=task_type, account_id=account.id)
        db.add(task)
        db.commit()

        got_device, got_account, reason = sched._eligibility(db, task, set())

        assert reason is None, f"{task_type} 不应因配额闸被拒绝: {reason}"
        assert got_device.id == device.id
        assert got_account.id == account.id


def test_manual_reply_skips_interval_and_window_but_not_running_task(db):
    device, account = _mk_account_device(db, active_window="00:00-00:00")
    account.last_op_at = datetime.utcnow()
    manual = Task(task_type="chat_reply", source="MANUAL", account_id=account.id)
    auto = Task(task_type="chat_reply", source="AUTO", account_id=account.id)
    db.add_all([manual, auto])
    db.commit()

    sched = Scheduler(bridge=None)
    assert sched._eligibility(db, manual, set())[2] is None
    assert sched._eligibility(db, auto, set())[2] in ("不在作息窗口", "操作间隔未到")

    db.add(Task(task_type="chat_scan", account_id=account.id, device_id=device.id, status=TaskStatus.RUNNING))
    db.commit()
    assert sched._eligibility(db, manual, set())[2] == "设备上有在跑的任务"
    assert sched._eligibility(db, manual, {device.id})[2] == "设备忙"
