"""自动上架 worker：捡到点的行、一行一提交、开关与触发点。

红线：
  1. 终态（DONE/NEEDS_HUMAN/FAILED）绝不再被捡起——人工处理过的不能被机器又推回去；
  2. 单行炸了不带走整轮；
  3. 总开关关着时入库不登记、worker 不推进。
"""

from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.enums import AutoListingStage, SkuStatus
from app.models import CrawlProduct, Sku, SkuAutoListing, WarehouseSpu
from app.services.auto_listing import worker
from app.services.auto_listing.pipeline import enqueue, enqueue_on_inbound


def _sku(db, code="M20260908-001", **kw):
    base = dict(
        sku_code=code, purchase_order_id="p", inspection_id="i",
        product_name="小米空气净化器", brand="小米", model="空气净化器4PRO",
        cost_price=Decimal("900"), status=SkuStatus.IN_STOCK,
        images=["https://oss/a.jpg"], negotiated_at=datetime.utcnow(),
    )
    sku = Sku(**{**base, **kw})
    db.add(sku)
    db.flush()
    return sku


@pytest.fixture()
def db(db_session):
    db_session.add(WarehouseSpu(spu_code="90000638", brand="小米", model="空气净化器4PRO"))
    db_session.add(CrawlProduct(
        name="小米 空气净化器4PRO", keyword="小米 空气净化器4PRO",
        enabled=True, last_price=Decimal("1360"),
    ))
    db_session.commit()
    return db_session


@pytest.fixture(autouse=True)
def _on(monkeypatch):
    """默认按「开关已开」跑；测开关的用例自己再关回去。"""
    monkeypatch.setattr(worker.settings, "auto_listing_enabled", True, raising=False)
    monkeypatch.setattr(
        "app.services.auto_listing.pipeline.settings.auto_listing_enabled", True, raising=False
    )


# ---------------------------------------------------------------- 捡行

def test_只捡到点的行(db):
    now = datetime.utcnow()
    a = _sku(db, "A"); b = _sku(db, "B"); c = _sku(db, "C")
    db.add(SkuAutoListing(sku_id=a.id, stage=AutoListingStage.RESOLVING, next_run_at=now))
    db.add(SkuAutoListing(sku_id=b.id, stage=AutoListingStage.COLLECTING,
                          next_run_at=now + timedelta(hours=1)))  # 还没到点
    db.add(SkuAutoListing(sku_id=c.id, stage=AutoListingStage.WAIT_NEGOTIATION,
                          next_run_at=None))  # 挂起
    db.commit()
    picked = {r.sku_id for r in worker.due_rows(db, limit=10)}
    assert picked == {a.id}


@pytest.mark.parametrize("stage", list(worker.TERMINAL_STAGES))
def test_终态不再被捡起(db, stage):
    sku = _sku(db)
    db.add(SkuAutoListing(sku_id=sku.id, stage=stage, next_run_at=datetime.utcnow()))
    db.commit()
    assert worker.due_rows(db, limit=10) == []


def test_批量上限(db):
    for i in range(5):
        sku = _sku(db, f"M{i}")
        db.add(SkuAutoListing(sku_id=sku.id, stage=AutoListingStage.RESOLVING,
                              next_run_at=datetime.utcnow()))
    db.commit()
    assert len(worker.due_rows(db, limit=2)) == 2


# ---------------------------------------------------------------- 推进

def test_一轮把行往前推一步(db):
    sku = _sku(db)
    row = enqueue(db, sku)
    db.commit()
    assert worker.run_due(db, limit=10) == 1
    assert row.stage == AutoListingStage.COLLECTING


def test_推不动的不算推进(db):
    """行情价没爬到 → 退避重试，阶段没变，不该记成「推进了一行」。"""
    db.query(CrawlProduct).delete()
    sku = _sku(db)
    row = enqueue(db, sku)
    row.stage = AutoListingStage.COLLECTING
    row.collecting_since = datetime.utcnow()
    db.commit()
    assert worker.run_due(db, limit=10) == 0
    assert row.stage == AutoListingStage.COLLECTING and row.attempts == 1


def test_单行失败不带走整轮(db, monkeypatch):
    bad = _sku(db, "BAD")
    good = _sku(db, "GOOD")
    bad_row = enqueue(db, bad)
    good_row = enqueue(db, good)
    db.commit()

    real = worker.advance

    def flaky(db_, row, **kw):
        if row.sku_id == bad_row.sku_id:
            raise RuntimeError("库炸了")
        return real(db_, row, **kw)

    monkeypatch.setattr(worker, "advance", flaky)
    assert worker.run_due(db, limit=10) == 1
    assert good_row.stage == AutoListingStage.COLLECTING
    assert bad_row.stage == AutoListingStage.RESOLVING  # 原地不动，下轮再来


def test_一行一提交(db):
    """推完就落库：run_due 返回后不用调用方再 commit。"""
    sku = _sku(db)
    enqueue(db, sku)
    db.commit()
    worker.run_due(db, limit=10)
    db.rollback()
    row = db.query(SkuAutoListing).filter(SkuAutoListing.sku_id == sku.id).first()
    assert row.stage == AutoListingStage.COLLECTING


# ---------------------------------------------------------------- 开关与触发点

def test_入库登记(db):
    sku = _sku(db)
    row = enqueue_on_inbound(db, sku)
    db.commit()
    assert row is not None and row.stage == AutoListingStage.RESOLVING


def test_开关关着入库不登记(db, monkeypatch):
    monkeypatch.setattr(
        "app.services.auto_listing.pipeline.settings.auto_listing_enabled", False, raising=False
    )
    sku = _sku(db)
    assert enqueue_on_inbound(db, sku) is None
    db.commit()
    assert db.query(SkuAutoListing).count() == 0


def test_登记失败不拖垮入库(db, monkeypatch):
    """自动上架是增值项，入库是主干：登记炸了也只吞掉，不往上抛。"""
    monkeypatch.setattr(
        "app.services.auto_listing.pipeline.enqueue",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("表还没建")),
    )
    assert enqueue_on_inbound(db, _sku(db)) is None


# ---------------------------------------------------------------- 发布适配

def test_群控未启用时发布直接报错(db, monkeypatch):
    """报错会被 advance 接住转成退避重试，不会把货误判成发过了。"""
    monkeypatch.setattr(worker.settings, "gc_publish_enabled", False, raising=False)
    with pytest.raises(RuntimeError, match="GC_PUBLISH_ENABLED"):
        worker.publish_via_gc(db, _sku(db), None)
