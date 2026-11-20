"""链接焕新:在架满 N 天没卖掉的链接删掉、同一账号重发(老板 2026-10-13 定:7 天)。

ERP 每天定时拉 refresh_candidates → 逐条给新鲜发布内容 → create_refresh_listing;
群控先删(goods_delete)后发(goods_publish),账本行原地换上新链接。这里钉住:
- 什么时候不做(状态/账号/在途/额度/买家在聊),内容不合格一条都不删;
- 删成功才建重发,重发插队;途中货卖了/下架了就收手,已经发上去的马上撤回;
  下架只下了别的号(ERP「下架所选店铺」)不算,这个号的焕新照常;
- 重发失败留在 PENDING_REPUBLISH 第二天直接重发,点过「发布」的转 UNCERTAIN 绝不再发;
- 网页版删除流程:只认 item_id、「被删掉了」页不把推荐流里的「申诉」当风控。
"""
from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy.orm import sessionmaker

import app.scheduler as sched_mod
from app import jobs, notify
from app.config import settings
from app.flow import runner
from app.flow.web import goods_flows_web as gfw
from app.models import (
    REFRESH_TASK_SOURCE,
    REFRESH_UNDO_SOURCE,
    Account,
    AccountStatus,
    Conversation,
    Device,
    DeviceStatus,
    Job,
    JobStatus,
    JobType,
    Listing,
    ListingStatus,
    RiskState,
    Task,
    TaskStatus,
)
from app.scheduler import Scheduler

NOW = datetime.utcnow()
SPEC = {"images": ["https://oss.example.com/sku/product/a.jpg?Expires=1"], "price": 520,
        "description": "【AOC 27寸显示器】成色如图", "shipping": {"mode": "free"},
        "confirm_publish": True}


# ---------------------------------------------------------------- 夹具
def _acc(db, *, kind="browser", status=AccountStatus.ACTIVE, risk=RiskState.NORMAL, quota=30):
    dev = Device(name=f"d-{uuid4().hex[:6]}", kind=kind, status=DeviceStatus.ONLINE)
    db.add(dev)
    db.flush()
    acc = Account(nick=f"a-{uuid4().hex[:8]}", device_id=dev.id, status=status, risk_state=risk,
                  daily_publish_quota=quota, active_window="00:00-23:59")
    db.add(acc)
    db.flush()
    return acc


def _live(db, acc, *, sku=None, age_days=8, item_id="1001", title="【AOC 27寸显示器】成色如图",
          status=ListingStatus.LIVE, price=520):
    lst = Listing(sku=sku or f"SKU-{uuid4().hex[:6]}", account_id=acc.id, item_id=item_id,
                  title=title, status=status, price=price,
                  published_at=NOW - timedelta(days=age_days))
    db.add(lst)
    db.commit()
    return lst


def _tasks(db, job_id):
    return db.query(Task).filter(Task.job_id == job_id).order_by(Task.created_at).all()


def _finish(db, task, *, ok=True, result=None, error=None):
    """模拟 runner._apply_result 写回 + on_task_result 记账(同一会话里直接调)。"""
    task.status = TaskStatus.SUCCESS if ok else TaskStatus.FAILED
    task.result = result or {"ok": ok}
    task.error = error
    task.finished_at = datetime.utcnow()
    db.commit()


@pytest.fixture
def bound(db_session, monkeypatch):
    """on_task_result 自开 SessionLocal:指到同一内存库,走真实入口。"""
    monkeypatch.setattr(jobs, "SessionLocal",
                        sessionmaker(bind=db_session.get_bind(), autoflush=False, autocommit=False))
    return db_session


def _result(db, task, **kw):
    _finish(db, task, **kw)
    jobs.on_task_result(task.id, kw.get("ok", True))
    db.expire_all()


# ---------------------------------------------------------------- 开单
def test_live_listing_starts_with_delete(db):
    acc = _acc(db)
    lst = _live(db, acc)
    job = jobs.create_refresh_listing(db, lst.id, SPEC, source="ERP")
    assert job.job_type == JobType.REFRESH_LISTING
    assert (job.ref_type, job.ref_id) == ("listing", lst.id)
    (t,) = _tasks(db, job.id)
    assert t.task_type == "goods_delete"
    assert t.source == REFRESH_TASK_SOURCE
    assert t.spec["item_id"] == "1001" and t.spec["listing_id"] == lst.id
    assert job.total == 1


def test_already_deleted_listing_goes_straight_to_republish(db):
    acc = _acc(db)
    lst = _live(db, acc, status=ListingStatus.PENDING_REPUBLISH)
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (t,) = _tasks(db, job.id)
    assert t.task_type == "goods_publish"
    assert t.spec["refresh_listing_id"] == lst.id
    assert t.spec["images"] == SPEC["images"]


@pytest.mark.parametrize("bad", [{"confirm_publish": False}, {"dry_run": True}])
def test_fill_only_spec_is_refused(db, bad):
    """只填不发的内容拿来焕新 = 只删不发。"""
    lst = _live(db, _acc(db))
    with pytest.raises(ValueError, match="真发"):
        jobs.create_refresh_listing(db, lst.id, {**SPEC, **bad})
    assert db.query(Task).count() == 0


def test_bad_spec_rejected_before_anything_is_deleted(db):
    acc = _acc(db)
    lst = _live(db, acc)
    with pytest.raises(ValueError) as e:
        jobs.create_refresh_listing(db, lst.id, {**SPEC, "images": []})
    assert not isinstance(e.value, jobs.RefreshRejected)   # 400 而不是 409
    assert db.query(Task).count() == 0


@pytest.mark.parametrize("setup, why", [
    (lambda db: _live(db, _acc(db, kind="android")), "浏览器"),
    (lambda db: _live(db, _acc(db, status=AccountStatus.FROZEN)), "冻结"),
    (lambda db: _live(db, _acc(db, risk=RiskState.FROZEN)), "冻结"),
    (lambda db: _live(db, _acc(db), item_id=None), "商品 id"),
    (lambda db: _live(db, _acc(db), status=ListingStatus.SOLD), "SOLD"),
    (lambda db: _live(db, _acc(db), status=ListingStatus.UNCERTAIN), "UNCERTAIN"),
])
def test_rejections(db, setup, why):
    lst = setup(db)
    with pytest.raises(jobs.RefreshRejected) as e:
        jobs.create_refresh_listing(db, lst.id, SPEC)
    assert why in str(e.value)
    assert db.query(Job).filter(Job.job_type == JobType.REFRESH_LISTING).count() == 0


def test_rejected_while_another_task_touches_the_listing(db):
    acc = _acc(db)
    lst = _live(db, acc)
    db.add(Task(task_type="goods_delist", account_id=acc.id, ref_id=lst.sku,
                status=TaskStatus.RUNNING, spec={}))
    db.commit()
    with pytest.raises(jobs.RefreshRejected, match="任务在跑"):
        jobs.create_refresh_listing(db, lst.id, SPEC)


def test_daily_cap_per_account(db, monkeypatch):
    monkeypatch.setattr(settings, "listing_refresh_per_account_daily", 2)
    acc = _acc(db)
    a, b, c = (_live(db, acc) for _ in range(3))
    jobs.create_refresh_listing(db, a.id, SPEC)
    jobs.create_refresh_listing(db, b.id, SPEC)
    assert jobs.refresh_room(db, acc) == 0
    with pytest.raises(jobs.RefreshRejected, match="额度"):
        jobs.create_refresh_listing(db, c.id, SPEC)


def test_room_leaves_the_publish_quota_alone(db, monkeypatch):
    """重发也占日发布配额:今天已发 + 在途发布 + 在途焕新删除 都算进去,删了必须发得出去。"""
    monkeypatch.setattr(settings, "listing_refresh_per_account_daily", 10)
    acc = _acc(db, quota=5)
    for _ in range(3):
        db.add(Task(task_type="goods_publish", account_id=acc.id, ref_id="X",
                    status=TaskStatus.SUCCESS, finished_at=datetime.utcnow(), spec={}))
    db.add(Task(task_type="goods_publish", account_id=acc.id, ref_id="Y",
                status=TaskStatus.PENDING, spec={}))
    db.commit()
    assert jobs.refresh_room(db, acc) == 1
    jobs.create_refresh_listing(db, _live(db, acc).id, SPEC)   # 删除在途,也占一格
    assert jobs.refresh_room(db, acc) == 0


def test_yesterdays_publishes_do_not_count(db):
    acc = _acc(db, quota=2)
    for _ in range(2):
        db.add(Task(task_type="goods_publish", account_id=acc.id, ref_id="X",
                    status=TaskStatus.SUCCESS, finished_at=datetime.utcnow() - timedelta(days=1),
                    spec={}))
    db.commit()
    assert jobs.refresh_room(db, acc) == 2


# ---------------------------------------------------------------- 删 → 发
def test_full_cycle_replaces_the_link_in_place(bound):
    db = bound
    acc = _acc(db)
    lst = _live(db, acc, age_days=9)
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (delete,) = _tasks(db, job.id)
    _result(db, delete, ok=True, result={"ok": True, "item_id": "1001"})

    lst = db.get(Listing, lst.id)
    assert lst.status == ListingStatus.PENDING_REPUBLISH   # 旧的删了,仍占位
    delete, publish = _tasks(db, job.id)
    assert publish.task_type == "goods_publish" and publish.source == REFRESH_TASK_SOURCE
    assert publish.spec["refresh_listing_id"] == lst.id and publish.spec["price"] == 520
    assert db.get(Job, job.id).total == 2

    _result(db, publish, ok=True,
            result={"ok": True, "item_id": "2002", "title": "【AOC 27寸显示器】成色如图 新"})
    lst = db.get(Listing, lst.id)
    assert lst.status == ListingStatus.LIVE
    assert lst.item_id == "2002"
    assert lst.title == "【AOC 27寸显示器】成色如图 新"
    assert lst.published_at > NOW - timedelta(minutes=1)   # 上架时间从现在重算
    assert lst.job_id == job.id                              # 图从这单焕新的 spec 取
    assert db.query(Listing).count() == 1                    # 原地换,不另起一行
    assert db.get(Job, job.id).status == JobStatus.DONE


def test_delete_failure_leaves_the_old_link_alone(bound):
    db = bound
    acc = _acc(db)
    lst = _live(db, acc)
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (delete,) = _tasks(db, job.id)
    _result(db, delete, ok=False, result={"ok": False, "failed_step": "delete"}, error="没找到删除按钮")
    assert db.get(Listing, lst.id).status == ListingStatus.LIVE
    assert len(_tasks(db, job.id)) == 1
    assert db.get(Job, job.id).status == JobStatus.FAILED


def test_sold_while_deleting_keeps_sold(bound):
    db = bound
    acc = _acc(db)
    lst = _live(db, acc)
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (delete,) = _tasks(db, job.id)
    lst.status = ListingStatus.SOLD          # 删的同时 chat_scan 检出售出
    db.commit()
    _result(db, delete, ok=True)
    assert db.get(Listing, lst.id).status == ListingStatus.SOLD
    assert len(_tasks(db, job.id)) == 1


def test_sibling_sold_mid_refresh_stops_the_republish(bound):
    db = bound
    acc, other = _acc(db), _acc(db)
    lst = _live(db, acc, sku="SKU-A")
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    sib = _live(db, other, sku="SKU-A", item_id="9")
    sib.status = ListingStatus.SOLD
    sib.last_synced_at = datetime.utcnow()
    db.commit()
    (delete,) = _tasks(db, job.id)
    _result(db, delete, ok=True)
    assert db.get(Listing, lst.id).status == ListingStatus.DELETED
    assert len(_tasks(db, job.id)) == 1


def test_old_sold_record_does_not_block(bound):
    """退货回库的货:很久以前那条 SOLD 账本不该挡住焕新(在不在库归 ERP 判)。"""
    db = bound
    acc, other = _acc(db), _acc(db)
    old = _live(db, other, sku="SKU-R", item_id="7", status=ListingStatus.SOLD)
    old.last_synced_at = NOW - timedelta(days=30)
    lst = _live(db, acc, sku="SKU-R")
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (delete,) = _tasks(db, job.id)
    _result(db, delete, ok=True)
    assert db.get(Listing, lst.id).status == ListingStatus.PENDING_REPUBLISH
    assert len(_tasks(db, job.id)) == 2


# ---------------------------------------------------------------- 途中下架
def test_delist_mid_refresh_marks_deleted_and_cancels_pending(bound):
    db = bound
    acc = _acc(db)
    gone = _live(db, acc, sku="SKU-D", status=ListingStatus.PENDING_REPUBLISH)
    job = jobs.create_refresh_listing(db, gone.id, SPEC)      # 重发在排队
    (publish,) = _tasks(db, job.id)

    delist = jobs.create_delist_sku(db, "SKU-D")
    db.expire_all()
    assert db.get(Listing, gone.id).status == ListingStatus.DELETED
    assert db.get(Task, publish.id).status == TaskStatus.CANCELLED
    assert db.get(Job, job.id).status == JobStatus.FAILED
    assert delist.total == 0          # 闲鱼上已经没有它,不用派下架


def test_delist_cancels_a_queued_delete_and_delists_instead(bound):
    db = bound
    acc = _acc(db)
    lst = _live(db, acc, sku="SKU-Q")
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (delete,) = _tasks(db, job.id)
    delist = jobs.create_delist_sku(db, "SKU-Q")
    db.expire_all()
    assert db.get(Task, delete.id).status == TaskStatus.CANCELLED
    assert [t.task_type for t in _tasks(db, delist.id)] == ["goods_delist"]


def test_republish_landing_after_delist_is_undone(bound):
    """重发在跑的时候货被下架了:发上去的新链接马上删掉,删完记 DELETED、不再发。"""
    db = bound
    acc = _acc(db)
    lst = _live(db, acc, sku="SKU-U", status=ListingStatus.PENDING_REPUBLISH)
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (publish,) = _tasks(db, job.id)
    publish.status = TaskStatus.RUNNING          # 已经在跑,拦不住
    db.commit()
    jobs.create_delist_sku(db, "SKU-U")
    db.expire_all()
    assert db.get(Task, publish.id).status == TaskStatus.RUNNING

    _result(db, db.get(Task, publish.id), ok=True,
            result={"ok": True, "item_id": "3003", "title": "【AOC 27寸显示器】成色如图"})
    lst = db.get(Listing, lst.id)
    assert lst.status == ListingStatus.LIVE and lst.item_id == "3003"   # 如实记:它挂上去了
    undo = [t for t in _tasks(db, job.id) if t.source == REFRESH_UNDO_SOURCE]
    assert len(undo) == 1 and undo[0].task_type == "goods_delete"
    assert undo[0].spec["item_id"] == "3003"

    jobs.create_delist_sku(db, "SKU-U")          # 再来一单下架也取消不了撤回
    db.expire_all()
    assert db.get(Task, undo[0].id).status == TaskStatus.PENDING

    _result(db, db.get(Task, undo[0].id), ok=True)
    assert db.get(Listing, lst.id).status == ListingStatus.DELETED
    assert all(t.task_type != "goods_publish" or t.id == publish.id for t in _tasks(db, job.id))


# ---------------------------------------------------------------- 只下所选账号(ERP「下架所选店铺」)
def test_delist_selected_accounts_only_fans_out_to_them(db):
    a, b = _acc(db), _acc(db)
    la = _live(db, a, sku="SKU-S", item_id="11")
    _live(db, b, sku="SKU-S", item_id="22")
    job = jobs.create_delist_sku(db, "SKU-S", account_ids=[a.id])
    (t,) = _tasks(db, job.id)
    assert (t.task_type, t.account_id, t.spec["listing_id"]) == ("goods_delist", a.id, la.id)
    assert job.total == 1
    assert job.spec == {"account_ids": [a.id]}     # 焕新靠它判断这单下架管不管自己那个号


def test_delist_without_accounts_still_hits_every_account(db):
    # 不传账号 = 全账号(ERP 售出后全网下架走这条),和以前一样
    a, b = _acc(db), _acc(db)
    _live(db, a, sku="SKU-S", item_id="11")
    _live(db, b, sku="SKU-S", item_id="22")
    job = jobs.create_delist_sku(db, "SKU-S")
    assert {t.account_id for t in _tasks(db, job.id)} == {a.id, b.id}
    assert job.total == 2 and job.spec is None


def test_selected_delist_leaves_other_accounts_refresh_alone(bound):
    # 只下 a:b 上删完等重发的那条照常重发,不被记成 DELETED、重发任务不被取消
    db = bound
    a, b = _acc(db), _acc(db)
    _live(db, a, sku="SKU-T", item_id="11")
    gone_b = _live(db, b, sku="SKU-T", item_id="22", status=ListingStatus.PENDING_REPUBLISH)
    job = jobs.create_refresh_listing(db, gone_b.id, SPEC)
    (publish,) = _tasks(db, job.id)

    jobs.create_delist_sku(db, "SKU-T", account_ids=[a.id])
    db.expire_all()
    assert db.get(Listing, gone_b.id).status == ListingStatus.PENDING_REPUBLISH
    assert db.get(Task, publish.id).status == TaskStatus.PENDING


def test_selected_delist_lets_other_accounts_refresh_finish(bound):
    # b 正在焕新(删的、发的都在跑)时只下了 a:b 删完照常重发,发上去的新链接留着、不撤回
    db = bound
    a, b = _acc(db), _acc(db)
    _live(db, a, sku="SKU-V", item_id="11")
    lst_b = _live(db, b, sku="SKU-V", item_id="22")
    job = jobs.create_refresh_listing(db, lst_b.id, SPEC)
    (delete,) = _tasks(db, job.id)
    delete.status = TaskStatus.RUNNING
    db.commit()

    jobs.create_delist_sku(db, "SKU-V", account_ids=[a.id])
    _result(db, db.get(Task, delete.id), ok=True)
    assert db.get(Listing, lst_b.id).status == ListingStatus.PENDING_REPUBLISH
    publish = _tasks(db, job.id)[1]
    _result(db, publish, ok=True,
            result={"ok": True, "item_id": "3003", "title": "【AOC 27寸显示器】成色如图"})
    assert db.get(Listing, lst_b.id).status == ListingStatus.LIVE
    assert not [t for t in _tasks(db, job.id) if t.source == REFRESH_UNDO_SOURCE]


def test_selected_delist_of_this_account_still_stops_its_refresh(bound):
    # 下的就是这个号:删完照旧收手、不再重发(和全账号下架一样)
    db = bound
    acc = _acc(db)
    lst = _live(db, acc, sku="SKU-W")
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (delete,) = _tasks(db, job.id)
    delete.status = TaskStatus.RUNNING
    db.commit()

    jobs.create_delist_sku(db, "SKU-W", account_ids=[acc.id])
    _result(db, db.get(Task, delete.id), ok=True)
    assert db.get(Listing, lst.id).status == ListingStatus.DELETED
    assert len(_tasks(db, job.id)) == 1


def test_api_delist_passes_accounts_through(db):
    from app.api import create_job
    from app.schemas import JobCreate
    a, b = _acc(db), _acc(db)
    _live(db, a, sku="SKU-P", item_id="11")
    _live(db, b, sku="SKU-P", item_id="22")
    job = create_job(JobCreate(job_type="delist_sku", sku="SKU-P", source="ERP", account_ids=[b.id]), db)
    assert [t.account_id for t in _tasks(db, job.id)] == [b.id]


def test_api_delist_rejects_empty_account_list(db):
    # 空列表 ≠ 不传:不传是全账号,空列表多半是调用方算错了——拒掉,别建空作业,更别当成全账号
    from fastapi import HTTPException
    from app.api import create_job
    from app.schemas import JobCreate
    _live(db, _acc(db), sku="SKU-E")
    with pytest.raises(HTTPException) as ei:
        create_job(JobCreate(job_type="delist_sku", sku="SKU-E", account_ids=[]), db)
    assert ei.value.status_code == 400
    assert db.query(Job).count() == 0


def test_failed_undo_calls_a_person(bound, monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "_send", lambda title, desp, **k: sent.append((title, desp)) or True)
    db = bound
    acc = _acc(db)
    lst = _live(db, acc, sku="SKU-F")
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    undo = Task(job_id=job.id, account_id=acc.id, task_type="goods_delete",
                source=REFRESH_UNDO_SOURCE, ref_id="SKU-F", status=TaskStatus.RUNNING,
                spec={"item_id": "1001", "listing_id": lst.id})
    db.add(undo)
    db.commit()
    _result(db, undo, ok=False, error="没找到删除按钮")
    assert sent and "人工删除" in sent[0][0] and "SKU-F" in sent[0][1]


# ---------------------------------------------------------------- 重发失败
def _deleted_and_publishing(db):
    acc = _acc(db)
    lst = _live(db, acc)
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (delete,) = _tasks(db, job.id)
    _result(db, delete, ok=True)
    return lst, _tasks(db, job.id)[1]


def test_republish_failure_waits_for_tomorrow_and_tells_once(bound, monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "_send", lambda title, desp, **k: sent.append(title) or True)
    db = bound
    lst, publish = _deleted_and_publishing(db)
    _result(db, publish, ok=False, result={"ok": False, "failed_step": "images"}, error="图片下载失败")
    assert db.get(Listing, lst.id).status == ListingStatus.PENDING_REPUBLISH
    assert sent == ["有链接删了没发上去"]

    lst2, publish2 = _deleted_and_publishing(db)
    _result(db, publish2, ok=False, result={"ok": False}, error="超时")
    assert sent == ["有链接删了没发上去"]        # 一天只推一条
    assert db.get(Listing, lst2.id).status == ListingStatus.PENDING_REPUBLISH


def test_republish_clicked_but_unconfirmed_goes_uncertain(bound, monkeypatch):
    monkeypatch.setattr(notify, "_send", lambda *a, **k: True)
    db = bound
    lst, publish = _deleted_and_publishing(db)
    _result(db, publish, ok=False,
            result={"ok": False, "published": True, "item_id": "4004", "failed_step": "verify"},
            error="发布后列表没找到")
    lst = db.get(Listing, lst.id)
    assert lst.status == ListingStatus.UNCERTAIN
    assert lst.item_id == "4004"
    assert jobs.refresh_candidates(db)["items"] == []    # 绝不自动再发


def test_risk_failure_does_not_double_notify(bound, monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "_send", lambda title, desp, **k: sent.append(title) or True)
    db = bound
    lst, publish = _deleted_and_publishing(db)
    _result(db, publish, ok=False, result={"ok": False, "risk": "滑块"}, error="命中风控")
    assert sent == []          # runner 已经发过「闲鱼账号要人工处理」


# ---------------------------------------------------------------- 候选单
def test_candidates_pick_old_live_and_pending_first(db):
    acc = _acc(db)
    young = _live(db, acc, age_days=6)
    old = _live(db, acc, age_days=10)
    older = _live(db, acc, age_days=20)
    pending = _live(db, acc, age_days=1, status=ListingStatus.PENDING_REPUBLISH)
    _live(db, acc, age_days=30, item_id=None)                   # 没 id 删不准
    _live(db, acc, age_days=30, status=ListingStatus.UNCERTAIN)
    _live(db, _acc(db, kind="android"), age_days=30)             # 手机端没有删除流程
    got = jobs.refresh_candidates(db)
    assert [i["listing_id"] for i in got["items"]] == [pending.id, older.id, old.id]
    assert young.id not in {i["listing_id"] for i in got["items"]}
    # 两道上限取小:焕新日上限(100)比账号日发布配额大时,能开的就是配额
    assert got["rooms"] == {acc.id: min(settings.listing_refresh_per_account_daily,
                                        acc.daily_publish_quota)}
    assert got["min_age_days"] == 7


def test_candidates_skip_links_a_buyer_is_asking_about(db):
    acc = _acc(db)
    talked = _live(db, acc, title="【戴尔U2723QE 27寸4K显示器】99新")
    quiet = _live(db, acc, title="【小米34寸带鱼屏】")
    db.add(Conversation(account_id=acc.id, peer_key="p1", item_title="【戴尔U2723QE 27寸4K…",
                        last_message_at=datetime.utcnow() - timedelta(hours=3)))
    db.add(Conversation(account_id=acc.id, peer_key="p2", item_title="【小米34寸带鱼屏】",
                        last_message_at=datetime.utcnow() - timedelta(days=5)))   # 早聊完了
    db.commit()
    got = jobs.refresh_candidates(db)
    assert [i["listing_id"] for i in got["items"]] == [quiet.id]
    assert got["held_for_buyers"] == 1
    assert talked.id not in {i["listing_id"] for i in got["items"]}


def test_candidates_skip_busy_listings(db):
    acc = _acc(db)
    lst = _live(db, acc)
    jobs.create_refresh_listing(db, lst.id, SPEC)
    assert jobs.refresh_candidates(db)["items"] == []


# ---------------------------------------------------------------- 调度
def test_republish_jumps_the_queue(db_session, monkeypatch):
    db = db_session
    acc = _acc(db)
    normal = Task(task_type="goods_publish", account_id=acc.id, ref_id="N", status=TaskStatus.PENDING,
                  spec={}, created_at=datetime.utcnow() - timedelta(hours=1))
    republish = Task(task_type="goods_publish", account_id=acc.id, ref_id="R",
                     status=TaskStatus.PENDING, source=REFRESH_TASK_SOURCE, spec={},
                     created_at=datetime.utcnow())
    db.add_all([normal, republish])
    db.commit()
    picked = []
    monkeypatch.setattr(sched_mod, "SessionLocal",
                        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False))
    sched = Scheduler(bridge=None)
    monkeypatch.setattr(sched.pool, "submit", lambda fn, task_id, *a: picked.append(task_id))
    sched._dispatch_pass()
    assert picked == [republish.id]


def test_aging_no_longer_marks_expired_listings(db_session, monkeypatch):
    """PENDING_REPUBLISH 现在的意思是「旧链接已删」;按 expire_at 把在架的标成它,会被当成已删直接重发。"""
    db = db_session
    acc = _acc(db)
    lst = _live(db, acc)
    lst.expire_at = NOW - timedelta(days=1)
    db.commit()
    monkeypatch.setattr(sched_mod, "SessionLocal",
                        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False))
    Scheduler(bridge=None)._aging_pass()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.LIVE


def test_delete_is_a_dispatchable_browser_flow():
    assert "goods_delete" in runner.DISPATCHABLE_TYPES
    assert runner._pick_flow("goods_delete", "browser") is gfw.run_delete_web
    assert runner._pick_flow("goods_delete", "android") is None


# ---------------------------------------------------------------- 网页版删除流程
class FakeItemPage:
    """详情页「删除」→ 确认弹窗 →「被删掉了」。推荐流里放一个带「申诉」的商品标题。"""

    DELETE_BTN = (1400, 600)
    OK_BTN = (1020, 480)

    def __init__(self, item_id="1001", deleted=False, twin=None, risk_text=None):
        self.item_id = item_id
        self.deleted = deleted
        self.dialog = False
        self.twin = twin            # 在售列表里的 (标题, 价格)
        self.risk_text = risk_text
        self.url = ""
        self.confirms = 0

    @property
    def page(self):
        return self

    def launch_app(self, url):
        self.url = url
        self.dialog = False

    def screen_size(self):
        return 1920, 1000

    def screencap(self):
        return b"png"

    def swipe(self, *a, **k):
        pass

    @staticmethod
    def _n(desc, cls, x, y, w=80, h=30):
        return {"desc": desc, "cls": cls, "center": (x, y), "size": (w, h)}

    def dump_nodes(self):
        nodes = [self._n("土星耐心的黑水母", "nick--RyNYtDXM", 1700, 40)]
        if "/personal" in self.url:
            if self.twin:
                nodes += [self._n("", "cardWarp--x", 500, 400, 300, 400),
                          self._n(self.twin[0], "main-title--x", 500, 500),
                          self._n(str(self.twin[1]), "number--x", 450, 550)]
            return nodes
        if self.deleted:
            return nodes + [self._n("糟糕！宝贝被删掉了", "title--x", 960, 650),
                            self._n("专业申诉代写 账号违规解封", "feeds-title--x", 300, 990)]
        nodes += [self._n("下架", "sellerButton--x", 1300, 600),
                  self._n("删除", "sellerButton--x", *self.DELETE_BTN)]
        if self.risk_text:
            nodes.append(self._n(self.risk_text, "x", 960, 300))
        if self.dialog:
            nodes += [self._n("确定要删除这个宝贝吗？", "confirmTitle--x", 960, 400),
                      self._n("取消", "btnChildren--x", 900, 480),
                      self._n("确定", "btnChildren--x", *self.OK_BTN)]
        return nodes

    def tap(self, x, y):
        if self.dialog and (x, y) == self.OK_BTN:
            self.deleted, self.dialog = True, False
            self.confirms += 1
        elif (x, y) == self.DELETE_BTN and not self.deleted:
            self.dialog = True


@pytest.fixture
def no_sleep(monkeypatch):
    monkeypatch.setattr(gfw.time, "sleep", lambda *_: None)


def _shot(name, data):
    return f"shots/{name}.png"


def _open(t):
    t.launch_app(gfw.ITEM_URL.format(t.item_id))


def test_delete_flow_happy_path(no_sleep):
    t = FakeItemPage()
    res = gfw.run_delete_web(t, {"item_id": "1001", "title": "x", "price": 520}, shot_sink=_shot)
    assert res["ok"], res
    assert res["item_id"] == "1001" and t.confirms == 1
    assert res["risk"] is None          # 「被删掉了」页推荐流里的「申诉」「违规」不算风控


def test_delete_flow_requires_item_id(no_sleep):
    res = gfw.run_delete_web(FakeItemPage(), {"title": "x"}, shot_sink=_shot)
    assert not res["ok"] and res["failed_step"] == "open_item"


def test_delete_flow_refuses_wrong_page(no_sleep, monkeypatch):
    t = FakeItemPage()
    t.launch_app = lambda url: setattr(t, "url", "https://www.goofish.com/item?id=999")
    res = gfw.run_delete_web(t, {"item_id": "1001"}, shot_sink=_shot)
    assert not res["ok"] and "拒绝操作" in res["reason"]
    assert t.confirms == 0


def test_delete_flow_already_deleted_counts_as_done(no_sleep):
    t = FakeItemPage(deleted=True)
    res = gfw.run_delete_web(t, {"item_id": "1001", "title": "【AOC】", "price": 520}, shot_sink=_shot)
    assert res["ok"] and res["already_deleted"]
    assert t.confirms == 0


def test_delete_flow_already_deleted_but_twin_still_listed(no_sleep):
    """账本 id 已是「被删掉了」,在售列表却还挂着同标题同价的:id 可能记错了,不能当删成。"""
    t = FakeItemPage(deleted=True, twin=("【AOC】", 520))
    res = gfw.run_delete_web(t, {"item_id": "1001", "title": "【AOC】", "price": 520}, shot_sink=_shot)
    assert not res["ok"] and "交人工" in res["reason"]


def test_delete_flow_stops_on_real_risk(no_sleep):
    t = FakeItemPage(risk_text="请拖动下方滑块完成验证")
    res = gfw.run_delete_web(t, {"item_id": "1001"}, shot_sink=_shot)
    assert not res["ok"] and res["risk"]
    assert t.confirms == 0


def test_delete_flow_no_delete_button(no_sleep, monkeypatch):
    t = FakeItemPage()
    real = t.dump_nodes
    t.dump_nodes = lambda: [n for n in real() if n["desc"] != "删除"]
    res = gfw.run_delete_web(t, {"item_id": "1001"}, shot_sink=_shot)
    assert not res["ok"] and res["failed_step"] == "delete"


def test_delete_flow_not_gone_after_confirm(no_sleep):
    t = FakeItemPage()
    real_tap = t.tap

    def tap(x, y):                      # 点了确定,闲鱼没删(页面不变)
        real_tap(x, y)
        t.deleted = False
    t.tap = tap
    res = gfw.run_delete_web(t, {"item_id": "1001"}, shot_sink=_shot)
    assert not res["ok"] and "仍不是" in res["reason"]


@pytest.mark.parametrize("flow", [gfw.run_delist_web, gfw.run_relist_web])
def test_other_flows_on_a_deleted_item_say_so_instead_of_freezing(no_sleep, flow):
    """焕新删掉的商品,下架/重新上架再打开就是「被删掉了」页:推荐流里的「申诉」不能把号冻了。"""
    res = flow(FakeItemPage(deleted=True), {"item_id": "1001", "title": "x", "price": 520},
               shot_sink=_shot)
    assert not res["ok"] and res["risk"] is None
    assert "已经被删掉了" in res["reason"]


# ---------------------------------------------------------------- 详情页查单件
def test_refresh_status_reports_each_link_and_why_not(db):
    acc = _acc(db)
    lst = _live(db, acc, sku="SKU-S")
    out = jobs.refresh_status(db, "SKU-S", now=NOW)
    assert out["min_age_days"] == settings.listing_refresh_min_age_days
    assert [(i["listing_id"], i["usable"], i["blocker"]) for i in out["items"]] == [(lst.id, True, None)]

    db.add(Conversation(account_id=acc.id, peer_key="b1", item_title=lst.title,
                        last_message_at=NOW - timedelta(hours=1)))
    db.commit()
    assert "买家问过" in jobs.refresh_status(db, "SKU-S", now=NOW)["items"][0]["blocker"]


def test_refresh_status_skips_finished_links(db):
    acc = _acc(db)
    _live(db, acc, sku="SKU-D", status=ListingStatus.DELISTED)
    assert jobs.refresh_status(db, "SKU-D", now=NOW)["items"] == []


# ---------------------------------------------------------------- 无忧卖(11-11 用户定:先排掉,不处理)
class WuyoumaiPage(FakeItemPage):
    """参加了无忧卖:点「确定」不删,顶部 toast 叫人去「无忧卖-售卖中」改。"""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.toast = False

    def launch_app(self, url):
        super().launch_app(url)
        self.toast = False

    def dump_nodes(self):
        nodes = super().dump_nodes()
        if self.toast:
            nodes.append(self._n("为保障无忧卖流量推广效果，请前往「无忧卖-售卖中」修改价格和库存", "toast--x", 960, 40))
        return nodes

    def tap(self, x, y):
        if self.dialog and (x, y) == self.OK_BTN:
            self.dialog, self.toast = False, True
            self.confirms += 1
        else:
            super().tap(x, y)


def test_delete_flow_recognises_wuyoumai(no_sleep):
    t = WuyoumaiPage()
    res = gfw.run_delete_web(t, {"item_id": "1001", "title": "x", "price": 520}, shot_sink=_shot)
    assert not res["ok"] and res["wuyoumai"] and "无忧卖" in res["reason"]
    assert t.confirms == 1


def test_wuyoumai_listing_is_skipped_from_then_on(bound, monkeypatch):
    db = bound
    sent = []
    monkeypatch.setattr("app.notify.notify_refresh_problem", lambda *a, **k: sent.append(a))
    acc = _acc(db)
    lst = _live(db, acc, age_days=10)
    job = jobs.create_refresh_listing(db, lst.id, SPEC)
    (delete,) = _tasks(db, job.id)
    _result(db, delete, ok=False, error=gfw.WUYOUMAI_REASON,
            result={"ok": False, "failed_step": "delete", "wuyoumai": True})
    lst = db.get(Listing, lst.id)
    assert lst.status == ListingStatus.LIVE and lst.refresh_skip == "无忧卖"
    assert len(_tasks(db, job.id)) == 1 and sent == []          # 不重发、不通知
    assert lst.id not in {i["listing_id"] for i in jobs.refresh_candidates(db)["items"]}
    (item,) = jobs.refresh_status(db, lst.sku)["items"]
    assert item["refresh_skip"] == "无忧卖" and item["blocker"] is None   # 人手动能点
    with pytest.raises(jobs.RefreshRejected):
        jobs.create_refresh_listing(db, lst.id, SPEC)
    # 人点了「立即重新上架」（多半退出无忧卖了）：清掉标记照常删了重发
    job2 = jobs.create_refresh_listing(db, lst.id, SPEC, source="MANUAL")
    assert db.get(Listing, lst.id).refresh_skip is None and len(_tasks(db, job2.id)) == 1
