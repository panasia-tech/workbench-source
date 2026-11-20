"""行情采集影子模式（S3-0）：本机报决策，服务端只记录不指挥。

# 它存在的唯一理由

S3-1 要把行情的调度决策搬到服务端。搬之前必须有一个**对照基准**——否则搬完只能说
「好像还行」，出了问题也分不清是新调度的锅还是本来就这样。影子模式就是那个基准：
本机照常自己决定，但每一次决策都报上来。

# 这里钉死的

  1. **skip 也要记**。「为什么没跑」和「跑了什么」一样是决策，而迁移后最容易出偏差的
     恰恰是这半边（新调度多跳了一批，不记就看不出来）。skip 记成 CANCELLED——
     它不是成功也不是失败。
  2. **影子任务绝不能被派发出去**。它们是已经发生过的事的记录，不是待办；
     task_type 不在 FLOWS 里、状态是终态，两道都得成立。
  3. **失败归因复用 failed_step**，不新造字段——服务端已有的排障口径要能直接用上。
  4. 汇总要能答出 S3-0 的完成判据三问：跑了几轮、哪个账号失败最多、失败在哪一步。
"""
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from app import api
from app.flow.runner import FLOWS
from app.models import (Account, AccountStatus, Job, JobType, MarketAccountConfig,
                        RiskState, Task, TaskStatus)
from app.schemas import MarketDecisionIn, MarketRoundIn


def _round(account="演示业务负责人", client="desktop-1", trigger="daily", decisions=None):
    return MarketRoundIn(
        client_id=client, account=account, trigger=trigger,
        # 用 is None 判断而不是 `or`：空列表是**有意传的**，不是"没传"
        decisions=decisions if decisions is not None else [
            MarketDecisionIn(spu="AOC 24G10", action="run", ok=True, price=780,
                             waited_ms=1800, duration_ms=12000),
            MarketDecisionIn(spu="KTC 27GS820", action="skip", reason="账号今日配额已满"),
            MarketDecisionIn(spu="飞利浦 27M2N", action="run", ok=False,
                             failed_step="search", reason="风控暂停"),
        ])


def test_一轮落成一个job与逐条task(db):
    out = api.report_market_round(_round(), db)
    assert out["tasks"] == 3

    job = db.get(Job, out["job_id"])
    assert job.job_type == JobType.MARKET_CRAWL
    assert job.source == "LOCAL_SHADOW", "要和 SCHED/ERP/MANUAL 分得开，一眼看出是影子产物"
    assert job.total == 3 and job.succeeded == 1
    # 失败 + 跳过都计入 failed 侧的聚合（_aggregate_job 的既有口径）
    assert job.failed == 2

    tasks = {t.ref_id: t for t in db.query(Task).filter(Task.job_id == job.id)}
    assert tasks["AOC 24G10"].status == TaskStatus.SUCCESS
    assert tasks["AOC 24G10"].result["price"] == 780
    assert tasks["AOC 24G10"].result["waited_ms"] == 1800, "等了多久是迁移后要对比的关键项"
    assert tasks["飞利浦 27M2N"].status == TaskStatus.FAILED
    assert tasks["飞利浦 27M2N"].failed_step == "search"
    assert tasks["飞利浦 27M2N"].error == "风控暂停"


def test_跳过的也要记且不算失败(db):
    out = api.report_market_round(_round(), db)
    skipped = db.query(Task).filter(Task.job_id == out["job_id"],
                                    Task.ref_id == "KTC 27GS820").one()
    assert skipped.status == TaskStatus.CANCELLED, "跳过不是失败，也不是成功"
    assert skipped.error == "账号今日配额已满", "为什么没跑，比跑了什么更容易在迁移后出偏差"
    assert skipped.result["action"] == "skip"


def test_影子任务不会被派发(db):
    """两道都要成立：类型不在 FLOWS 里，且落库即终态。"""
    assert "market_crawl" not in FLOWS, \
        "一旦进了 FLOWS，调度器就会把这些「已经发生过的事」当成待办再派一遍"
    out = api.report_market_round(_round(), db)
    rows = db.query(Task).filter(Task.job_id == out["job_id"]).all()
    assert all(t.status in (TaskStatus.SUCCESS, TaskStatus.FAILED, TaskStatus.CANCELLED)
               for t in rows), "影子任务不该有 PENDING —— 那会被派发循环捞走"


def test_认得出账号就挂到账号上(db):
    acc = Account(nick="演示业务负责人", status=AccountStatus.ACTIVE, risk_state=RiskState.NORMAL)
    db.add(acc)
    db.commit()

    out = api.report_market_round(_round(account="演示业务负责人"), db)
    job = db.get(Job, out["job_id"])
    assert job.ref_id == acc.id, "能对上账号就挂 id，后面才能和配额、风控态关联起来"
    task = db.query(Task).filter(Task.job_id == job.id).first()
    assert task.account_id == acc.id

    # 对不上也不能丢：机器上可能有服务端还不认识的账号
    other = api.report_market_round(_round(account="查无此号"), db)
    assert db.get(Job, other["job_id"]).ref_id == "查无此号"


def test_空轮次直接拒(db):
    with pytest.raises(HTTPException) as exc:
        api.report_market_round(_round(decisions=[]), db)
    assert exc.value.status_code == 400


def test_汇总能答出完成判据三问(db):
    api.report_market_round(_round(account="演示业务负责人"), db)
    api.report_market_round(_round(account="演示员工辛", decisions=[
        MarketDecisionIn(spu="A", action="run", ok=False, failed_step="search", reason="风控"),
        MarketDecisionIn(spu="B", action="run", ok=False, failed_step="parse", reason="页面变了"),
        MarketDecisionIn(spu="C", action="run", ok=True, price=100),
    ]), db)

    s = api.market_rounds(days=1, db=db)
    assert s["rounds"] == 2, "跑了几轮"
    assert s["by_account"]["演示员工辛"]["failed"] == 2, "哪个账号失败最多"
    assert s["by_account"]["演示业务负责人"]["skipped"] == 1
    assert s["failed_by_step"]["search"] == 2, "失败在哪一步"
    assert list(s["failed_by_step"])[0] == "search", "按次数排序，最多的排前面"
    assert len(s["latest"]) == 2


def test_汇总只看时间窗内的(db):
    out = api.report_market_round(_round(), db)
    job = db.get(Job, out["job_id"])
    job.created_at = datetime.utcnow() - timedelta(days=5)
    db.commit()

    assert api.market_rounds(days=1, db=db)["rounds"] == 0
    assert api.market_rounds(days=7, db=db)["rounds"] == 1


# ---------------------------------------------------------------------------
# 节奏参数上行（S3-0 最后一项）
#
# 本机仍按自己那套节奏跑，只是把**实际在用的值**报上来。服务端只存不发——
# 这半步的意义全在 S3-1：决策权搬过去之后要能回答「新调度是不是比原来跑得慢了」，
# 而那个问题没有搬家前的同口径数据就只能凭感觉答。
# ---------------------------------------------------------------------------

_RHYTHM = {"throttle_min_ms": 15000, "throttle_max_ms": 30000,
           "query_delay_min_ms": 8000, "query_delay_max_ms": 14000,
           "daily_enabled": True, "daily_time": "09:30"}


def _round_with_rhythm(account="演示业务负责人", rhythm=_RHYTHM, client="desktop-1"):
    r = _round(account=account, client=client)
    return MarketRoundIn(**{**r.model_dump(), "rhythm": rhythm})


def test_节奏跟着轮次一起存下来(db):
    """存两处，各有各的用处：配置表答「现在是什么样」，轮次答「当时是什么样」。"""
    out = api.report_market_round(_round_with_rhythm(), db)

    job = db.get(Job, out["job_id"])
    assert job.spec["rhythm"]["throttle_min_ms"] == 15000, \
        "节奏必须记在轮次上——参数改过之后，只有这份还能把结果和当时的节奏对上号"
    assert job.spec["client_id"] == "desktop-1"

    row = db.get(MarketAccountConfig, "演示业务负责人")
    assert row.throttle_max_ms == 30000 and row.daily_time == "09:30"
    assert row.source == "LOCAL_REPORT", "要一眼看出这是本机报的，不是服务端发的"


def test_再报一次就地更新不另起一行(db):
    api.report_market_round(_round_with_rhythm(), db)
    api.report_market_round(_round_with_rhythm(
        rhythm={**_RHYTHM, "throttle_min_ms": 25000}), db)

    rows = db.query(MarketAccountConfig).all()
    assert len(rows) == 1 and rows[0].throttle_min_ms == 25000


def test_不报节奏也不影响轮次落库(db):
    """节奏是附带的观测项。旧版本的端上没有它，不能因此把整轮丢掉。"""
    out = api.report_market_round(_round(), db)
    assert out["tasks"] == 3
    assert db.get(Job, out["job_id"]).spec["rhythm"] is None
    assert db.query(MarketAccountConfig).count() == 0


def test_min_比_max_大也照收(db):
    """反了的参数**本身就是要看见的现象**，不该被观测通道悄悄吞掉。"""
    out = api.report_market_round(_round_with_rhythm(
        rhythm={**_RHYTHM, "throttle_min_ms": 30000, "throttle_max_ms": 15000}), db)
    assert out["tasks"] == 3
    row = db.get(MarketAccountConfig, "演示业务负责人")
    assert (row.throttle_min_ms, row.throttle_max_ms) == (30000, 15000)


def test_配置接口只读且没有写的那一半(db):
    """S3-0 阶段服务端**不能**改本机节奏：决策权还在本机，能改就成了半路指挥。"""
    api.report_market_round(_round_with_rhythm(account="演示员工辛"), db)
    out = api.market_config(db=db)
    assert out["writable"] is False
    assert out["accounts"][0]["account"] == "演示员工辛"
    assert out["accounts"][0]["source"] == "LOCAL_REPORT"

    writes = [
        (r.path, m) for r in api.router.routes
        for m in getattr(r, "methods", set())
        if "market/config" in getattr(r, "path", "") and m not in ("GET", "HEAD")
    ]
    assert not writes, f"S3-0 不该有下发节奏的接口，却发现了 {writes}"
