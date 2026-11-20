"""保活 + 登录体检 + 判掉登录前先点「快速进入」(B4.1 同款,2026-10-08)。

现场:「洞穴Q弹的荆芥」会话过期,闲鱼登录框里就是「快速进入 t**2」,点一下就能回来;
我们直接判掉登录、冻号,当天的上架全卡住。B4.1 每次导航后自动点「保持登录状态」「快速进入」,
每个号约 10 分钟开一次首页、每小时查一遍登录态。
"""
from datetime import datetime, timedelta
from uuid import uuid4

from sqlalchemy.orm import sessionmaker

import app.scheduler as sched_mod
from app.flow import runner
from app.flow.web import keepalive_web, login
from app.models import Account, AccountStatus, Device, DeviceStatus, RiskState, Task, TaskStatus
from app.scheduler import Scheduler

H = 1000


class FakeWebT:
    """网页版流程用到的原语最小集。页头 nick-- 元素:登着是昵称,没登是「登录」。"""

    def __init__(self, logged_in=True, quick=False, assist_error=None, risk_text=None,
                 dialog=False, reconnect_error=None):
        self.logged_in = logged_in
        self.quick = quick                  # 登录框里有没有「快速进入」
        self.assist_error = assist_error    # 老执行端没有 login_assist 原语
        self.risk_text = risk_text
        self.dialog = dialog                # 页面挂着「连接中断，请重连」弹窗
        self.reconnect_error = reconnect_error   # 老执行端没有 reconnect_assist 原语
        self.urls = []
        self.assists = 0
        self.reconnects = 0

    def launch_app(self, url):
        self.urls.append(url)

    def screen_size(self):
        return 1920, H

    def screencap(self):
        return b"png"

    def dump_nodes(self):
        nodes = [{"desc": "洞穴Q弹的荆芥" if self.logged_in else "登录", "cls": "nick--RyNYtDXM",
                  "center": (1700, 40), "size": (80, 20)}]
        if self.risk_text:
            nodes.append({"desc": self.risk_text, "cls": "x", "center": (900, 500), "size": (300, 40)})
        return nodes

    def risk_punish_active(self):
        return None

    def login_assist(self):
        self.assists += 1
        if self.assist_error:
            raise self.assist_error
        if self.dialog:
            return None               # 弹窗把登录按钮压在底下，什么都点不到
        if self.quick:
            self.logged_in = True
            return "快速进入"
        return None

    def reconnect_assist(self):
        """弹窗在时 login_assist 点空；刷新后弹窗消失，登录卡片才可能点得到。"""
        self.reconnects += 1
        if self.reconnect_error:
            raise self.reconnect_error
        if not self.dialog:
            return {"dialog": False, "clicked": None}
        self.dialog = False               # 刷新后弹窗没了
        if self.quick:
            self.logged_in = True
            return {"dialog": True, "clicked": "快速进入"}
        return {"dialog": True, "clicked": None}


def _no_sleep(monkeypatch):
    monkeypatch.setattr(login.time, "sleep", lambda *_: None)


def _shots(name, data):
    return f"shots/{name}.png"


# ---------- 保活流程 ----------

def test_keepalive_logged_in_does_nothing_else(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=True)
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert r["ok"] and not r.get("login") and not r.get("recovered")
    assert t.urls == [keepalive_web.HOME_URL] and t.assists == 0


def test_keepalive_quick_entry_recovers_without_a_person(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=False, quick=True)
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert r["ok"] and r.get("recovered")
    assert t.assists == 1
    assert t.urls == [keepalive_web.HOME_URL, keepalive_web.HOME_URL], "点完要重开首页再看"


def test_keepalive_really_logged_out_reports_login(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=False, quick=False)
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert not r["ok"] and r.get("login") is True and r["failed_step"] == "keepalive"


def test_old_executor_without_login_assist_falls_back(monkeypatch):
    """执行端没升级:login_assist 原语报错 → 当没点到,照旧判掉登录,不崩。"""
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=False, assist_error=RuntimeError("unknown op login_assist"))
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert r.get("login") is True and "流程崩溃" not in (r.get("reason") or "")


def test_keepalive_reconnect_dialog_recovers_without_a_person(monkeypatch):
    """2026-10-10 现场(erp-txy gc-api 日志):/im 页挂「连接中断，请重连」弹窗,
    login_assist 逐 frame 点空 → 直接 FAILED(网页版未登录)。现在:刷新页面再点
    「快速进入」,救回来照样算成功,不冻号。"""
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=False, quick=True, dialog=True)
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert r["ok"] and r.get("recovered")
    assert t.assists == 1 and t.reconnects == 1
    assert t.urls == [keepalive_web.HOME_URL, keepalive_web.HOME_URL], "救回来也要重开首页再看"


def test_keepalive_dialog_but_click_missed_still_declares_login(monkeypatch):
    """弹窗在、刷新后登录卡片没出来:如实判掉登录,不能当救回来了。"""
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=False, quick=False, dialog=True)
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert not r["ok"] and r.get("login") is True
    assert t.reconnects == login.RECOVER_ROUNDS


def test_old_executor_without_reconnect_assist_falls_back(monkeypatch):
    """执行端没升级:reconnect_assist 报错 → 当没救到,照旧判掉登录,不崩。"""
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=False, quick=False,
                 reconnect_error=RuntimeError("unknown op reconnect_assist"))
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert r.get("login") is True and "流程崩溃" not in (r.get("reason") or "")


def test_keepalive_sees_risk(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=True, risk_text="请拖动下方滑块完成验证")
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert not r["ok"] and r.get("risk")


def test_keepalive_is_a_browser_flow_the_scheduler_dispatches():
    assert runner._pick_flow("keepalive", "browser") is keepalive_web.run_keepalive_web
    assert "keepalive" in runner.DISPATCHABLE_TYPES
    assert runner._pick_flow("keepalive", "android") is None   # 手机不建保活


# ---------- 各业务流程:判掉登录前先点快速进入 ----------

def test_business_flows_quick_entry_before_declaring_logout(monkeypatch):
    from app.flow.web import goods_flows_web, publish_flow_web, read_chats_web, reply_chat_web
    _no_sleep(monkeypatch)
    for mod in (read_chats_web, reply_chat_web, goods_flows_web, publish_flow_web):
        t = FakeWebT(logged_in=False, quick=True)
        nodes = mod._flat(t.dump_nodes())
        save_shot = (lambda name, data=None: f"shots/{name}.png")
        got = mod._ensure_login(t, nodes, H, save_shot)
        assert t.assists == 1, mod.__name__
        assert any("洞穴Q弹的荆芥" == n.get("desc") for n in got), f"{mod.__name__} 没返回重开后的节点"


def test_business_flows_reconnect_dialog_before_declaring_logout(monkeypatch):
    """业务流同样:断连弹窗压住的「快速进入」救回来后,重开起始页、返回重读的节点。"""
    from app.flow.web import goods_flows_web, publish_flow_web, read_chats_web, reply_chat_web
    _no_sleep(monkeypatch)
    for mod in (read_chats_web, reply_chat_web, goods_flows_web, publish_flow_web):
        t = FakeWebT(logged_in=False, quick=True, dialog=True)
        nodes = mod._flat(t.dump_nodes())
        save_shot = (lambda name, data=None: f"shots/{name}.png")
        got = mod._ensure_login(t, nodes, H, save_shot)
        assert t.assists == 1 and t.reconnects == 1, mod.__name__
        assert any("洞穴Q弹的荆芥" == n.get("desc") for n in got), f"{mod.__name__} 没返回重开后的节点"


def test_publish_flow_no_longer_takes_login_text_as_a_nick(monkeypatch):
    """发布流程以前只看 nick-- 有没有字,未登录时的「登录」也算登着。"""
    import pytest

    from app.flow.engine import LoginRequired
    from app.flow.web import publish_flow_web
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=False, quick=False)
    with pytest.raises(LoginRequired):
        publish_flow_web._ensure_login(t, publish_flow_web._flat(t.dump_nodes()), H,
                                       lambda name: f"shots/{name}.png")


# ---------- 调度:什么时候建保活、什么时候派 ----------

def _bind(db, monkeypatch):
    monkeypatch.setattr(sched_mod, "SessionLocal",
                        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False))


def _acc(db, *, kind="browser", online=True, status=AccountStatus.ACTIVE,
         risk=RiskState.NORMAL, idle_min=30, window="09:00-23:00"):
    dev = Device(name="d", kind=kind, status=DeviceStatus.ONLINE if online else DeviceStatus.OFFLINE)
    db.add(dev)
    db.flush()
    acc = Account(nick=f"n-{uuid4().hex[:8]}", device_id=dev.id, status=status, risk_state=risk,
                  active_window=window,
                  last_op_at=datetime.utcnow() - timedelta(minutes=idle_min) if idle_min is not None else None)
    db.add(acc)
    db.commit()
    return acc.id


def _keepalives(db, aid):
    return db.query(Task).filter(Task.account_id == aid, Task.task_type == "keepalive").all()


def test_keepalive_created_only_for_idle_active_online_browser_accounts(db, monkeypatch):
    _bind(db, monkeypatch)
    idle = _acc(db)
    never = _acc(db, idle_min=None)
    busy = _acc(db, idle_min=3)                                   # 刚干过活(消息巡检刚跑完)
    phone = _acc(db, kind="android")
    offline = _acc(db, online=False)
    other_frozen = _acc(db, status=AccountStatus.FROZEN)          # 人工冻的,备注不是掉登录
    risk_frozen = _acc(db, status=AccountStatus.FROZEN, risk=RiskState.FROZEN)

    Scheduler(bridge=None)._keepalive_pass()
    Scheduler(bridge=None)._keepalive_pass()                      # 再扫一轮:在途去重,不重复建

    db.expire_all()
    assert len(_keepalives(db, idle)) == 1
    assert len(_keepalives(db, never)) == 1
    for aid in (busy, phone, offline, other_frozen, risk_frozen):
        assert _keepalives(db, aid) == [], aid


def _login_frozen(db, **kw):
    aid = _acc(db, status=AccountStatus.FROZEN, **kw)
    acc = db.get(Account, aid)
    acc.risk_note = "账号掉登录,重新登录后自动恢复 @ 2026-10-14T06:51:43"
    db.commit()
    return aid


def test_login_frozen_account_still_gets_keepalive_to_rescue_itself(db, monkeypatch):
    """2026-10-14:南方举重雪白海胆掉登录冻着,保活不派 → 没人去点「快速进入」,一直冻到有人来。
    掉登录是机器能自己确认解除的冻结:保活照样建、照样派;别的任务照旧不派。"""
    _bind(db, monkeypatch)
    aid = _login_frozen(db)
    Scheduler(bridge=None)._keepalive_pass()
    db.expire_all()
    [keep] = _keepalives(db, aid)
    pub = Task(task_type="goods_publish", account_id=aid, status=TaskStatus.PENDING)
    db.add(pub)
    db.commit()
    s = Scheduler(bridge=None)
    assert s._eligibility(db, keep, set())[2] is None, "保活要派过去自救"
    assert s._eligibility(db, pub, set())[2] == "账号不可用/已冻结", "业务任务等登回去再派"


def test_risk_frozen_with_login_note_gets_nothing(db, monkeypatch):
    """备注是掉登录、但风控也冻了:要人处理,保活也不碰。"""
    _bind(db, monkeypatch)
    aid = _login_frozen(db, risk=RiskState.FROZEN)
    Scheduler(bridge=None)._keepalive_pass()
    db.expire_all()
    assert _keepalives(db, aid) == []
    keep = Task(task_type="keepalive", account_id=aid, status=TaskStatus.PENDING)
    db.add(keep)
    db.commit()
    assert Scheduler(bridge=None)._eligibility(db, keep, set())[2] == "账号不可用/已冻结"


def test_failed_rescue_on_login_frozen_account_does_not_refreeze_or_renotify(db, monkeypatch):
    """宽限期内自救没救回来:不重复冻、不通知、不取消冻结期间排进来的单。"""
    sent = []
    monkeypatch.setattr("app.notify._send", lambda *a, **k: sent.append(a))
    monkeypatch.setattr("app.jobs.on_task_result", lambda *a, **k: None, raising=False)
    aid = _login_frozen(db)
    acc = db.get(Account, aid)
    acc.risk_note = f"账号掉登录,重新登录后自动恢复 @ {datetime.utcnow().isoformat()}"
    db.commit()
    note = acc.risk_note
    queued = Task(task_type="goods_publish", account_id=aid, status=TaskStatus.PENDING)
    keep = Task(task_type="keepalive", account_id=aid, device_id=acc.device_id, status=TaskStatus.RUNNING)
    db.add_all([queued, keep])
    db.commit()
    runner._apply_result(db, keep, {"ok": False, "failed_step": "keepalive", "login": True,
                                    "reason": "网页版未登录(首页无账号昵称)"})
    db.expire_all()
    assert db.get(Account, aid).risk_note == note, "冻结时间别被刷新"
    assert db.get(Task, queued.id).status == TaskStatus.PENDING, "冻结期间排进来的单要留着"
    assert sent == [], "机器还在救,不叫人"
    assert db.get(Task, keep.id).status == TaskStatus.FAILED


def test_browser_first_login_loss_freezes_silently_and_keeps_queue(db, monkeypatch):
    """浏览器号第一次判掉登录:冻住等保活救,不叫人,待办留着。"""
    sent = []
    monkeypatch.setattr("app.notify._send", lambda *a, **k: sent.append(a))
    aid = _acc(db)
    acc = db.get(Account, aid)
    queued = Task(task_type="goods_publish", account_id=aid, status=TaskStatus.PENDING)
    scan = Task(task_type="chat_scan", account_id=aid, device_id=acc.device_id, status=TaskStatus.RUNNING)
    db.add_all([queued, scan])
    db.commit()
    runner._apply_result(db, scan, {"ok": False, "failed_step": "read_chats", "login": True,
                                    "reason": "网页版未登录(/im 无账号昵称)"})
    db.expire_all()
    acc = db.get(Account, aid)
    assert acc.status == AccountStatus.FROZEN and acc.risk_note.startswith("账号掉登录")
    assert db.get(Task, queued.id).status == TaskStatus.PENDING
    assert sent == []


def test_login_loss_notifies_once_after_grace(db, monkeypatch):
    """过了宽限期还没救回来才叫人,一次冻结只叫一次;之后登回来发「已恢复」。"""
    sent = []
    monkeypatch.setattr("app.notify._send", lambda *a, **k: sent.append(a))
    aid = _login_frozen(db)   # 冻结时间是很久以前
    acc = db.get(Account, aid)
    for _ in range(2):
        keep = Task(task_type="keepalive", account_id=aid, device_id=acc.device_id, status=TaskStatus.RUNNING)
        db.add(keep)
        db.commit()
        runner._apply_result(db, keep, {"ok": False, "failed_step": "keepalive", "login": True,
                                        "reason": "网页版未登录(首页无账号昵称)"})
        db.expire_all()
        acc = db.get(Account, aid)
    assert [s[0] for s in sent] == ["闲鱼账号掉登录"]
    keep = Task(task_type="keepalive", account_id=aid, device_id=acc.device_id, status=TaskStatus.RUNNING)
    db.add(keep)
    db.commit()
    runner._apply_result(db, keep, {"ok": True, "done": ["keepalive"]})
    db.expire_all()
    assert db.get(Account, aid).status == AccountStatus.ACTIVE
    assert sent[-1][0] == "闲鱼账号已恢复"


def test_keepalive_success_unfreezes_a_false_alarm_silently(db, monkeypatch):
    """误判冻的号执行端一直报着昵称,等不到 identity 的变化:保活读到昵称就解冻。还没叫过人就不发通知。"""
    sent = []
    monkeypatch.setattr("app.notify._send", lambda *a, **k: sent.append(a))
    aid = _login_frozen(db)
    acc = db.get(Account, aid)
    keep = Task(task_type="keepalive", account_id=aid, device_id=acc.device_id, status=TaskStatus.RUNNING)
    db.add(keep)
    db.commit()
    runner._apply_result(db, keep, {"ok": True, "done": ["keepalive"]})
    db.expire_all()
    acc = db.get(Account, aid)
    assert acc.status == AccountStatus.ACTIVE and not acc.risk_note
    assert sent == []


def test_nick_rendering_late_is_not_a_logout(monkeypatch):
    """2026-10-30 现场:第一次读不到昵称,页面其实登着。原地重读就够,不点不刷新。"""
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=True)
    seen = []
    real = t.dump_nodes
    def dump():
        seen.append(1)
        return [] if len(seen) == 1 else real()
    t.dump_nodes = dump
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert r["ok"] and t.assists == 0 and t.urls == [keepalive_web.HOME_URL]


def test_quick_entry_appears_only_after_refresh(monkeypatch):
    """第一次点不到按钮,刷新后「快速进入」才出来:点上,不判掉登录。"""
    _no_sleep(monkeypatch)
    t = FakeWebT(logged_in=False, quick=False)
    real_launch = t.launch_app
    def launch(url):
        real_launch(url)
        if len(t.urls) >= 2:   # 第一次开页之后的刷新
            t.quick = True
    t.launch_app = launch
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert r["ok"] and r.get("recovered") and t.assists == 2


def test_recently_frozen_account_is_retried_sooner(db, monkeypatch):
    _bind(db, monkeypatch)
    aid = _acc(db, idle_min=5)
    acc = db.get(Account, aid)
    acc.status = AccountStatus.FROZEN
    acc.risk_note = f"账号掉登录,重新登录后自动恢复 @ {datetime.utcnow().isoformat()}"
    db.commit()
    Scheduler(bridge=None)._keepalive_pass()
    db.expire_all()
    assert len(_keepalives(db, aid)) == 1


def test_restart_pause_reminder_once_a_day_in_daytime(db, monkeypatch):
    from app import notify
    _bind(db, monkeypatch)
    sent = []
    monkeypatch.setattr(notify, "_send", lambda *a, **k: sent.append(a) or True)
    now = datetime.utcnow()
    db.add(Device(name="d", kind="browser", status=DeviceStatus.OFFLINE, maintenance_reason="pc_restart",
                  maintenance_since=now - timedelta(hours=2), maintenance_until=now - timedelta(hours=1)))
    db.commit()
    assert notify.notify_restart_pause(db, 1, now=datetime(2026, 10, 31, 17, 0)) is False   # 北京 01:00
    assert notify.notify_restart_pause(db, 1, now=datetime(2026, 10, 31, 3, 0)) is True     # 北京 11:00
    assert notify.notify_restart_pause(db, 1, now=datetime(2026, 10, 31, 5, 0)) is False    # 同一天
    assert len(sent) == 1
    db.commit()
    Scheduler(bridge=None)._restart_pause_reminder_pass()   # 查询走得通
    assert len(sent) <= 2


def test_android_first_login_loss_still_cancels_and_notifies(db, monkeypatch):
    sent = []
    monkeypatch.setattr("app.notify._send", lambda *a, **k: sent.append(a))
    aid = _acc(db, kind="android")
    acc = db.get(Account, aid)
    queued = Task(task_type="goods_publish", account_id=aid, status=TaskStatus.PENDING)
    scan = Task(task_type="chat_scan", account_id=aid, device_id=acc.device_id, status=TaskStatus.RUNNING)
    db.add_all([queued, scan])
    db.commit()
    runner._apply_result(db, scan, {"ok": False, "failed_step": "read_chats", "login": True,
                                    "reason": "网页版未登录(/im 无账号昵称)"})
    db.expire_all()
    acc = db.get(Account, aid)
    assert acc.status == AccountStatus.FROZEN and acc.risk_note.startswith("账号掉登录")
    assert db.get(Task, queued.id).status == TaskStatus.CANCELLED
    assert len(sent) == 1


def test_keepalive_can_be_switched_off(db, monkeypatch):
    _bind(db, monkeypatch)
    monkeypatch.setattr(sched_mod.settings, "keepalive_enabled", False)
    aid = _acc(db)
    Scheduler(bridge=None)._keepalive_pass()
    db.expire_all()
    assert _keepalives(db, aid) == []


def test_keepalive_runs_outside_the_active_window_business_tasks_do_not(db, monkeypatch):
    """夜里会话过期也要在早上第一单之前发现:保活不受作息窗口限制,业务任务照旧受限。"""
    monkeypatch.setattr(sched_mod, "_in_window", lambda w: False)
    aid = _acc(db)
    keep = Task(task_type="keepalive", account_id=aid, status=TaskStatus.PENDING)
    pub = Task(task_type="goods_publish", account_id=aid, status=TaskStatus.PENDING)
    db.add_all([keep, pub])
    db.commit()
    s = Scheduler(bridge=None)
    assert s._eligibility(db, keep, set())[2] is None
    assert s._eligibility(db, pub, set())[2] == "不在作息窗口"


def test_reconnect_dialog_rescue_survives_action_tracing(monkeypatch):
    """生产上动作留痕默认开,流程拿到的是 TraceTransport。它以前只透传 login_assist、
    没透传 reconnect_assist,web/login.py 的 getattr 拿不到 → 「连接中断」自救在生产上
    一次都没跑过(2026-10-14 查 gc-api 日志 0 次)。包上留痕照样要救得回来。"""
    from app.flow.trace import TraceTransport
    monkeypatch.setattr("app.flow.trace.time.sleep", lambda *_: None)
    _no_sleep(monkeypatch)
    inner = FakeWebT(logged_in=False, quick=True, dialog=True)
    t = TraceTransport(inner, _shots, label="t-trace")
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert r["ok"] and r.get("recovered"), r
    assert inner.reconnects == 1
    assert [x["action"] for x in t.records if x["action"].endswith("assist")] == [
        "login_assist", "reconnect_assist"], "刷新 + 点按钮要留痕,出事能回放"


# ---------- 自救失败留档 ----------

def _diag_env(monkeypatch):
    _no_sleep(monkeypatch)
    login._diag_saved_at.clear()
    saved = {}
    def save_blob(name, data, ext):
        key = f"k/{name}.{ext}"
        saved[key] = data
        return key
    monkeypatch.setattr(login.storage, "save_blob", save_blob)
    return saved


def test_failed_rescue_saves_shot_html_and_manifest(monkeypatch):
    import json
    saved = _diag_env(monkeypatch)
    t = FakeWebT(logged_in=False, quick=False)
    t.device_id = "abcdef1234"
    t.page_snapshot = lambda: {"url": "https://www.goofish.com/", "frames": [
        {"url": "https://passport.goofish.com/x", "name": "", "html": "<button>扫码</button>"}]}
    r = keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    assert r.get("login") and t.login_diag == "k/login_diag_abcdef12.json"
    m = json.loads(saved[t.login_diag])
    assert len(m["rounds"]) == login.RECOVER_ROUNDS + 1
    first = m["rounds"][0]
    assert first["clicked"] is None and first["frames"][0]["url"].startswith("https://passport")
    assert saved[first["shot"]] == b"png"
    assert "<button>扫码</button>" in saved[first["html"]].decode()


def test_old_executor_without_snapshot_still_saves_shot_and_nodes(monkeypatch):
    import json
    saved = _diag_env(monkeypatch)
    t = FakeWebT(logged_in=False, quick=False)
    t.device_id = "abcdef1234"
    keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)
    row = json.loads(saved[t.login_diag])["rounds"][0]
    assert row["shot"] and row["nodes"][0]["desc"] == "登录" and row["html_error"]


def test_successful_rescue_saves_nothing_and_failures_are_throttled(monkeypatch):
    saved = _diag_env(monkeypatch)
    t = FakeWebT(logged_in=False, quick=True)
    t.device_id = "dev1"
    assert keepalive_web.run_keepalive_web(t, {}, shot_sink=_shots)["ok"]
    assert saved == {} and not hasattr(t, "login_diag")

    for _ in range(2):
        t2 = FakeWebT(logged_in=False, quick=False)
        t2.device_id = "dev1"
        keepalive_web.run_keepalive_web(t2, {}, shot_sink=_shots)
    assert len([k for k in saved if k.endswith(".json")]) == 1
