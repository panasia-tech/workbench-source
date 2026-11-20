"""掉登录冻结的号,人重新登录后自动解冻(2026-10-08)。

现场:两个浏览器号先后掉登录被冻,人在浏览器里重新登录了,执行端也报出了昵称,冻结却还挂着——
解冻只能去行情台手点,没人知道要点。当天下了 5 次上架,调度器一单都没派,浏览器毫无反应。

掉登录冻结只冻 status、备注以 LOGIN_LOST_NOTE 开头;风控冻结另冻 risk_state,不在自动解冻之列。
只认「这台机先报没登录、再报出昵称」这一下变化:刚冻号时页头还挂着旧昵称,光看「报了昵称」
会刚冻就解、下一单又冻。
"""
from sqlalchemy.orm import sessionmaker

import app.mqtt_bridge as mb
from app.flow import runner
from app.models import (
    LOGIN_LOST_NOTE, Account, AccountStatus, Device, DeviceStatus, RiskState, Task, TaskStatus,
)


class _SyncThread:
    """通知线程改成当场跑,好断言发了什么。"""

    def __init__(self, target, args=(), daemon=None):
        self._target, self._args = target, args

    def start(self):
        self._target(*self._args)


def _setup(db, monkeypatch):
    monkeypatch.setattr(mb, "SessionLocal",
                        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False))
    monkeypatch.setattr(mb.threading, "Thread", _SyncThread)
    monkeypatch.setattr("app.jobs.on_task_result", lambda *a, **k: None)
    monkeypatch.setattr("app.notify.notify_wecom", lambda *a, **k: False)
    sent = []
    monkeypatch.setattr("app.notify.notify",
                        lambda title, desp, **k: sent.append((title, desp)) or True)
    return sent


def _identity(device_id, nick):
    mb._apply_report(device_id, {"kind": "identity", "xianyu_installed": True,
                                 "xianyu_nick": nick, "ready": bool(nick), "blocking": ""})


def _frozen_account(db, *, reported_nick, risk_state=RiskState.NORMAL,
                    note=f"{LOGIN_LOST_NOTE},重新登录后自动恢复 @ 2026-10-08T02:07:38"):
    dev = Device(name="adspower browser", kind="browser", hw_id="k1ho3jr0",
                 status=DeviceStatus.ONLINE, reported_nick=reported_nick)
    db.add(dev)
    db.flush()
    acc = Account(nick="洞穴Q弹的荆芥", device_id=dev.id, status=AccountStatus.FROZEN,
                  risk_state=risk_state, risk_note=note)
    db.add(acc)
    db.commit()
    return dev.id, acc.id


def test_login_lost_then_relogin_resumes_without_manual_unfreeze(db, monkeypatch):
    """整条链路:任务判掉登录 → 冻号、过了宽限期通知说登上就恢复 → 执行端报没登录 → 报出昵称 → 自动解冻,新单能派。"""
    sent = _setup(db, monkeypatch)
    dev = Device(name="adspower browser", kind="browser", hw_id="k1ho3jr0",
                 status=DeviceStatus.ONLINE, reported_nick="洞穴Q弹的荆芥")
    db.add(dev)
    db.flush()
    acc = Account(nick="洞穴Q弹的荆芥", device_id=dev.id, status=AccountStatus.ACTIVE)
    db.add(acc)
    db.flush()
    scan = Task(task_type="chat_scan", account_id=acc.id, device_id=dev.id, status=TaskStatus.RUNNING)
    db.add(scan)
    db.commit()
    did, aid = dev.id, acc.id

    runner._apply_result(db, scan, {"ok": False, "login": True, "failed_step": "read_chats",
                                    "reason": "网页版未登录(/im 无账号昵称)", "shot": None})
    db.expire_all()
    acc = db.get(Account, aid)
    assert acc.status == AccountStatus.FROZEN and acc.risk_state == RiskState.NORMAL
    assert acc.risk_note.startswith(LOGIN_LOST_NOTE)
    assert sent == [], "宽限期内机器还在救,不叫人"

    acc.risk_note = f"{LOGIN_LOST_NOTE},重新登录后自动恢复 @ 2026-10-08T02:07:38"   # 过了宽限期
    keep = Task(task_type="keepalive", account_id=aid, device_id=did, status=TaskStatus.RUNNING)
    db.add(keep)
    db.commit()
    runner._apply_result(db, keep, {"ok": False, "login": True, "failed_step": "keepalive",
                                    "reason": "网页版未登录(首页无账号昵称)", "shot": None})
    [(title, desp)] = sent
    assert "k1ho3jr0" in desp, "要说清去哪个浏览器窗口登录"
    assert "自动恢复" in desp and "不用点解冻" in desp

    _identity(did, "")                 # 冻号后页面刷新了,页头是「登录」
    db.expire_all()
    assert db.get(Account, aid).status == AccountStatus.FROZEN

    _identity(did, "洞穴Q弹的荆芥")     # 人在窗口里重新登录了
    db.expire_all()
    acc = db.get(Account, aid)
    assert acc.status == AccountStatus.ACTIVE
    assert not acc.risk_note
    assert sent[-1][0] == "闲鱼账号已恢复" and "洞穴Q弹的荆芥" in sent[-1][1]


def test_placeholder_nick_counts_as_logged_out(db, monkeypatch):
    """未登录时锚点读到的是「登录」入口文案,它也算没登录,之后报出昵称照样解冻。"""
    _setup(db, monkeypatch)
    did, aid = _frozen_account(db, reported_nick="登录")
    _identity(did, "洞穴Q弹的荆芥")
    db.expire_all()
    assert db.get(Account, aid).status == AccountStatus.ACTIVE


def test_relogin_on_an_env_that_had_another_account(db, monkeypatch):
    """这个环境上一帧报的是别的号,人换登成被冻的号,也算重新登录。"""
    _setup(db, monkeypatch)
    did, aid = _frozen_account(db, reported_nick="另一个号")
    _identity(did, "洞穴Q弹的荆芥")
    db.expire_all()
    assert db.get(Account, aid).status == AccountStatus.ACTIVE


def test_stale_nick_right_after_freeze_does_not_unfreeze(db, monkeypatch):
    """冻号前后一直报着昵称(页面没刷新,页头是旧的),不算重新登录。"""
    sent = _setup(db, monkeypatch)
    did, aid = _frozen_account(db, reported_nick="洞穴Q弹的荆芥")
    _identity(did, "洞穴Q弹的荆芥")
    db.expire_all()
    assert db.get(Account, aid).status == AccountStatus.FROZEN
    assert sent == []


def test_risk_freeze_still_needs_a_person(db, monkeypatch):
    """风控冻结(要扫码认证之类)重新报出昵称也不自动解冻。"""
    sent = _setup(db, monkeypatch)
    did, aid = _frozen_account(db, reported_nick="", risk_state=RiskState.FROZEN,
                               note="命中风控:完成认证才可继续发布 @ 2026-10-06T08:00:00")
    _identity(did, "洞穴Q弹的荆芥")
    db.expire_all()
    acc = db.get(Account, aid)
    assert acc.status == AccountStatus.FROZEN and acc.risk_state == RiskState.FROZEN
    assert sent == []


def test_freeze_for_other_reasons_is_left_alone(db, monkeypatch):
    """不是掉登录冻的号(备注不对),一律不碰。"""
    _setup(db, monkeypatch)
    did, aid = _frozen_account(db, reported_nick="", note="管理员手动冻结")
    _identity(did, "洞穴Q弹的荆芥")
    db.expire_all()
    assert db.get(Account, aid).status == AccountStatus.FROZEN


def test_old_note_wording_on_production_rows_still_unfreezes(db, monkeypatch):
    """上线前冻的号备注是老写法「账号掉登录,需人工重新登录 @ …」,前缀一样,照样认。"""
    _setup(db, monkeypatch)
    did, aid = _frozen_account(db, reported_nick="",
                               note="账号掉登录,需人工重新登录 @ 2026-10-08T02:07:38.518652")
    _identity(did, "洞穴Q弹的荆芥")
    db.expire_all()
    assert db.get(Account, aid).status == AccountStatus.ACTIVE
