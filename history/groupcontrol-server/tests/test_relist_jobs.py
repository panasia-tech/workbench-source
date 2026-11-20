from datetime import datetime

from app import jobs
from app.models import Account, Job, JobType, Listing, ListingStatus, Task, TaskStatus


def _mk_delisted(db, sku="SKU1", item_id="i1"):
    acc = Account(nick="a")
    db.add(acc)
    db.flush()
    lst = Listing(sku=sku, account_id=acc.id, item_id=item_id,
                  status=ListingStatus.DELISTED)
    db.add(lst)
    db.commit()
    return acc, lst


def test_create_relist_sku_fans_out_delisted(db):
    acc, lst = _mk_delisted(db)
    job = jobs.create_relist_sku(db, "SKU1")
    assert job.job_type == JobType.RELIST_SKU
    tasks = db.query(Task).filter(Task.job_id == job.id).all()
    assert len(tasks) == 1
    t = tasks[0]
    assert t.task_type == "goods_relist"
    assert t.status == TaskStatus.PENDING
    assert t.account_id == acc.id
    assert t.spec["listing_id"] == lst.id
    assert t.spec["title_hint"] == "SKU1"
    assert job.total == 1


def test_create_relist_sku_ignores_live(db):
    acc, lst = _mk_delisted(db)
    lst.status = ListingStatus.LIVE
    db.commit()
    job = jobs.create_relist_sku(db, "SKU1")
    assert job.total == 0
    assert db.query(Task).filter(Task.job_id == job.id).count() == 0


def test_on_relist_ok_flips_to_live(db):
    acc, lst = _mk_delisted(db)
    task = Task(task_type="goods_relist", account_id=acc.id, ref_id="SKU1",
                spec={"listing_id": lst.id, "title_hint": "SKU1"})
    db.add(task)
    db.commit()
    jobs._on_relist_ok(db, task)
    db.commit()
    db.refresh(lst)
    assert lst.status == ListingStatus.LIVE
    assert lst.published_at is not None
