"""identity 帧(gc/{device_id}/report,payload kind=identity):
持久化自检就绪态 + xianyu_nick 非空自动绑 Account + **绝不**动 Device.status(online 归 status 帧)。

直接调 _apply_report(内部分发到 _apply_identity);把 mqtt_bridge.SessionLocal 指到测试库
(同 test_dispatch_binds_device 的做法:_apply_identity 自开 SessionLocal 会话)。
"""
from sqlalchemy.orm import sessionmaker

import app.mqtt_bridge as mb
from app.models import Account, Device, DeviceStatus


def _bind_session(db, monkeypatch):
    monkeypatch.setattr(
        mb, "SessionLocal",
        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False),
    )


def test_identity_persists_ready_and_binds_nick(db, monkeypatch):
    _bind_session(db, monkeypatch)
    dev = Device(name="phone", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()
    did = dev.id

    mb._apply_report(did, {
        "kind": "identity", "xianyu_installed": True, "xianyu_nick": "闲鱼小铺A",
        "ready": True, "blocking": "", "app_version": "2.0.0",
    })

    db.expire_all()
    dev = db.get(Device, did)
    assert dev.last_ready is True
    assert dev.last_check_at is not None
    assert dev.reported_nick == "闲鱼小铺A"
    assert dev.blocking == ""
    assert dev.app_version == "2.0.0"
    # 自动绑定:Account(nick) 指向该机
    acc = db.query(Account).filter(Account.nick == "闲鱼小铺A").first()
    assert acc is not None and acc.device_id == did


def test_identity_does_not_touch_online_status(db, monkeypatch):
    _bind_session(db, monkeypatch)
    # 设备当前 OFFLINE(online 只由 status 帧决定);identity 帧即便 ready=True 也不得改 status
    dev = Device(name="phone", status=DeviceStatus.OFFLINE)
    db.add(dev)
    db.commit()
    did = dev.id

    mb._apply_report(did, {
        "kind": "identity", "xianyu_installed": True, "xianyu_nick": "A",
        "ready": True, "blocking": "",
    })
    db.expire_all()
    assert db.get(Device, did).status == DeviceStatus.OFFLINE


def test_identity_rebinds_existing_account_by_nick(db, monkeypatch):
    _bind_session(db, monkeypatch)
    # 已有 Account(nick) 绑旧设备;identity 上报后按 nick 唯一 upsert,改指向新设备(不新增)
    old = Device(name="old", status=DeviceStatus.ONLINE)
    new = Device(name="new", status=DeviceStatus.ONLINE)
    db.add_all([old, new])
    db.commit()
    db.add(Account(nick="共享昵称", device_id=old.id))
    db.commit()
    new_id = new.id

    mb._apply_report(new_id, {
        "kind": "identity", "xianyu_installed": True, "xianyu_nick": "共享昵称",
        "ready": True, "blocking": "",
    })
    db.expire_all()
    accs = db.query(Account).filter(Account.nick == "共享昵称").all()
    assert len(accs) == 1                 # 不新增
    assert accs[0].device_id == new_id    # 改指向新设备


def test_identity_same_device_switch_account(db, monkeypatch):
    """本机换号:昵称为唯一键——新旧账号各自存在;激活设备切到新账号,旧账号激活指向被清;
    设备史(Device.account_id)指向当前账号。"""
    _bind_session(db, monkeypatch)
    dev = Device(name="phone", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()
    did = dev.id

    mb._apply_report(did, {"kind": "identity", "xianyu_installed": True,
                           "xianyu_nick": "旧号", "ready": True, "blocking": ""})
    mb._apply_report(did, {"kind": "identity", "xianyu_installed": True,
                           "xianyu_nick": "新号", "ready": True, "blocking": ""})
    db.expire_all()
    old = db.query(Account).filter(Account.nick == "旧号").one()
    new = db.query(Account).filter(Account.nick == "新号").one()
    assert new.device_id == did                     # 激活设备=本机
    assert old.device_id is None                    # 旧账号不再以本机为激活设备
    assert db.get(Device, did).account_id == new.id  # 设备史指向当前账号


def test_identity_account_multiple_devices_single_active(db, monkeypatch):
    """一个账号可有多台设备(设备史都保留),但激活设备只有一台(随最新上报切换)。"""
    _bind_session(db, monkeypatch)
    d1 = Device(name="p1", status=DeviceStatus.ONLINE)
    d2 = Device(name="p2", status=DeviceStatus.ONLINE)
    db.add_all([d1, d2])
    db.commit()
    id1, id2 = d1.id, d2.id

    mb._apply_report(id1, {"kind": "identity", "xianyu_installed": True,
                           "xianyu_nick": "A", "ready": True, "blocking": ""})
    mb._apply_report(id2, {"kind": "identity", "xianyu_installed": True,
                           "xianyu_nick": "A", "ready": True, "blocking": ""})
    db.expire_all()
    accs = db.query(Account).filter(Account.nick == "A").all()
    assert len(accs) == 1                    # 昵称唯一,不新增
    assert accs[0].device_id == id2          # 激活设备=最新上报的那台
    assert db.get(Device, id1).account_id == accs[0].id   # 设备史:两台都归入该账号
    assert db.get(Device, id2).account_id == accs[0].id


def test_identity_placeholder_nick_not_bound(db, monkeypatch):
    """占位昵称(账号未设昵称时闲鱼显示「昵称未填写」)不作为绑定依据,防多机挤一个账号。"""
    _bind_session(db, monkeypatch)
    d1 = Device(name="p1", status=DeviceStatus.ONLINE)
    d2 = Device(name="p2", status=DeviceStatus.ONLINE)
    db.add_all([d1, d2])
    db.commit()

    for did in (d1.id, d2.id):
        mb._apply_report(did, {"kind": "identity", "xianyu_installed": True,
                               "xianyu_nick": "昵称未填写", "ready": True, "blocking": ""})
    db.expire_all()
    assert db.query(Account).count() == 0


def test_identity_null_nick_no_bind_and_clears_reported(db, monkeypatch):
    _bind_session(db, monkeypatch)
    dev = Device(name="phone", status=DeviceStatus.ONLINE, reported_nick="旧昵称")
    db.add(dev)
    db.commit()
    did = dev.id

    mb._apply_report(did, {
        "kind": "identity", "xianyu_installed": True, "xianyu_nick": None,
        "ready": False, "blocking": "not_logged_in",
    })
    db.expire_all()
    dev = db.get(Device, did)
    assert dev.last_ready is False
    assert dev.blocking == "not_logged_in"
    assert dev.reported_nick is None      # 未登录如实清空
    assert db.query(Account).count() == 0  # 未建任何 Account


def test_report_with_task_id_still_works(db, monkeypatch):
    """回归:非 identity 帧(带 task_id)仍走原任务链路,不被 identity 分支吞掉。"""
    from app.models import Task, TaskStatus

    _bind_session(db, monkeypatch)
    dev = Device(name="phone", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.commit()
    task = Task(task_type="reboot", device_id=dev.id, status=TaskStatus.RUNNING, spec={})
    db.add(task)
    db.commit()
    tid = task.id

    mb._apply_report(dev.id, {"task_id": tid, "status": "end"})
    db.expire_all()
    assert db.get(Task, tid).status == TaskStatus.SUCCESS
