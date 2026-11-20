"""入库后自动上架流水线的阶段推进。

红线（错了会真金白银出事）：
  1. 议价是硬闸门——没议价绝不发布；
  2. 行情倒挂绝不自动发（按行情价 + 全自动 = 自动亏本挂货）；
  3. 解析不出的宁可停下，不许猜到别款上；
  4. 只用产品实拍图，绝不把库位图/议价证据发上闲鱼。
"""

from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.enums import AutoListingStage, ListingInfoStatus, ShopListingStatus, SkuStatus
from app.models import (
    CrawlProduct,
    SaleShop,
    Sku,
    SkuAutoListing,
    SkuListingInfo,
    SkuShopListing,
    WarehouseSpu,
)
from app.services.auto_listing.pipeline import COLLECT_TIMEOUT, MAX_ATTEMPTS, advance, enqueue


def _sku(db, **kw):
    base = dict(
        sku_code="M20260908-001", purchase_order_id="p", inspection_id="i",
        product_name="小米空气净化器", brand="小米", model="空气净化器4PRO",
        cost_price=Decimal("900"), status=SkuStatus.IN_STOCK,
        images=["https://oss/a.jpg", "https://oss/b.jpg"],
        location_images=["https://oss/库位.jpg"],
        negotiation_media=["https://oss/议价证据.jpg"],
        negotiated_at=datetime.utcnow(),
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


def _run(db, sku, publish=None, times=6):
    row = enqueue(db, sku)
    db.commit()
    for _ in range(times):
        before = row.stage
        advance(db, row, publish=publish)
        db.commit()
        if row.stage == before and row.stage not in (AutoListingStage.RESOLVING,):
            break
    return row


# ---------------------------------------------------------------- 登记

def test_登记幂等(db):
    sku = _sku(db)
    a = enqueue(db, sku); db.commit()
    b = enqueue(db, sku); db.commit()
    assert a.id == b.id
    assert db.query(SkuAutoListing).count() == 1


# ---------------------------------------------------------------- 正常流转

def test_已议价的一路走到待发布(db):
    sku = _sku(db)
    row = _run(db, sku)
    assert row.stage == AutoListingStage.READY
    assert row.match_how == "brand_model" and row.spu_query == "小米 空气净化器4PRO"
    assert row.market_price == Decimal("1360.00")
    assert row.resolved_price == Decimal("1360.00"), "售价就是行情价，不乘系数"


def test_写出的上架信息与人工填的同构(db):
    sku = _sku(db)
    _run(db, sku)
    info = db.query(SkuListingInfo).filter_by(sku_id=sku.id).one()
    assert info.status == ListingInfoStatus.READY
    assert info.price == Decimal("1360.00")
    assert info.images == ["https://oss/a.jpg", "https://oss/b.jpg"]
    assert sku.short_code, "进入上架流程要分配短编码"


def test_绝不把库位图和议价证据发出去(db):
    sku = _sku(db)
    _run(db, sku)
    imgs = db.query(SkuListingInfo).filter_by(sku_id=sku.id).one().images
    assert all("库位" not in u and "议价" not in u for u in imgs), imgs


# ---------------------------------------------------------------- 议价闸门

def test_没议价停在门闩上绝不发布(db):
    sku = _sku(db, negotiated_at=None)
    published = []
    row = _run(db, sku, publish=lambda *a: published.append(1) or "job-1")
    assert row.stage == AutoListingStage.WAIT_NEGOTIATION
    assert published == [], "没议价绝不允许发布"


def test_议价完成后自动放行(db):
    sku = _sku(db, negotiated_at=None)
    row = _run(db, sku)
    assert row.stage == AutoListingStage.WAIT_NEGOTIATION
    sku.negotiated_at = datetime.utcnow()      # 人工议价完成
    db.commit()
    advance(db, row); db.commit()
    assert row.stage == AutoListingStage.READY


def test_等议价不计入重试次数(db):
    """等人不是失败，不能把人等到 NEEDS_HUMAN 去。"""
    sku = _sku(db, negotiated_at=None)
    row = _run(db, sku)
    for _ in range(MAX_ATTEMPTS + 3):
        advance(db, row); db.commit()
    assert row.stage == AutoListingStage.WAIT_NEGOTIATION
    assert row.attempts == 0


# ---------------------------------------------------------------- 定价闸门

def test_行情倒挂转人工不亏本挂(db):
    sku = _sku(db, cost_price=Decimal("2000"))   # 成本 2000 > 行情 1360
    row = _run(db, sku)
    assert row.stage == AutoListingStage.NEEDS_HUMAN
    assert "market_below_cost" in row.last_error
    assert db.query(SkuListingInfo).count() == 0, "不该写出上架信息"


def test_没有行情价先退避再超期转人工(db):
    db.query(CrawlProduct).delete(); db.commit()
    sku = _sku(db)
    row = _run(db, sku)
    assert row.stage == AutoListingStage.COLLECTING
    assert row.attempts >= 1 and row.next_run_at > datetime.utcnow()

    row.collecting_since = datetime.utcnow() - COLLECT_TIMEOUT - timedelta(hours=1)
    db.commit()
    advance(db, row); db.commit()
    assert row.stage == AutoListingStage.NEEDS_HUMAN
    assert "超期" in row.last_error


def test_没有实拍图又不生图就不发布(db, monkeypatch):
    """生图关掉时退回老行为：停在 COLLECTING，绝不空着图往外发。

    生图开着时是「等出图」，那条路径在 test_auto_listing_images.py 里盯。
    """
    monkeypatch.setattr(
        "app.services.auto_listing.images.settings.auto_listing_generate_images",
        False, raising=False,
    )
    sku = _sku(db, images=[])
    row = _run(db, sku)
    assert row.stage == AutoListingStage.COLLECTING
    assert "实拍图" in row.last_error


# ---------------------------------------------------------------- 解析闸门

def test_解析不出转人工不猜(db):
    sku = _sku(db, brand="没见过", model="没见过", barcode=None)
    row = _run(db, sku)
    assert row.stage == AutoListingStage.NEEDS_HUMAN
    assert "SPU" in row.last_error


# ---------------------------------------------------------------- 发布与收尾

def test_发布建作业后进入等回写(db):
    sku = _sku(db)
    row = _run(db, sku, publish=lambda db_, s, i: "gc-job-9")
    assert row.stage == AutoListingStage.PUBLISHING and row.gc_job_id == "gc-job-9"


def test_发布失败退避重试并留原因(db):
    sku = _sku(db)

    def boom(*a):
        raise RuntimeError("群控账号未绑定设备")

    row = _run(db, sku, publish=boom)
    assert row.stage == AutoListingStage.READY
    assert "群控账号未绑定设备" in row.last_error and row.attempts >= 1


def test_任一店铺在架即完成(db):
    sku = _sku(db)
    row = _run(db, sku, publish=lambda *a: "gc-job-9")
    shop = SaleShop(code="S1", label="店1", xianyu_user_name="n")
    db.add(shop); db.flush()
    db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id,
                          publish_status=ShopListingStatus.LISTED))
    db.commit()
    advance(db, row); db.commit()
    assert row.stage == AutoListingStage.DONE and row.published_at is not None


def test_人工已发过就让路不重复发(db):
    """人工上架路径一直开着：人先手工发了，流水线直接收尾，别再撞一次「已在架」。"""
    sku = _sku(db)
    row = _run(db, sku)
    assert row.stage == AutoListingStage.READY
    shop = SaleShop(code="S1", label="店1", xianyu_user_name="n")
    db.add(shop); db.flush()
    db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id,
                          publish_status=ShopListingStatus.LISTED))
    db.commit()

    published = []
    advance(db, row, publish=lambda *a: published.append(1) or "job-x")
    db.commit()
    assert row.stage == AutoListingStage.DONE and published == []


# ---------------------------------------------------------------- 状态守卫

@pytest.mark.parametrize("kw", [
    {"status": SkuStatus.SHIPPED},
    {"status": SkuStatus.RESERVED},
    {"reserve_source": "SWITCH"},
])
def test_已出库或锁定的货不再自动上架(db, kw):
    sku = _sku(db, **kw)
    row = _run(db, sku)
    assert row.stage == AutoListingStage.NEEDS_HUMAN
    assert "可上架状态" in row.last_error


def test_开了上架审批就等批准不算失败(db):
    """11-03 起：价和每个号的图批过才发。等人批跟等议价一样，不计重试、不转人工。"""
    from app.services import listing_approval as la
    from app.services.app_settings import set_setting

    set_setting(db, la.REQUIRED_KEY, "1", None)
    db.commit()
    sku = _sku(db)
    row = _run(db, sku, publish=lambda *a: pytest.fail("没批准不该发布"))
    assert row.stage == AutoListingStage.READY and row.attempts == 0
    assert "等上架审批" in row.last_error
