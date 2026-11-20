"""发布记账:title/item_id 回读后 Listing 落什么状态。

核心修复(2026-07-22):回读到 title(已在「在卖」列表确认在架)即 LIVE,不再死等 item_id
——闲鱼卡片本就不显示 item_id,旧逻辑让每条成功发布都停在 UNCERTAIN。
"""
from app import jobs
from app.models import (
    Account, JobType, Listing, ListingStatus, Task, TaskStatus,
)


# ---------------- 纯函数:_publish_listing_status ----------------

def test_status_live_when_item_id():
    assert jobs._publish_listing_status("i123", None, "SUBMITTED") == ListingStatus.LIVE


def test_status_live_when_title_only():
    # 回读到 title 即在架可定位 → LIVE(不必有 item_id)
    assert jobs._publish_listing_status(None, "【泰坦军团显示器】", "SUBMITTED") == ListingStatus.LIVE


def test_status_uncertain_when_nothing():
    assert jobs._publish_listing_status(None, None, "SUBMITTED") == ListingStatus.UNCERTAIN


def test_status_uncertain_when_pending_auth_even_with_title():
    # 待支付宝认证:宝贝已提交但未真正上架,即便回读到 title 也不算 LIVE
    assert jobs._publish_listing_status(None, "【x】", "PENDING_PAYMENT_AUTH") == ListingStatus.UNCERTAIN
    assert jobs._publish_listing_status("i1", "【x】", "PENDING_PAYMENT_AUTH") == ListingStatus.UNCERTAIN


# ---------------- 接线:_on_publish_ok 建 Listing ----------------

def _publish_task(db, title=None, item_id=None, outcome="SUBMITTED", sku="SKU_PUB"):
    acc = Account(nick="a")
    db.add(acc)
    db.flush()
    result = {"ok": True, "publish_outcome": outcome, "title": title, "item_id": item_id}
    task = Task(task_type="goods_publish", account_id=acc.id, ref_id=sku,
                status=TaskStatus.SUCCESS, spec={"price": 460}, result=result)
    db.add(task)
    db.commit()
    return task


def test_on_publish_ok_title_readback_marks_live(db):
    task = _publish_task(db, title="【泰坦军团P2510H PLUS显示器】25寸")
    jobs._on_publish_ok(db, task)
    db.commit()
    lst = db.query(Listing).filter(Listing.sku == "SKU_PUB").one()
    assert lst.status == ListingStatus.LIVE
    assert lst.title == "【泰坦军团P2510H PLUS显示器】25寸"
    assert lst.price == 460


def test_on_publish_ok_no_anchor_stays_uncertain(db):
    task = _publish_task(db, title=None, item_id=None)
    jobs._on_publish_ok(db, task)
    db.commit()
    lst = db.query(Listing).filter(Listing.sku == "SKU_PUB").one()
    assert lst.status == ListingStatus.UNCERTAIN


def test_on_publish_ok_pending_auth_uncertain(db):
    task = _publish_task(db, title="【x】", outcome="PENDING_PAYMENT_AUTH")
    jobs._on_publish_ok(db, task)
    db.commit()
    lst = db.query(Listing).filter(Listing.sku == "SKU_PUB").one()
    assert lst.status == ListingStatus.UNCERTAIN
