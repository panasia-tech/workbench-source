"""publish_batch 按账号覆盖无忧卖:worry_free_by_account 烤进各任务 spec,缺账号回落 spec 默认。"""
from app import jobs
from app.models import Account, Task


def _acc(db, nick):
    a = Account(nick=nick)
    db.add(a); db.flush()
    return a


def _spec():
    return {"images": ["https://x/a.jpg"], "price": 100, "worry_free_sell": False,
            "shipping": {"mode": "free", "self_pickup": True}}


def test_publish_batch_bakes_per_account_worry_free(db):
    a1 = _acc(db, "shop1"); a2 = _acc(db, "shop2"); a3 = _acc(db, "shop3")
    job = jobs.create_publish_batch(
        db, "SKU1", [a1.id, a2.id, a3.id], _spec(), "ERP",
        worry_free_by_account={a1.id: True, a2.id: False},   # a3 缺 → 回落 spec 默认 False
    )
    tasks = {t.account_id: t for t in db.query(Task).filter(Task.job_id == job.id).all()}
    assert tasks[a1.id].spec["worry_free_sell"] is True
    assert tasks[a2.id].spec["worry_free_sell"] is False
    assert tasks[a3.id].spec["worry_free_sell"] is False
    # 其余 spec 字段不受影响
    assert tasks[a1.id].spec["price"] == 100


def test_publish_batch_no_map_keeps_spec_default(db):
    a1 = _acc(db, "s")
    job = jobs.create_publish_batch(db, "SKU2", [a1.id], _spec(), "ERP")   # 不传 map
    t = db.query(Task).filter(Task.job_id == job.id).one()
    assert t.spec["worry_free_sell"] is False
