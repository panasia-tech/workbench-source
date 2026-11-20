"""售出联动的两个漏洞(11-11 #111 核查):

- ERP 换了货号,账本还记旧货号 → 售出同步、下架都按新货号找不到链接(xbox 手柄卖了还挂 6 个号);
- 同一条链接已经有下架任务在排队时再建一单,不叠任务,新作业接手。
"""
from datetime import datetime
from uuid import uuid4

from app import jobs
from app.models import (
    Account,
    AccountStatus,
    Device,
    DeviceStatus,
    Job,
    JobStatus,
    Listing,
    ListingStatus,
    RiskState,
    Task,
    TaskStatus,
)


def _acc(db):
    dev = Device(name=f"d-{uuid4().hex[:6]}", kind="browser", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.flush()
    acc = Account(nick=f"a-{uuid4().hex[:8]}", device_id=dev.id, status=AccountStatus.ACTIVE,
                  risk_state=RiskState.NORMAL, active_window="00:00-23:59")
    db.add(acc)
    db.flush()
    return acc


def _live(db, acc, sku, item_id, status=ListingStatus.LIVE):
    lst = Listing(sku=sku, account_id=acc.id, item_id=item_id, title="【xbox手柄】成色如图",
                  status=status, price=149, published_at=datetime.utcnow())
    db.add(lst)
    db.commit()
    return lst


def _tasks(db, job_id):
    return db.query(Task).filter(Task.job_id == job_id).all()


def test_recode_moves_every_listing_to_the_new_code(db):
    a, b = _acc(db), _acc(db)
    _live(db, a, "M20261026-005", "1")
    _live(db, b, "M20261026-005", "2", status=ListingStatus.SOLD)
    _live(db, b, "OTHER", "3")
    assert jobs.recode_listings(db, [("M20261026-005", "513211540464")]) == 2
    assert {l.sku for l in db.query(Listing).filter(Listing.item_id.in_(["1", "2"]))} == {"513211540464"}
    assert db.query(Listing).filter(Listing.item_id == "3").one().sku == "OTHER"
    # 每轮都会带上全部换码记录:再来一次什么都不动
    assert jobs.recode_listings(db, [("M20261026-005", "513211540464")]) == 0


def test_recode_follows_a_code_changed_twice(db):
    a = _acc(db)
    _live(db, a, "OLD", "1")
    jobs.recode_listings(db, [("OLD", "MID"), ("MID", "NEW")])
    assert db.query(Listing).one().sku == "NEW"


def test_recode_leaves_links_of_a_later_sku_that_reused_the_old_code(db):
    """06 月 X:sancg73→TMP-010;之后 Y 又叫 sancg73 上了 8 个号;Y 再换成 5132…。
    ERP 每轮按先后重放全部换码,06 月那条不能把 Y 的链接改成 TMP-010(11-11 首发事故)。"""
    a = _acc(db)
    x_old = _live(db, a, "sancg73", "x1")
    x_old.created_at = datetime(2026, 5, 20)
    y = _live(db, a, "SANCG73", "y1")
    y.created_at = datetime(2026, 9, 1)
    db.commit()
    jobs.recode_listings(db, [
        ("SANCG73", "TMP-010", datetime(2026, 6, 1)),
        ("SANCG73", "513211540001", datetime(2026, 11, 12)),
    ])
    assert db.query(Listing).filter(Listing.item_id == "x1").one().sku == "TMP-010"
    assert db.query(Listing).filter(Listing.item_id == "y1").one().sku == "513211540001"


def test_delist_after_recode_finds_the_links(db):
    a = _acc(db)
    _live(db, a, "OLD", "1")
    jobs.recode_listings(db, [("OLD", "NEW")])
    job = jobs.create_delist_sku(db, "NEW")
    assert job.total == 1


def test_new_delist_takes_over_a_queued_one(db):
    a, b = _acc(db), _acc(db)
    _live(db, a, "SKU-X", "1")
    _live(db, b, "SKU-X", "2")
    first = jobs.create_delist_sku(db, "SKU-X", source="MANUAL")
    second = jobs.create_delist_sku(db, "SKU-X")
    # 每条链接只剩一个活的下架任务,在新作业里
    live = db.query(Task).filter(Task.task_type == "goods_delist",
                                 Task.status == TaskStatus.PENDING).all()
    assert {t.job_id for t in live} == {second.id} and len(live) == 2
    old = _tasks(db, first.id)
    assert all(t.status == TaskStatus.CANCELLED and t.error == f"由新的下架作业接手:{second.id}" for t in old)
    db.expire_all()
    assert db.get(Job, first.id).status == JobStatus.FAILED     # 旧作业收尾,不会一直挂着「待开始」


def test_delist_already_running_is_left_alone(db):
    a, b = _acc(db), _acc(db)
    _live(db, a, "SKU-Y", "1")
    _live(db, b, "SKU-Y", "2")
    first = jobs.create_delist_sku(db, "SKU-Y")
    running = next(t for t in _tasks(db, first.id) if t.account_id == a.id)
    running.status = TaskStatus.RUNNING
    db.commit()
    second = jobs.create_delist_sku(db, "SKU-Y")
    assert {t.account_id for t in _tasks(db, second.id)} == {b.id}
    assert second.total == 1
    db.refresh(running)
    assert running.status == TaskStatus.RUNNING


def test_other_links_delists_are_not_touched(db):
    a = _acc(db)
    _live(db, a, "SKU-A", "1")
    _live(db, a, "SKU-B", "2")
    other = jobs.create_delist_sku(db, "SKU-B")
    jobs.create_delist_sku(db, "SKU-A")
    assert [t.status for t in _tasks(db, other.id)] == [TaskStatus.PENDING]
