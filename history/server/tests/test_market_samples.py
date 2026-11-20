"""行情样本太少 / 价差太大转人工（E04-10）。

红线：开关关着行为不变；拿不到样本明细的旧数据（OCR、旧爬虫、没 priceBreakdown）不误伤。
"""
from datetime import date, datetime
from decimal import Decimal

import pytest

from app.enums import AutoListingStage, SkuStatus
from app.models import CrawlPrice, CrawlProduct, Sku, SkuListingInfo, WarehouseSpu
from app.services.app_settings import set_setting
from app.services.auto_listing import market_samples as M
from app.services.auto_listing.pipeline import advance, enqueue
from app.services.auto_listing.pricing import (
    REASON_FEW_SAMPLES,
    REASON_WIDE_SPREAD,
    check_samples,
    sample_range,
)


def _raw(prices, count=None):
    pb = {"method": "cleaned_average", "validPrices": prices}
    if count is not None:
        pb["validCount"] = count
    return {"source": "cleaned_average", "priceBreakdown": pb}


# ---------------------------------------------------------------- 纯规则

def test_样本够价差小放行():
    assert check_samples(_raw([1300, 1350, 1360, 1400, 1450], 5), min_count=5, max_spread=2) == (None, None)


def test_样本太少转人工():
    code, why = check_samples(_raw([1300, 1400, 1500], 3), min_count=5, max_spread=2)
    assert code == REASON_FEW_SAMPLES and "只搜到 3 条" in why


def test_没传条数按价数算_全被当诱饵价清掉也算太少():
    assert check_samples(_raw([1300, 1400]), min_count=5, max_spread=2)[0] == REASON_FEW_SAMPLES
    assert check_samples(_raw([], 0), min_count=5, max_spread=2)[0] == REASON_FEW_SAMPLES


def test_价差太大转人工():
    code, why = check_samples(_raw([500, 520, 900, 1400, 1500, 1600], 6), min_count=5, max_spread=2)
    assert code == REASON_WIDE_SPREAD and "从 520 到 1500 元" in why


def test_一两条离谱挂牌去掉两头不误伤():
    # 中间八成都在 1300~1450，两头各一条离谱的
    prices = [200, 1300, 1320, 1350, 1380, 1400, 1420, 1450, 1450, 5000]
    assert sample_range(prices) == (1300, 1450)
    assert check_samples(_raw(prices, 10), min_count=5, max_spread=2) == (None, None)


@pytest.mark.parametrize("raw", [
    None,
    {},
    {"source": "ocr", "parsed": {"price": 1360}},          # 成交均价没有样本
    {"source": "lowest_listing"},
    {"source": "cleaned_average", "price": 1360},           # 早期巡航台没传 priceBreakdown
    {"source": "cleaned_average", "priceBreakdown": {"method": "cleaned_average"}},
])
def test_拿不到样本明细的旧数据不误伤(raw):
    assert check_samples(raw, min_count=5, max_spread=2) == (None, None)


def test_阈值填0就不查这一项():
    assert check_samples(_raw([1300, 1400], 2), min_count=0, max_spread=0) == (None, None)


# ---------------------------------------------------------------- 阈值

def test_阈值默认与可改(db_session):
    assert M.thresholds(db_session) == (M.DEFAULT_MIN_SAMPLES, M.DEFAULT_MAX_SPREAD)
    set_setting(db_session, M.MIN_SAMPLES_KEY, "8", None)
    set_setting(db_session, M.MAX_SPREAD_KEY, "1.5", None)
    assert M.thresholds(db_session) == (8, 1.5)
    set_setting(db_session, M.MIN_SAMPLES_KEY, "乱填", None)
    assert M.thresholds(db_session)[0] == M.DEFAULT_MIN_SAMPLES


# ---------------------------------------------------------------- 接进流水线

@pytest.fixture()
def db(db_session):
    db_session.add(WarehouseSpu(spu_code="90000638", brand="小米", model="空气净化器4PRO"))
    product = CrawlProduct(name="小米 空气净化器4PRO", keyword="小米 空气净化器4PRO", enabled=True,
                           last_price=Decimal("1360"), last_price_date=date(2026, 11, 10))
    db_session.add(product)
    db_session.flush()
    # 前一天那条样本够，当天这条（last_price 来自它）只有 3 条
    db_session.add(CrawlPrice(product_id=product.id, crawl_date=date(2026, 11, 9), price=Decimal("1300"),
                              raw=_raw([1250, 1280, 1300, 1320, 1350], 5)))
    db_session.add(CrawlPrice(product_id=product.id, crawl_date=date(2026, 11, 10), price=Decimal("1360"),
                              raw=_raw([1300, 1360, 1420], 3)))
    db_session.commit()
    return db_session


def _sku(db):
    sku = Sku(sku_code="M20261110-001", purchase_order_id="p", inspection_id="i",
              product_name="小米空气净化器", brand="小米", model="空气净化器4PRO",
              cost_price=Decimal("900"), status=SkuStatus.IN_STOCK,
              images=["https://oss/a.jpg"], negotiated_at=datetime.utcnow())
    db.add(sku)
    db.flush()
    return sku


def _run(db, sku, times=6):
    row = enqueue(db, sku)
    db.commit()
    for _ in range(times):
        before = row.stage
        advance(db, row)
        db.commit()
        if row.stage == before and row.stage != AutoListingStage.RESOLVING:
            break
    return row


def test_开关关着照旧自动定价(db):
    row = _run(db, _sku(db))
    assert row.stage in (AutoListingStage.READY, AutoListingStage.WAIT_NEGOTIATION)
    assert row.resolved_price == Decimal("1360")


def test_开了样本太少转人工原因写清楚(db):
    set_setting(db, M.ENABLED_KEY, "1", None)
    row = _run(db, _sku(db))
    assert row.stage == AutoListingStage.NEEDS_HUMAN
    assert "行情样本太少" in row.last_error and "只搜到 3 条" in row.last_error
    assert REASON_FEW_SAMPLES in row.last_error
    assert "行情价" not in row.last_error   # 库存缺口按「行情价」认「没爬到价」，别被归错
    assert db.query(SkuListingInfo).count() == 0


def test_开了价差太大转人工(db):
    set_setting(db, M.ENABLED_KEY, "1", None)
    rec = db.query(CrawlPrice).filter(CrawlPrice.crawl_date == date(2026, 11, 10)).one()
    rec.raw = _raw([600, 700, 1360, 1500, 1600, 1700], 6)
    db.commit()
    row = _run(db, _sku(db))
    assert row.stage == AutoListingStage.NEEDS_HUMAN
    assert REASON_WIDE_SPREAD in row.last_error and "价差太大" in row.last_error


def test_开了旧数据照常自动定价(db):
    set_setting(db, M.ENABLED_KEY, "1", None)
    rec = db.query(CrawlPrice).filter(CrawlPrice.crawl_date == date(2026, 11, 10)).one()
    rec.raw = {"source": "ocr", "parsed": {"price": 1360}}
    db.commit()
    row = _run(db, _sku(db))
    assert row.stage in (AutoListingStage.READY, AutoListingStage.WAIT_NEGOTIATION)
