"""chat_hint 帧(gc/{device_id}/report,kind=chat_hint):浏览器执行端常驻 /im 看到未读
上涨 → 立刻建一单 chat_scan,不等 5 分钟的周期轮询(M2)。

契约:只建任务;不碰 Device.status、不写会话/消息表(消息仍由 chat_scan 正式入库)。
直接调 _apply_report,把 mqtt_bridge.SessionLocal 指到测试库(同 test_event_exit_report)。
"""
import pytest
from sqlalchemy.orm import sessionmaker

import app.mqtt_bridge as mb
from app.config import settings
from app.models import (
    Account,
    AccountStatus,
    Device,
    DeviceStatus,
    RiskState,
    Task,
    TaskStatus,
)

HINT = {
    "kind": "chat_hint", "reason": "unread_up",
    "convs": [{"nick": "x***8", "from": 0, "to": 1}],
    "unread_total": 1, "ts": 1789300000000,
}


@pytest.fixture(autouse=True)
def _reset_throttle():
    """门铃闸是进程内字典,测试之间必须清干净,否则前一条用例会把后一条闸掉。"""
    mb._LAST_HINT_AT.clear()
    yield
    mb._LAST_HINT_AT.clear()


def _bind_session(db, monkeypatch):
    monkeypatch.setattr(
        mb, "SessionLocal",
        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False),
    )


def _device_with_account(db, nick="卖家A"):
    dev = Device(name="browser", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()
    acc = Account(nick=nick, device_id=dev.id,
                  status=AccountStatus.ACTIVE, risk_state=RiskState.NORMAL)
    db.add(acc)
    db.commit()
    return dev.id, acc.id


def _scan_tasks(db, account_id):
    return db.query(Task).filter(Task.account_id == account_id,
                                 Task.task_type == "chat_scan").all()


def test_hint_creates_chat_scan(db, monkeypatch):
    _bind_session(db, monkeypatch)
    did, aid = _device_with_account(db)

    mb._apply_report(did, HINT)

    db.expire_all()
    tasks = _scan_tasks(db, aid)
    assert len(tasks) == 1
    assert tasks[0].status == TaskStatus.PENDING
    assert tasks[0].source == "HINT"        # 与周期扫描(SCHED)分得开,排障能看出是谁触发的
    # 不碰在线态
    assert db.get(Device, did).status == DeviceStatus.ONLINE


def test_hint_reuses_inflight_scan(db, monkeypatch):
    """同账号已有在途 chat_scan → 不重复建单(去重在 jobs.create_chat_scan)。

    两条门铃之间把闸清掉,单独验去重那一道——否则这条用例其实在验节流。
    """
    _bind_session(db, monkeypatch)
    did, aid = _device_with_account(db)

    mb._apply_report(did, HINT)
    mb._LAST_HINT_AT.clear()
    mb._apply_report(did, HINT)

    db.expire_all()
    assert len(_scan_tasks(db, aid)) == 1


def test_hint_throttled_within_min_interval(db, monkeypatch):
    """在途任务被派走之后,门铃仍受同账号最小间隔约束——防执行端异常刷帧刷满任务表。"""
    _bind_session(db, monkeypatch)
    did, aid = _device_with_account(db)

    mb._apply_report(did, HINT)
    db.expire_all()
    # 把首单挪成终态,让 create_chat_scan 的在途去重失效,只剩节流这道闸
    t = _scan_tasks(db, aid)[0]
    t.status = TaskStatus.SUCCESS
    db.commit()

    mb._apply_report(did, HINT)

    db.expire_all()
    assert len(_scan_tasks(db, aid)) == 1


def test_hint_after_interval_creates_again(db, monkeypatch):
    _bind_session(db, monkeypatch)
    did, aid = _device_with_account(db)
    monkeypatch.setattr(settings, "chat_hint_min_interval_sec", 0.0)

    mb._apply_report(did, HINT)
    db.expire_all()
    t = _scan_tasks(db, aid)[0]
    t.status = TaskStatus.SUCCESS
    db.commit()

    mb._apply_report(did, HINT)

    db.expire_all()
    assert len(_scan_tasks(db, aid)) == 2


def test_hint_disabled_creates_nothing(db, monkeypatch):
    _bind_session(db, monkeypatch)
    did, aid = _device_with_account(db)
    monkeypatch.setattr(settings, "chat_hint_enabled", False)

    mb._apply_report(did, HINT)

    db.expire_all()
    assert _scan_tasks(db, aid) == []


def test_hint_without_account_is_ignored(db, monkeypatch):
    """设备还没绑账号(identity 未到)——门铃无处可投,记一行就算了,不许炸。"""
    _bind_session(db, monkeypatch)
    dev = Device(name="browser", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()

    mb._apply_report(dev.id, HINT)      # 不抛

    db.expire_all()
    assert db.query(Task).count() == 0


def test_hint_skips_frozen_account(db, monkeypatch):
    """冻结账号不该被门铃唤起扫描——风控闸在派发侧也会拦,但别把任务先堆出来。"""
    _bind_session(db, monkeypatch)
    dev = Device(name="browser", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()
    acc = Account(nick="冻结号", device_id=dev.id,
                  status=AccountStatus.ACTIVE, risk_state=RiskState.FROZEN)
    db.add(acc)
    db.commit()

    mb._apply_report(dev.id, HINT)

    db.expire_all()
    assert _scan_tasks(db, acc.id) == []
