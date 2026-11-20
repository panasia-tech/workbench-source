"""GET /api/gc/units:账号为主体的执行单元列表(真机与浏览器共表)。

这是桌面守护端「执行单元管理」页的数据源。要点:
- 一个账号一行,device.kind 区分真机/浏览器,没绑执行端时 device 为 null
- 今日配额用量必须与 scheduler 的派发闸同口径(SUCCESS + 北京日界 + 类别聚合)
直接调 endpoint 函数(仓库风格,不经 TestClient/httpx)。
"""

from datetime import datetime, timedelta

from app import api
from app.models import Account, AccountStatus, Device, DeviceStatus, RiskState, Task, TaskStatus
from app.scheduler import _cn_today_utc_range


def _dev(db, name, kind="android", **kw):
    d = Device(name=name, kind=kind, status=DeviceStatus.ONLINE, **kw)
    db.add(d)
    db.flush()
    return d


def _acc(db, nick, device=None, **kw):
    a = Account(nick=nick, device_id=device.id if device else None, **kw)
    db.add(a)
    db.flush()
    return a


def _done(db, acc, task_type, when):
    """一条今日已完成任务(计入配额)。"""
    t = Task(task_type=task_type, status=TaskStatus.SUCCESS, account_id=acc.id, finished_at=when, spec={})
    db.add(t)
    return t


def test_units_mixes_phone_and_browser(db_session):
    """真机和浏览器在同一个列表里,靠 device.kind 区分——这就是「合并」本身。"""
    p = _dev(db_session, "Phone-01", "android", brand="Samsung", model="S23")
    b = _dev(db_session, "AdsPower-018", "browser")
    _acc(db_session, "甜甜小铺", p)
    _acc(db_session, "潮玩仓库", b)
    db_session.commit()

    units = api.list_units(kind=None, db=db_session)
    assert len(units) == 2
    by_nick = {u.nick: u for u in units}
    assert by_nick["甜甜小铺"].device.kind == "android"
    assert by_nick["甜甜小铺"].device.model == "S23"
    assert by_nick["潮玩仓库"].device.kind == "browser"


def test_units_kind_filter(db_session):
    p = _dev(db_session, "Phone-01", "android")
    b = _dev(db_session, "AdsPower-018", "browser")
    _acc(db_session, "甜甜小铺", p)
    _acc(db_session, "潮玩仓库", b)
    db_session.commit()

    assert [u.nick for u in api.list_units(kind="browser", db=db_session)] == ["潮玩仓库"]
    assert [u.nick for u in api.list_units(kind="android", db=db_session)] == ["甜甜小铺"]


def test_unit_without_device_is_kept(db_session):
    """账号还没绑执行端也要出现在列表里(空置单元),否则界面会漏账号。"""
    _acc(db_session, "没绑机的账号")
    db_session.commit()

    units = api.list_units(kind=None, db=db_session)
    assert len(units) == 1
    assert units[0].device is None
    assert units[0].task is None


def test_quota_counts_today_success_by_category(db_session):
    """配额用量按类别聚合:goods_publish → publish。只数今天的 SUCCESS。"""
    lo, hi = _cn_today_utc_range()
    today = lo + timedelta(hours=1)
    yesterday = lo - timedelta(hours=2)

    d = _dev(db_session, "Phone-01")
    a = _acc(db_session, "甜甜小铺", d, daily_publish_quota=30)
    _done(db_session, a, "goods_publish", today)
    _done(db_session, a, "goods_publish", today)
    _done(db_session, a, "goods_reprice", today)
    _done(db_session, a, "goods_publish", yesterday)          # 昨天的不算
    db_session.add(Task(task_type="goods_publish", status=TaskStatus.FAILED,
                        account_id=a.id, finished_at=today, spec={}))  # 失败的不算
    db_session.commit()

    u = api.list_units(kind=None, db=db_session)[0]
    assert u.quota["publish"].used == 2
    assert u.quota["publish"].limit == 30
    assert u.quota["reprice"].used == 1
    assert u.quota["delist"].used == 0


def test_quota_not_leaked_across_accounts(db_session):
    """group by 写错最容易出的错:把别人的用量算到自己头上。"""
    d1 = _dev(db_session, "Phone-01")
    d2 = _dev(db_session, "Phone-02")
    a1 = _acc(db_session, "甲店", d1)
    a2 = _acc(db_session, "乙店", d2)
    today = _cn_today_utc_range()[0] + timedelta(hours=1)
    _done(db_session, a1, "goods_publish", today)
    _done(db_session, a2, "goods_publish", today)
    _done(db_session, a2, "goods_publish", today)
    db_session.commit()

    by_nick = {u.nick: u for u in api.list_units(kind=None, db=db_session)}
    assert by_nick["甲店"].quota["publish"].used == 1
    assert by_nick["乙店"].quota["publish"].used == 2


def test_chat_scan_not_counted_as_quota(db_session):
    """chat_scan 有 QUOTA_CATEGORY 但不是三个配额字段之一,不能混进任何一类。"""
    d = _dev(db_session, "Phone-01")
    a = _acc(db_session, "甜甜小铺", d)
    today = _cn_today_utc_range()[0] + timedelta(hours=1)
    for _ in range(5):
        _done(db_session, a, "chat_scan", today)
    db_session.commit()

    u = api.list_units(kind=None, db=db_session)[0]
    assert {k: v.used for k, v in u.quota.items()} == {"publish": 0, "reprice": 0, "delist": 0}


def test_busy_task_surfaced(db_session):
    """设备 busy_task_id 指向的任务要带出来,界面「当前任务」列靠它。"""
    d = _dev(db_session, "Phone-01")
    a = _acc(db_session, "甜甜小铺", d)
    t = Task(task_type="goods_publish", status=TaskStatus.RUNNING, account_id=a.id,
             device_id=d.id, spec={}, created_at=datetime.utcnow())
    db_session.add(t)
    db_session.flush()
    d.busy_task_id = t.id
    db_session.commit()

    u = api.list_units(kind=None, db=db_session)[0]
    assert u.task is not None
    assert u.task.task_type == "goods_publish"
    assert u.task.status == TaskStatus.RUNNING


def test_risk_fields_passed_through(db_session):
    """风控态是这张表的红线信息,不能在聚合里丢掉。"""
    d = _dev(db_session, "Phone-01")
    _acc(db_session, "被冻的店", d, status=AccountStatus.FROZEN,
         risk_state=RiskState.FROZEN, risk_note="发布过频")
    db_session.commit()

    u = api.list_units(kind=None, db=db_session)[0]
    assert u.status == AccountStatus.FROZEN
    assert u.risk_state == RiskState.FROZEN
    assert u.risk_note == "发布过频"
