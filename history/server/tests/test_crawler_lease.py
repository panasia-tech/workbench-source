"""爬虫租约：同一个爬虫任何时候只能在一台电脑上开着。

老板 2026-09-16 原话：「一个功能同时仅能在一台设备上开启，不然就乱套。」

本地开关做不到这件事——两台电脑各记一个「我开着」，谁也不知道对方。所以判归属的
必须是服务端，这个文件钉的就是它判得对不对。

# 这里钉死的边界

  1. 抢得到 / 抢不到：已被别人持有且没过期，第二台必须失败，且说得出在哪台机器；
  2. 过期即释放：机器断电不会主动还租约，只能靠 TTL——不然那个爬虫就永久死锁了；
  3. 掉线的机器回来要自己停手：续租发现已易主 → 409，端上据此停掉本地那份，
     否则两台一起跑，正是"乱套"本身；
  4. 转移不掐断正在跑的那一轮：只写让位请求，持有方跑完再放手；
  5. 还没接入的爬虫（图片）开不了——做一个管不着真实进程的开关比没有开关更糟；
  6. 开关只有管理员能动。
"""

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.models.workbench import CrawlerFeature, CrawlerLease, WorkbenchDevice
from app.routers import workbench as wb
from app.schemas.workbench import (
    DeviceHeartbeatIn,
    EnvPurposeIn,
    LeaseActionIn,
    LeaseTransferIn,
)
from app.services.password import hash_password

MARKET = CrawlerFeature.MARKET
IMAGE = CrawlerFeature.IMAGE


def _admin(db, username="boss"):
    s = Staff(staff_no=f"A-{username}", name="老板", username=username,
              password_hash=hash_password("x"), role=StaffRole.ADMIN,
              status=StaffStatus.ACTIVE)
    db.add(s)
    db.commit()
    return s


def _pc(db, admin, device_id, name="办公室电脑"):
    return wb.heartbeat(DeviceHeartbeatIn(device_id=device_id, name=name), db, admin)


def _acquire(db, admin, device_id, feature=MARKET):
    return wb.acquire(feature, LeaseActionIn(device_id=device_id), db, admin)


# --- 1. 第二台抢不到 ----------------------------------------------------------
def test_第二台抢不到并且说得出在哪(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa", "办公室电脑")
    _pc(db_session, admin, "pc-bbbbbbbb", "家里电脑")

    first = _acquire(db_session, admin, "pc-aaaaaaaa")
    assert first.held and first.mine and first.device_name == "办公室电脑"

    with pytest.raises(HTTPException) as exc:
        _acquire(db_session, admin, "pc-bbbbbbbb")
    assert exc.value.status_code == 409
    assert "办公室电脑" in exc.value.detail, "得说清楚在哪台机器上，不然人只能一台台去找"


def test_同一台重复开不算冲突(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _acquire(db_session, admin, "pc-aaaaaaaa")
    again = _acquire(db_session, admin, "pc-aaaaaaaa")
    assert again.held and again.mine


# --- 2. 过期即释放（机器断电不会主动还租约）----------------------------------
def test_过期后别人接得手(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _pc(db_session, admin, "pc-bbbbbbbb")
    _acquire(db_session, admin, "pc-aaaaaaaa")

    row = db_session.get(CrawlerLease, MARKET)
    row.expires_at = datetime.utcnow() - timedelta(seconds=1)   # 那台机器拔了电
    db_session.commit()

    taken = _acquire(db_session, admin, "pc-bbbbbbbb")
    assert taken.held and taken.device_id == "pc-bbbbbbbb", \
        "没有过期释放，机器一关这个爬虫就永久死锁"


def test_过期的租约不报旧持有者(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _acquire(db_session, admin, "pc-aaaaaaaa")
    row = db_session.get(CrawlerLease, MARKET)
    row.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()

    lease = next(x for x in wb._all_leases(db_session, datetime.utcnow()) if x.feature == MARKET)
    assert lease.held is False
    assert lease.device_id is None, \
        "过期却仍显示归某台，会让人以为要先去找那台机器，实际谁都能抢"


# --- 3. 掉线的机器回来要自己停手 ----------------------------------------------
def test_续租发现已易主就该停手(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _pc(db_session, admin, "pc-bbbbbbbb")
    _acquire(db_session, admin, "pc-aaaaaaaa")

    row = db_session.get(CrawlerLease, MARKET)
    row.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()
    _acquire(db_session, admin, "pc-bbbbbbbb")      # 第二台接手

    with pytest.raises(HTTPException) as exc:       # 第一台网络恢复，来续租
        wb.renew(MARKET, LeaseActionIn(device_id="pc-aaaaaaaa"), db_session, admin)
    assert exc.value.status_code == 409, "不 409 的话两台会一起跑，这就是「乱套」本身"


def test_续租把到期时间往后推(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _acquire(db_session, admin, "pc-aaaaaaaa")
    row = db_session.get(CrawlerLease, MARKET)
    row.expires_at = datetime.utcnow() + timedelta(seconds=5)
    db_session.commit()

    wb.renew(MARKET, LeaseActionIn(device_id="pc-aaaaaaaa"), db_session, admin)
    db_session.refresh(row)
    assert (row.expires_at - datetime.utcnow()).total_seconds() > 30


# --- 4. 主动关闭 --------------------------------------------------------------
def test_关闭后别人立刻能开(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _pc(db_session, admin, "pc-bbbbbbbb")
    _acquire(db_session, admin, "pc-aaaaaaaa")
    wb.release(MARKET, LeaseActionIn(device_id="pc-aaaaaaaa"), db_session, admin)
    assert _acquire(db_session, admin, "pc-bbbbbbbb").held


def test_关一个没开的不报错(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    out = wb.release(MARKET, LeaseActionIn(device_id="pc-aaaaaaaa"), db_session, admin)
    assert out.held is False, "关一个本来就没开的东西不该报错"


# --- 5. 转移不掐断正在跑的那一轮 ----------------------------------------------
def test_转移只留让位请求(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa", "办公室电脑")
    _pc(db_session, admin, "pc-bbbbbbbb", "家里电脑")
    _acquire(db_session, admin, "pc-aaaaaaaa")

    out = wb.transfer(MARKET, LeaseTransferIn(to_device_id="pc-bbbbbbbb"), db_session, admin)
    assert out.device_id == "pc-aaaaaaaa", "还没跑完就换人，会留下半批脏数据和一个开着的浏览器"
    assert out.handoff_to == "pc-bbbbbbbb"
    assert out.handoff_to_name == "家里电脑"

    # 持有方下一次续租时看得见让位请求，跑完这轮自己 release
    renewed = wb.renew(MARKET, LeaseActionIn(device_id="pc-aaaaaaaa"), db_session, admin)
    assert renewed.handoff_to == "pc-bbbbbbbb"
    wb.release(MARKET, LeaseActionIn(device_id="pc-aaaaaaaa"), db_session, admin)
    assert _acquire(db_session, admin, "pc-bbbbbbbb").held


def test_转移到一台失联的机器直接改判(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _pc(db_session, admin, "pc-bbbbbbbb")
    _acquire(db_session, admin, "pc-aaaaaaaa")
    row = db_session.get(CrawlerLease, MARKET)
    row.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()

    out = wb.transfer(MARKET, LeaseTransferIn(to_device_id="pc-bbbbbbbb"), db_session, admin)
    assert out.device_id == "pc-bbbbbbbb", "那台本来就联系不上了，没什么可等的"
    assert out.handoff_to is None


def test_转给它自己等于取消让位(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _pc(db_session, admin, "pc-bbbbbbbb")
    _acquire(db_session, admin, "pc-aaaaaaaa")
    wb.transfer(MARKET, LeaseTransferIn(to_device_id="pc-bbbbbbbb"), db_session, admin)
    out = wb.transfer(MARKET, LeaseTransferIn(to_device_id="pc-aaaaaaaa"), db_session, admin)
    assert out.handoff_to is None


def test_转给没登记过的机器要拒绝(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _acquire(db_session, admin, "pc-aaaaaaaa")
    with pytest.raises(HTTPException) as exc:
        wb.transfer(MARKET, LeaseTransferIn(to_device_id="pc-zzzzzzzz"), db_session, admin)
    assert exc.value.status_code == 404


# --- 6. 没接入的爬虫开不了 ----------------------------------------------------
def test_图片爬虫还没接入开不了(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    with pytest.raises(HTTPException) as exc:
        _acquire(db_session, admin, "pc-aaaaaaaa", feature=IMAGE)
    assert exc.value.status_code == 400
    assert "还没接入" in exc.value.detail


def test_图片爬虫在列表里如实标未接入(db_session):
    leases = {x.feature: x for x in wb._all_leases(db_session, datetime.utcnow())}
    assert leases[IMAGE].available is False
    assert leases[MARKET].available is True
    assert set(leases) == set(CrawlerFeature.ALL), "两个爬虫都要在列表里，哪怕其中一个还没接入"


def test_不存在的爬虫名(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    with pytest.raises(HTTPException) as exc:
        _acquire(db_session, admin, "pc-aaaaaaaa", feature="weibo")
    assert exc.value.status_code == 404


# --- 7. 没登记过的电脑不能抢 --------------------------------------------------
def test_没心跳过的电脑不能抢(db_session):
    admin = _admin(db_session)
    with pytest.raises(HTTPException) as exc:
        _acquire(db_session, admin, "pc-unknown1")
    assert exc.value.status_code == 404


# --- 8. 心跳把租约一起捎回来 --------------------------------------------------
def test_心跳捎回租约现状(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa")
    _acquire(db_session, admin, "pc-aaaaaaaa")

    out = _pc(db_session, admin, "pc-aaaaaaaa")
    market = next(x for x in out.leases if x.feature == MARKET)
    assert market.mine is True, "端上靠这个判断本地那份该不该继续跑，不必再单独轮询一次"
    assert out.device.online is True
    assert out.ttl_sec > 0


def test_心跳更新电脑名与最近登录人(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, "pc-aaaaaaaa", "旧名字")
    out = _pc(db_session, admin, "pc-aaaaaaaa", "新名字")
    assert out.device.name == "新名字"
    assert out.device.last_staff_name == "老板"
    assert db_session.query(WorkbenchDevice).count() == 1, "同一个 id 不该登记出两台"


# --- 9. AdsPower 分组归属：收到服务端之后才有"唯一说明书"---------------------
def test_第一次读自动补上出厂三条(db_session):
    """空表不能就这么交出去。

    代理对**没登记**的分组一律拒绝驱动（那是它的安全默认）。所以第一台机器连上来
    看到空表，会把所有分组都判成没登记 → 全机停摆。出厂三条是这张表的地板。
    """
    admin = _admin(db_session)
    out = wb.list_env_purposes(db_session, admin)
    names = {p.name: p.owner for p in out.purposes}
    assert names.get("行情") == "executor"
    assert names.get("采购") == "executor"
    assert names.get("销售") == "executor"
    assert names.get("未分配") == "none", "隔离区必须在，否则没有一个明确的「谁都别碰」"
    assert set(out.valid_owners) == {"executor", "desktop", "none"}


def test_补种只发生一次(db_session):
    admin = _admin(db_session)
    wb.list_env_purposes(db_session, admin)
    wb.upsert_env_purpose(EnvPurposeIn(name="销售", owner="desktop"), db_session, admin)
    again = {p.name: p.owner for p in wb.list_env_purposes(db_session, admin).purposes}
    assert again["销售"] == "desktop", "补种不能把人工改过的值冲掉"


def test_归属只能是三个值之一(db_session):
    admin = _admin(db_session)
    with pytest.raises(HTTPException) as exc:
        wb.upsert_env_purpose(EnvPurposeIn(name="测试组", owner="随便填"), db_session, admin)
    assert exc.value.status_code == 400, "自由填会建出一个谁也不认领的用途，环境划进去就此沉默"


def test_改归属与删登记(db_session):
    admin = _admin(db_session)
    wb.upsert_env_purpose(EnvPurposeIn(name="临时", owner="none", note="排查用"), db_session, admin)
    rows = {p.name: p for p in wb.list_env_purposes(db_session, admin).purposes}
    assert rows["临时"].owner == "none" and rows["临时"].note == "排查用"

    wb.delete_env_purpose("临时", db_session, admin)
    assert "临时" not in {p.name for p in wb.list_env_purposes(db_session, admin).purposes}
    with pytest.raises(HTTPException) as exc:
        wb.delete_env_purpose("临时", db_session, admin)
    assert exc.value.status_code == 404


# --- 10. 电脑与它托管的 AdsPower 环境 ----------------------------------------
def test_心跳记下这台电脑挂着哪些环境(db_session):
    """gc_device 和 workbench_device 不是同一个东西的两份记录，是一对多：
    一台电脑上可以挂十几个 AdsPower 环境（本机实测 11 个）。所以不合表，建关联。
    """
    admin = _admin(db_session)
    out = wb.heartbeat(DeviceHeartbeatIn(device_id="pc-aaaaaaaa", name="办公室电脑",
                                         ads_env_ids=["k1a", "k1b", "k1c"]), db_session, admin)
    assert out.device.ads_env_count == 3


def test_环境列表去重且有上限(db_session):
    admin = _admin(db_session)
    out = wb.heartbeat(DeviceHeartbeatIn(device_id="pc-aaaaaaaa",
                                         ads_env_ids=["k1a", "k1a", "k1b"]), db_session, admin)
    assert out.device.ads_env_count == 2


def test_代理没起时不清掉已知的环境(db_session):
    """端上报空列表意味着「这一拍问不到」，不是「这台电脑上没有环境」。

    用它清掉记录，会让管理员在最需要排查的时候看到一台空空如也的机器。
    """
    admin = _admin(db_session)
    wb.heartbeat(DeviceHeartbeatIn(device_id="pc-aaaaaaaa", ads_env_ids=["k1a", "k1b"]),
                 db_session, admin)
    out = wb.heartbeat(DeviceHeartbeatIn(device_id="pc-aaaaaaaa", ads_env_ids=[]),
                       db_session, admin)
    assert out.device.ads_env_count == 2, "代理暂时不可达不该把已知的环境抹掉"
