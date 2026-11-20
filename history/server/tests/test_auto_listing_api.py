"""自动上架看板：筛选、计数、把转人工的行放回流水线。

按仓库里现成的写法直接调用路由函数（不起 TestClient），只验业务分支。

红线：在跑的行（PUBLISHING）不许重置——群控作业已经发出去了，重置回 RESOLVING
会再发一次，同一件货挂两条链接。
"""

from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.enums import AutoListingStage, SkuStatus
from app.models import Sku, SkuAutoListing
from app.routers import auto_listing as api


def _sku(db, code="M20260908-001", **kw):
    base = dict(
        sku_code=code, purchase_order_id="p", inspection_id="i",
        product_name="小米空气净化器", brand="小米", model="空气净化器4PRO",
        cost_price=Decimal("900"), status=SkuStatus.IN_STOCK, images=["https://oss/a.jpg"],
    )
    sku = Sku(**{**base, **kw})
    db.add(sku)
    db.flush()
    return sku


def _row(db, sku, stage=AutoListingStage.RESOLVING, **kw):
    row = SkuAutoListing(sku_id=sku.id, stage=stage, **kw)
    db.add(row)
    db.flush()
    return row


@pytest.fixture()
def db(db_session):
    return db_session


def _list(db, *, stage=None, q=None, page=1, page_size=50):
    """直调路由函数：Query(...) 默认值不会自己解析成真值，参数得给全。"""
    return api.list_rows(stage=stage, q=q, issue=None, db=db, _=None, page=page, page_size=page_size)


# ---------------------------------------------------------------- 列表

def test_按阶段筛选(db):
    _row(db, _sku(db, "A"), AutoListingStage.NEEDS_HUMAN)
    _row(db, _sku(db, "B"), AutoListingStage.READY)
    db.commit()
    page = _list(db, stage="NEEDS_HUMAN")
    assert page.total == 1 and page.items[0].sku_code == "A"


def test_按货号或商品名搜索(db):
    _row(db, _sku(db, "M-AAA", product_name="小米空气净化器"))
    _row(db, _sku(db, "M-BBB", product_name="戴森吹风机", brand="戴森", model="HD15"))
    db.commit()
    assert {r.sku_code for r in _list(db, q="AAA").items} == {"M-AAA"}
    assert {r.sku_code for r in _list(db, q="戴森").items} == {"M-BBB"}


def test_带出货和停下来的原因(db):
    sku = _sku(db)
    _row(db, sku, AutoListingStage.NEEDS_HUMAN,
         last_error="解析不出所属 SPU（品牌/型号不在对照表里）",
         market_price=Decimal("800"))
    db.commit()
    item = _list(db).items[0]
    assert item.product_name == "小米空气净化器" and item.cost_price == Decimal("900")
    assert "SPU" in item.last_error and item.market_price == Decimal("800")


def test_分页(db):
    for i in range(5):
        _row(db, _sku(db, f"M{i}"))
    db.commit()
    page = _list(db, page=2, page_size=2)
    assert page.total == 5 and len(page.items) == 2


# ---------------------------------------------------------------- 计数

def test_各阶段计数覆盖全部阶段(db):
    _row(db, _sku(db, "A"), AutoListingStage.NEEDS_HUMAN)
    _row(db, _sku(db, "B"), AutoListingStage.NEEDS_HUMAN)
    _row(db, _sku(db, "C"), AutoListingStage.DONE)
    db.commit()
    out = api.summary(db=db, _=None)
    assert out.total == 3
    assert out.counts["NEEDS_HUMAN"] == 2 and out.counts["DONE"] == 1
    # 没有行的阶段也要有 0，否则看板筛选条会缺格子
    assert out.counts["WAIT_NEGOTIATION"] == 0


def test_计数带开关状态(db, monkeypatch):
    """一行都没有时，得能分清是没货还是开关压根没开。"""
    monkeypatch.setattr(api.settings, "auto_listing_enabled", False, raising=False)
    assert api.summary(db=db, _=None).enabled is False
    monkeypatch.setattr(api.settings, "auto_listing_enabled", True, raising=False)
    assert api.summary(db=db, _=None).enabled is True


# ---------------------------------------------------------------- 放回流水线

def test_转人工的行放回流水线从头重跑(db):
    row = _row(db, _sku(db), AutoListingStage.NEEDS_HUMAN, attempts=8,
               last_error="解析不出所属 SPU", collecting_since=datetime.utcnow() - timedelta(days=4))
    db.commit()
    out = api.retry_row(row.id, db=db, _=None)
    assert out.stage == AutoListingStage.RESOLVING
    assert out.attempts == 0 and out.last_error is None
    assert out.next_run_at is not None
    # 等价超期的计时要清掉，否则一进 COLLECTING 立刻又判超期
    assert out.collecting_since is None


@pytest.mark.parametrize("stage", [
    AutoListingStage.PUBLISHING,
    AutoListingStage.READY,
    AutoListingStage.COLLECTING,
    AutoListingStage.WAIT_NEGOTIATION,
    AutoListingStage.DONE,
])
def test_在跑的和已完成的不许重置(db, stage):
    row = _row(db, _sku(db), stage)
    db.commit()
    with pytest.raises(HTTPException) as exc:
        api.retry_row(row.id, db=db, _=None)
    assert exc.value.status_code == 400
    assert row.stage == stage


def test_行不存在报404(db):
    with pytest.raises(HTTPException) as exc:
        api.retry_row("不存在", db=db, _=None)
    assert exc.value.status_code == 404
