"""行情监控清单按在库 SPU 同步。

生产的监控清单有 7868 条，7719 条是搜不到行情的冷门 AOC 型号码，
真正在库的型号反而淹在里面。改成按库存驱动后清单收敛到百来个。

红线：**不许删行**。crawl_price 的历史挂在 product_id 上，
删监控项会把历史行情一起 cascade 掉；下架只能停用。
"""

from datetime import date

import pytest

from app.enums import SkuStatus
from app.models import CrawlPrice, CrawlProduct, Sku, WarehouseSpu
from app.services.spu_market_sync import SYNC_NOTE, stock_spu_queries, sync_watchlist


def _sku(code, brand, model, status=SkuStatus.IN_STOCK, barcode=None):
    return Sku(
        sku_code=code, purchase_order_id="p", inspection_id="i", product_name="x",
        cost_price=100, status=status, brand=brand, model=model, barcode=barcode,
    )


@pytest.fixture()
def db(db_session):
    db_session.add_all([
        WarehouseSpu(spu_code="90000638", brand="小米", model="空气净化器4PRO"),
        WarehouseSpu(spu_code="6940017323126", brand="HKC", model="G24H3D"),
        WarehouseSpu(spu_code="90000430", brand="盛色", model="G7"),
    ])
    db_session.add_all([
        _sku("M-1", "小米", "空气净化器4PRO"),
        _sku("M-2", "小米", "空气净化器4PRO"),          # 同款两件 → 清单只一条
        _sku("M-3", "HKC", "G24H3D"),
        _sku("M-4", "盛色", "G7", status=SkuStatus.SHIPPED),  # 已出库不算库存
        _sku("M-5", "没见过", "没见过"),                  # 解析不出
    ])
    db_session.commit()
    return db_session


def test_只取在库且能解析的SPU(db):
    queries, unresolved = stock_spu_queries(db)
    assert set(queries) == {"小米 空气净化器4PRO", "HKC G24H3D"}   # 出库的盛色不在内
    assert [s.sku_code for s in unresolved] == ["M-5"]


def test_同款多件只建一条监控(db):
    r = sync_watchlist(db)
    assert r["created"] == 2 and r["stock_spu_count"] == 2
    assert db.query(CrawlProduct).count() == 2


def test_搜索词用品牌加型号(db):
    sync_watchlist(db)
    row = db.query(CrawlProduct).filter_by(name="HKC G24H3D").one()
    assert row.keyword == "HKC G24H3D" and row.enabled is True and row.note == SYNC_NOTE


def test_重复同步幂等(db):
    sync_watchlist(db)
    r = sync_watchlist(db)
    assert (r["created"], r["kept"]) == (0, 2)
    assert db.query(CrawlProduct).count() == 2


def test_dry_run不落库(db):
    r = sync_watchlist(db, dry_run=True)
    assert r["created"] == 2 and r["dry_run"] is True
    assert db.query(CrawlProduct).count() == 0


def test_停用的监控项会被重新启用(db):
    """上一轮没库存被停用，这轮又进货了，要能自己回来。"""
    db.add(CrawlProduct(name="HKC G24H3D", keyword="HKC G24H3D", enabled=False))
    db.commit()
    r = sync_watchlist(db)
    assert r["reenabled"] == 1
    assert db.query(CrawlProduct).filter_by(name="HKC G24H3D").one().enabled is True


def test_停用冷门码而不是删除(db):
    """7719 条冷门码要下线，但历史行情不能跟着没。"""
    junk = CrawlProduct(name="T2254", keyword="T2254", enabled=True)
    db.add(junk)
    db.flush()
    db.add(CrawlPrice(product_id=junk.id, crawl_date=date(2026, 9, 1), price=100))
    db.commit()

    r = sync_watchlist(db, disable_stale=True)
    assert r["disabled"] == 1
    row = db.query(CrawlProduct).filter_by(name="T2254").one()
    assert row.enabled is False, "应停用"
    assert db.query(CrawlPrice).filter_by(product_id=row.id).count() == 1, "历史行情必须还在"


def test_默认不停用任何东西(db):
    """disable_stale 必须显式开——默认就把别人手工加的监控停了是事故。"""
    db.add(CrawlProduct(name="手工加的", keyword="手工加的", enabled=True))
    db.commit()
    r = sync_watchlist(db)
    assert r["disabled"] == 0
    assert db.query(CrawlProduct).filter_by(name="手工加的").one().enabled is True


def test_解析不出的会被报告出来(db):
    r = sync_watchlist(db)
    assert r["unresolved_sku_count"] == 1
    assert r["unresolved_samples"][0]["sku_code"] == "M-5"
