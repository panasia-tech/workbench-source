"""行情采集轮次：服务端记「谁跑的、跑得怎么样」，采集本身仍在端上。

# 它解决什么

采集此前完全是本机的事，服务端只收到「决策影子」（每次定价怎么算的），**收不到
轮次**——「昨晚那台电脑到底跑没跑、跑了多久、多少条失败」，只有坐在那台电脑前
的人知道。爬虫租约解决了「谁该跑」，这张表解决「跑得怎么样」。

顺带把手动触发接上：管理员在任意一台登录都能发起一轮，不必跑到那台电脑跟前。

# 这里钉死的

  1. 派单要派给**持有租约的那台**——爬虫本来就只能一台在跑；
  2. 认领要过两道：这轮是派给你的，而且租约**此刻**还在你手上（派单之后租约
     可能已经转走）；
  3. 一台电脑同时只排一轮——采集是独占的，排队只会让人以为多点几次会快；
  4. 上报结果**不校验租约**：跑到一半被转走是常事，结果照样得记下来；
  5. 重复上报不报错——端上重试不该变成错误；
  6. 服务端不可达时端上先跑、事后补登记，标记 offline_started 且直接进 RUNNING。
"""

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.models.workbench import CrawlerFeature, CrawlerLease, CrawlRunStatus, MarketCrawlRun
from app.routers import workbench as wb
from app.schemas.workbench import (
    CrawlRunClaimIn,
    CrawlRunCreateIn,
    CrawlRunFinishIn,
    DeviceHeartbeatIn,
    LeaseActionIn,
)
from app.services.password import hash_password

PC_A = "pc-aaaaaaaa"
PC_B = "pc-bbbbbbbb"


def _admin(db, username="boss"):
    s = Staff(staff_no=f"A-{username}", name="老板", username=username,
              password_hash=hash_password("x"), role=StaffRole.ADMIN,
              status=StaffStatus.ACTIVE)
    db.add(s)
    db.commit()
    return s


def _pc(db, admin, device_id, name="办公室电脑"):
    return wb.heartbeat(DeviceHeartbeatIn(device_id=device_id, name=name), db, admin)


def _hold(db, admin, device_id):
    """让这台电脑拿到行情爬虫租约。"""
    return wb.acquire(CrawlerFeature.MARKET, LeaseActionIn(device_id=device_id), db, admin)


def _create(db, admin, **kw):
    return wb.create_crawl_run(CrawlRunCreateIn(**kw), db, admin)


# --- 1. 派给持有租约的那台 ----------------------------------------------------
def test_不指定就派给租约持有者(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _pc(db_session, admin, PC_B, "家里电脑")
    _hold(db_session, admin, PC_B)

    run = _create(db_session, admin)
    assert run.device_id == PC_B
    assert run.status == CrawlRunStatus.PENDING
    assert run.device_name == "家里电脑"


def test_没人持有爬虫时发不了(db_session):
    """爬虫没开着就派单，那一轮会永远没人认领——不如当场说清楚。"""
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    with pytest.raises(HTTPException) as exc:
        _create(db_session, admin)
    assert exc.value.status_code == 409
    assert "爬虫开关" in exc.value.detail


def test_派给没登记过的电脑要拒绝(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    with pytest.raises(HTTPException) as exc:
        _create(db_session, admin, device_id="pc-zzzzzzzz")
    assert exc.value.status_code == 404


# --- 2. 一台同时只排一轮 ------------------------------------------------------
def test_已经有一轮在排就不再排(db_session):
    """采集是独占的，排队只会让人以为多点几次会跑得快些。"""
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    _create(db_session, admin)
    with pytest.raises(HTTPException) as exc:
        _create(db_session, admin)
    assert exc.value.status_code == 409
    assert "排队" in exc.value.detail


# --- 3. 心跳把待跑的那一轮捎回去 ----------------------------------------------
def test_心跳捎回待跑的一轮(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin)
    out = _pc(db_session, admin, PC_A)
    assert out.pending_crawl_run_id == run.id, "端上靠心跳知道有活，不必再单独轮询一条"


def test_没派活时心跳里是空的(db_session):
    admin = _admin(db_session)
    assert _pc(db_session, admin, PC_A).pending_crawl_run_id is None


# --- 4. 认领要过两道 ----------------------------------------------------------
def test_认领(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin)
    claimed = wb.claim_crawl_run(run.id, CrawlRunClaimIn(device_id=PC_A, local_run_id="local-1"),
                                 db_session, admin)
    assert claimed.status == CrawlRunStatus.RUNNING
    assert claimed.local_run_id == "local-1", "要能从服务端这条对到本机那条历史记录"
    assert claimed.started_at is not None


def test_别人的活认领不了(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _pc(db_session, admin, PC_B)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin)
    with pytest.raises(HTTPException) as exc:
        wb.claim_crawl_run(run.id, CrawlRunClaimIn(device_id=PC_B), db_session, admin)
    assert exc.value.status_code == 409


def test_派单之后租约被转走就不许开跑(db_session):
    """只看「派给谁」不够：派单和开跑之间隔着一次心跳，这中间租约可能已经转走。

    不拦的话两台会一起跑——而那正是租约本身要解决的问题。
    """
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _pc(db_session, admin, PC_B)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin)

    # 租约过期后被第二台接手
    row = db_session.get(CrawlerLease, CrawlerFeature.MARKET)
    row.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()
    _hold(db_session, admin, PC_B)

    with pytest.raises(HTTPException) as exc:
        wb.claim_crawl_run(run.id, CrawlRunClaimIn(device_id=PC_A), db_session, admin)
    assert exc.value.status_code == 409
    assert "不归这台电脑" in exc.value.detail


def test_认领过的不能再认领(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin)
    wb.claim_crawl_run(run.id, CrawlRunClaimIn(device_id=PC_A), db_session, admin)
    with pytest.raises(HTTPException) as exc:
        wb.claim_crawl_run(run.id, CrawlRunClaimIn(device_id=PC_A), db_session, admin)
    assert exc.value.status_code == 409


# --- 5. 上报结果 --------------------------------------------------------------
def _finish(db, admin, run_id, **kw):
    kw.setdefault("device_id", PC_A)
    return wb.finish_crawl_run(run_id, CrawlRunFinishIn(**kw), db, admin)


def test_上报成功(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin)
    wb.claim_crawl_run(run.id, CrawlRunClaimIn(device_id=PC_A), db_session, admin)
    out = _finish(db_session, admin, run.id, ok=True, total=30, success=28, failed=2)
    assert out.status == CrawlRunStatus.SUCCESS
    assert (out.total, out.success, out.failed) == (30, 28, 2)
    assert out.finished_at is not None


def test_跑到一半租约被转走结果照样收(db_session):
    """管理员改主意把爬虫转走，这一轮的结果不该跟着丢——丢了等于白跑还查不到。"""
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _pc(db_session, admin, PC_B)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin)
    wb.claim_crawl_run(run.id, CrawlRunClaimIn(device_id=PC_A), db_session, admin)

    db_session.delete(db_session.get(CrawlerLease, CrawlerFeature.MARKET))
    db_session.commit()
    _hold(db_session, admin, PC_B)

    out = _finish(db_session, admin, run.id, ok=True, total=10, success=10)
    assert out.status == CrawlRunStatus.SUCCESS


def test_重复上报不报错(db_session):
    """端上网络抖一下会重试。第二次该安静返回，不是 409。"""
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin)
    wb.claim_crawl_run(run.id, CrawlRunClaimIn(device_id=PC_A), db_session, admin)
    first = _finish(db_session, admin, run.id, ok=True, total=5, success=5)
    again = _finish(db_session, admin, run.id, ok=False, total=999, failed=999)
    assert again.status == first.status == CrawlRunStatus.SUCCESS
    assert again.total == 5, "第一次的结果是准的，重试不该把它覆盖掉"


def test_别人的活报不了(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _pc(db_session, admin, PC_B)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin)
    with pytest.raises(HTTPException) as exc:
        _finish(db_session, admin, run.id, device_id=PC_B, ok=True)
    assert exc.value.status_code == 409


# --- 6. 离线先跑、事后补登记 --------------------------------------------------
def test_离线跑的直接进运行中(db_session):
    """服务端不可达时端上照跑——采集是本机能力，不该因为网抖就停。

    跑完补登记时它已经在跑（甚至跑完了），不该再等人认领。
    """
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin, trigger="schedule", offline_started=True, local_run_id="local-9")
    assert run.status == CrawlRunStatus.RUNNING
    assert run.offline_started is True
    assert run.started_at is not None
    out = _finish(db_session, admin, run.id, ok=True, total=12, success=12)
    assert out.status == CrawlRunStatus.SUCCESS


def test_最近几轮按时间倒序(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    ids = []
    for _ in range(3):
        r = _create(db_session, admin, offline_started=True)
        _finish(db_session, admin, r.id, ok=True)
        ids.append(r.id)
    got = [r.id for r in wb.list_crawl_runs(20, db_session, admin).runs]
    assert got[: len(ids)] == list(reversed(ids))


# --- 7. 失败要分类 ------------------------------------------------------------
def test_三类失败分开记(db_session):
    """只报一个「失败 12 条」等于让看的人再去那台电脑上翻一遍。

    三类要采取的动作完全不同：搜不到是改任务，价格读不出多半是闲鱼改版，
    撞风控是停手等冷却——**绝不是重试**。
    """
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin, offline_started=True)
    out = _finish(db_session, admin, run.id, ok=False, total=20, success=8, failed=12,
                  empty=5, invalid_price=3, risk_control=4)
    assert (out.empty, out.invalid_price, out.risk_control) == (5, 3, 4)
    assert out.failed == 12


def test_不报分类时是零不是空(db_session):
    """老版本客户端不送这三个字段。它们该是 0，不能是 null——
    界面上 `v-if="row.risk_control"` 遇到 null 会静默不显示，看着像「没撞风控」。"""
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin, offline_started=True)
    out = _finish(db_session, admin, run.id, ok=True, total=3, success=3)
    assert (out.empty, out.invalid_price, out.risk_control) == (0, 0, 0)


# --- 8. 按需取回现场 ----------------------------------------------------------
# 快照是整页 DOM，一轮最多十几份，全量传是 GB 级的量而绝大多数永远没人看。
# 所以默认不传、要看再取；而「要看」的时候那台电脑常常恰好不在线，
# 于是做成待办挂在心跳上：在线立刻传，不在线下次开机补传。
from app.models.workbench import CrawlSnapshotRequest, SnapshotRequestStatus  # noqa: E402


def _done_run(db, admin, **kw):
    _pc(db, admin, PC_A)
    _hold(db, admin, PC_A)
    run = _create(db, admin, offline_started=True, local_run_id="local-7")
    _finish(db, admin, run.id, ok=False, total=10, success=4, failed=6, **kw)
    return run


def test_取回现场排成待办(db_session):
    admin = _admin(db_session)
    run = _done_run(db_session, admin)
    req = wb.request_snapshot(run.id, db_session, admin)
    assert req.status == SnapshotRequestStatus.PENDING
    assert req.device_id == PC_A
    # 端上要靠 local_run_id 去本机找对应的快照文件
    assert db_session.get(CrawlSnapshotRequest, req.id).local_run_id == "local-7"


def test_心跳捎回取回待办(db_session):
    admin = _admin(db_session)
    run = _done_run(db_session, admin)
    wb.request_snapshot(run.id, db_session, admin)
    out = _pc(db_session, admin, PC_A)
    assert out.pending_snapshot_request["run_id"] == run.id
    assert out.pending_snapshot_request["local_run_id"] == "local-7"


def test_同一轮重复点不再排队(db_session):
    """现场是确定的东西，取一次就够。重复请求只会让那台电脑反复打包上传同一批文件。"""
    admin = _admin(db_session)
    run = _done_run(db_session, admin)
    first = wb.request_snapshot(run.id, db_session, admin)
    again = wb.request_snapshot(run.id, db_session, admin)
    assert again.id == first.id
    assert db_session.query(CrawlSnapshotRequest).count() == 1


def test_端上说找不到就取消掉(db_session):
    """快照只留 30 天，而且是本机文件——过了期、或者这一轮在别的电脑上跑的，就找不到。

    不回话的话这条待办永远 PENDING：端上每拍心跳都收到它、每次都失败，
    而点过按钮的人一直在等一个不会来的东西。
    """
    admin = _admin(db_session)
    run = _done_run(db_session, admin)
    req = wb.request_snapshot(run.id, db_session, admin)
    wb.fail_snapshot(req.id, {"device_id": PC_A, "reason": "已过 30 天保留期"}, db_session, admin)

    row = db_session.get(CrawlSnapshotRequest, req.id)
    assert row.status == SnapshotRequestStatus.CANCELLED
    assert "30 天" in row.reason
    # 取消之后心跳里不该再出现它，否则端上会一直收到一条办不了的活
    assert _pc(db_session, admin, PC_A).pending_snapshot_request is None


def test_取消掉的也要在列表里看得见(db_session):
    """界面上得显示「取不到」，否则会一直显示「取回现场」，人会反复点。"""
    admin = _admin(db_session)
    run = _done_run(db_session, admin)
    req = wb.request_snapshot(run.id, db_session, admin)
    wb.fail_snapshot(req.id, {"device_id": PC_A, "reason": "本机没有这一轮的快照"}, db_session, admin)
    listed = next(r for r in wb.list_crawl_runs(20, db_session, admin).runs if r.id == run.id)
    assert listed.snapshot is not None
    assert listed.snapshot["status"] == SnapshotRequestStatus.CANCELLED


def test_别人的待办回不了话(db_session):
    admin = _admin(db_session)
    run = _done_run(db_session, admin)
    _pc(db_session, admin, PC_B)
    req = wb.request_snapshot(run.id, db_session, admin)
    with pytest.raises(HTTPException) as exc:
        wb.fail_snapshot(req.id, {"device_id": PC_B, "reason": "x"}, db_session, admin)
    assert exc.value.status_code == 409


def test_没记设备的轮次取不了(db_session):
    admin = _admin(db_session)
    _pc(db_session, admin, PC_A)
    _hold(db_session, admin, PC_A)
    run = _create(db_session, admin, offline_started=True)
    db_session.get(MarketCrawlRun, run.id).device_id = None
    db_session.commit()
    with pytest.raises(HTTPException) as exc:
        wb.request_snapshot(run.id, db_session, admin)
    assert exc.value.status_code == 409
