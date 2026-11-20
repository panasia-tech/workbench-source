"""回归(C1):_dispatch_pass 选中 device 后从未把 task.device_id 写回,
导致 runner.run_task 里 `db.get(Device, task.device_id)` 恒为 None、
每个被派发的任务都以"任务无绑定设备"直接失败,MqttRpcTransport 也无设备可投。

Bug: app/scheduler.py `_dispatch_pass` 只置了 device.busy_task_id / task.status /
task.started_at / task.dispatched_at,漏了 task.device_id = device.id。
修复:补上这一行赋值。
"""

from sqlalchemy.orm import sessionmaker

import app.scheduler as scheduler_module
from app.models import Account, AccountStatus, Device, DeviceStatus, Task, TaskStatus
from app.scheduler import Scheduler


def test_dispatch_sets_device_id(db, monkeypatch):
    device = Device(name="d1", status=DeviceStatus.ONLINE)
    db.add(device)
    db.flush()
    account = Account(nick="a", device_id=device.id, status=AccountStatus.ACTIVE,
                       active_window="00:00-23:59")
    db.add(account)
    db.flush()
    task = Task(task_type="goods_polish", account_id=account.id, status=TaskStatus.PENDING, spec={})
    db.add(task)
    db.commit()
    task_id = task.id

    # _dispatch_pass 自己开 `with SessionLocal() as db:` 新会话(不是本测试的 db fixture
    # 实例),但要看见 fixture 里已建的 device/account/task,所以把 scheduler 模块引用的
    # SessionLocal 换成绑定到同一个内存 sqlite engine 的 sessionmaker(同线程内共享连接)。
    monkeypatch.setattr(scheduler_module, "SessionLocal",
                         sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False))

    sched = Scheduler(bridge=None)
    try:
        # 避免真把 run_task 提交进线程池(会拿生产 SessionLocal/MQTT 桥去跑一整条流程,
        # 与本测试的内存 sqlite 无关,单测里不该触发):submit 降级为 no-op 记录调用即可。
        submitted = []
        monkeypatch.setattr(sched.pool, "submit",
                             lambda fn, *a, **kw: submitted.append((fn, a, kw)))

        sched._dispatch_pass()
    finally:
        sched.pool.shutdown(wait=False, cancel_futures=True)

    db.expire_all()
    got = db.get(Task, task_id)
    assert got.status == TaskStatus.RUNNING
    assert got.device_id == device.id
    assert len(submitted) == 1
