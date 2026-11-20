"""event / exit_info 帧(gc/{device_id}/report,kind=event / kind=exit_info):
持久化最近一次系统事件/进程死因到 Device,**绝不**动 Device.status(online 归 status 帧)。

直接调 _apply_report;把 mqtt_bridge.SessionLocal 指到测试库(同 test_identity_report 的做法)。
"""
from datetime import datetime

from sqlalchemy.orm import sessionmaker

import app.mqtt_bridge as mb
from app.models import Device, DeviceStatus


def _bind_session(db, monkeypatch):
    monkeypatch.setattr(
        mb, "SessionLocal",
        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False),
    )


def test_event_persists_and_keeps_status(db, monkeypatch):
    _bind_session(db, monkeypatch)
    dev = Device(name="phone", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()
    did = dev.id

    mb._apply_report(did, {
        "kind": "event", "event": "accessibility_lost",
        "detail": "无障碍服务连接断开", "ts": 1780000000000,
    })

    db.expire_all()
    dev = db.get(Device, did)
    assert dev.last_event == "accessibility_lost: 无障碍服务连接断开"
    assert dev.last_event_at is not None
    assert dev.last_report_at is not None
    # 绝不碰 online 态
    assert dev.status == DeviceStatus.ONLINE


def test_event_without_detail(db, monkeypatch):
    _bind_session(db, monkeypatch)
    dev = Device(name="phone", status=DeviceStatus.OFFLINE)
    db.add(dev)
    db.commit()
    did = dev.id

    mb._apply_report(did, {"kind": "event", "event": "watchdog_reconnect", "ts": 1780000000000})

    db.expire_all()
    dev = db.get(Device, did)
    assert dev.last_event == "watchdog_reconnect"
    assert dev.status == DeviceStatus.OFFLINE   # OFFLINE 也不得被抬起


def test_exit_info_persists_reason_and_exit_at(db, monkeypatch):
    _bind_session(db, monkeypatch)
    dev = Device(name="phone", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()
    did = dev.id

    exit_ts = 1780000000000  # ms
    mb._apply_report(did, {
        "kind": "exit_info", "reason": 6, "reason_name": "ANR",
        "importance": 300, "description": "Input dispatching timed out",
        "exit_ts": exit_ts, "ts": exit_ts + 5000,
    })

    db.expire_all()
    dev = db.get(Device, did)
    assert dev.last_exit_reason == "ANR"
    assert dev.last_exit_at == datetime.utcfromtimestamp(exit_ts / 1000)
    assert dev.status == DeviceStatus.ONLINE


def test_exit_info_missing_reason_name_falls_back(db, monkeypatch):
    _bind_session(db, monkeypatch)
    dev = Device(name="phone", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()
    did = dev.id

    mb._apply_report(did, {"kind": "exit_info", "reason": 5, "ts": 1780000000000})

    db.expire_all()
    dev = db.get(Device, did)
    assert dev.last_exit_reason == "REASON_5"
    assert dev.last_exit_at is not None


def test_report_with_task_id_still_works_after_new_kinds(db, monkeypatch):
    """回归:带 task_id 的普通帧不被 event/exit_info 分支吞掉,仍走任务链路。"""
    from app.models import Task, TaskStatus

    _bind_session(db, monkeypatch)
    dev = Device(name="phone", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()
    task = Task(task_type="restart", device_id=dev.id, status=TaskStatus.RUNNING, spec={})
    db.add(task)
    db.commit()
    tid = task.id

    mb._apply_report(dev.id, {"task_id": tid, "status": "end"})
    db.expire_all()
    assert db.get(Task, tid).status == TaskStatus.SUCCESS
