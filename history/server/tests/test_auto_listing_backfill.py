"""存量在库货补价补图（hold_publish）。

红线：
  1. 存量回填绝不发布——就算给了 publish、就算议价过了；
  2. 没实拍图不文生图，让图片爬虫按型号搜，搜不到才转人工「缺图」；
  3. 人工已经填过的上架价和图不覆盖；
  4. 已经在店铺挂着的、锁定的、不在库的货不登记。
"""

from datetime import datetime
from decimal import Decimal

import pytest

from app.enums import AutoListingStage, ListingInfoStatus, ShopListingStatus, SkuStatus
from app.models import (
    AiRedrawJob,
    CrawlProduct,
    SaleShop,
    Sku,
    SkuAutoListing,
    SkuListingInfo,
    SkuShopListing,
    SpuImageSearch,
    WarehouseSpu,
)
from app.routers import auto_listing as api
from app.services.auto_listing.backfill import run_backfill
from app.services import product_image
from app.services.auto_listing.pipeline import HELD_READY, HELD_READY_CRAWLED, MISSING_PHOTO, advance


def _sku(db, code="M-001", **kw):
    base = dict(
        sku_code=code, purchase_order_id="p", inspection_id="i",
        product_name="小米空气净化器", brand="小米", model="空气净化器4PRO",
        cost_price=Decimal("900"), status=SkuStatus.IN_STOCK,
        images=["https://oss/a.jpg"], negotiated_at=None,
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


def _row(db, sku):
    return db.query(SkuAutoListing).filter_by(sku_id=sku.id).one()


def test_备好的停在待人工上架_没议价也不卡(db):
    sku = _sku(db)
    db.commit()
    r = run_backfill(db, dry_run=False)
    row = _row(db, sku)
    assert r["outcomes"] == {"ready": 1}
    assert row.hold_publish and row.stage == AutoListingStage.READY
    assert row.last_error == HELD_READY and row.next_run_at is None, "挂起，worker 不再捡"
    info = db.query(SkuListingInfo).filter_by(sku_id=sku.id).one()
    assert info.price == Decimal("1360.00") and info.images == ["https://oss/a.jpg"]
    assert info.status == ListingInfoStatus.READY


def test_绝不发布_就算给了publish也议价过了(db):
    sku = _sku(db, negotiated_at=datetime.utcnow())
    db.commit()
    run_backfill(db, dry_run=False)
    row = _row(db, sku)
    published = []
    for _ in range(5):
        advance(db, row, publish=lambda *a: published.append(1) or "job-1")
        db.commit()
    assert published == []
    assert row.stage == AutoListingStage.READY and row.gc_job_id is None


def test_没配爬虫就转人工缺图_不文生图(db):
    sku = _sku(db, images=[])
    db.commit()
    r = run_backfill(db, dry_run=False)
    row = _row(db, sku)
    assert r["outcomes"] == {"missing_photo": 1}
    assert row.stage == AutoListingStage.NEEDS_HUMAN
    assert row.last_error.startswith(MISSING_PHOTO) and "1360" in row.last_error, "缺图时顺带写上行情价"
    assert db.query(AiRedrawJob).count() == 0


@pytest.fixture()
def crawler(monkeypatch):
    """假的图片爬虫：发起搜图只在库里记一行 SEARCHING，不连网。"""
    asked = []

    def request_for_spu(db, spu, *, force=False):
        row = db.query(SpuImageSearch).filter_by(spu_id=spu.id).first()
        if row is None:
            row = SpuImageSearch(spu_id=spu.id, query=spu.brand_model, status=SpuImageSearch.SEARCHING)
            db.add(row)
            db.flush()
            asked.append(spu.brand_model)
        return row

    monkeypatch.setattr(product_image, "enabled", lambda: True)
    monkeypatch.setattr(product_image, "request_for_spu", request_for_spu)
    return asked


def test_缺图让爬虫按型号搜_搜到直接用(db, crawler):
    sku = _sku(db, images=[])
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert crawler == ["小米 空气净化器4PRO"]
    assert r["outcomes"] == {"waiting_image": 1}
    assert db.query(AiRedrawJob).count() == 0

    search = db.query(SpuImageSearch).one()
    search.status = SpuImageSearch.REVIEWING
    search.pool_images = [{"url": "https://oss/spu-ref/1.jpg"}, {"url": "https://oss/spu-ref/2.jpg"}]
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["outcomes"] == {"ready_crawled": 1}
    assert _row(db, sku).last_error == HELD_READY_CRAWLED
    info = db.query(SkuListingInfo).filter_by(sku_id=sku.id).one()
    assert info.images == ["https://oss/spu-ref/1.jpg", "https://oss/spu-ref/2.jpg"]


def test_爬虫图带水印海报的不拿去上架(db, crawler):
    sku = _sku(db, images=[])
    db.commit()
    run_backfill(db, dry_run=False)
    search = db.query(SpuImageSearch).one()
    search.status = SpuImageSearch.READY
    search.pool_images = [
        {"url": "https://oss/spu-ref/good.jpg", "quality_grade": "good"},
        {"url": "https://oss/spu-ref/wm.jpg", "quality_grade": "bad", "quality_flags": ["水印"]},
        {"url": "https://oss/spu-ref/old.jpg"},  # 老任务没评过,当能用
    ]
    db.commit()
    run_backfill(db, dry_run=False)
    info = db.query(SkuListingInfo).filter_by(sku_id=sku.id).one()
    assert info.images == ["https://oss/spu-ref/good.jpg", "https://oss/spu-ref/old.jpg"]


def test_爬虫图全是坏图就要拍照(db, crawler):
    sku = _sku(db, images=[])
    db.commit()
    run_backfill(db, dry_run=False)
    search = db.query(SpuImageSearch).one()
    search.status = SpuImageSearch.READY
    search.reference_url = "https://oss/spu-ref/ref.jpg"
    search.pool_images = [{"url": "https://oss/spu-ref/wm.jpg", "quality_grade": "bad", "quality_flags": ["水印"]}]
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["outcomes"] == {"missing_photo": 1}
    assert "水印" in _row(db, sku).last_error


def test_员工淘汰的和像截图的爬虫图不拿去上架(db, crawler):
    from app.services import image_material

    sku = _sku(db, images=[])
    db.commit()
    run_backfill(db, dry_run=False)
    search = db.query(SpuImageSearch).one()
    search.status = SpuImageSearch.READY
    search.pool_images = [
        {"url": "https://oss/spu-ref/a.jpg", "quality_grade": "good"},
        {"url": "https://oss/spu-ref/shot.jpg", "width": 1080, "height": 2340,
         "quality_grade": "bad", "quality_flags": ["海报字"]},
        {"url": "https://oss/spu-ref/b.jpg", "quality_grade": "ok"},
    ]
    image_material.set_mark(db, "https://oss/spu-ref/a.jpg", "rejected", reason="不是这个型号")
    db.commit()
    run_backfill(db, dry_run=False)
    info = db.query(SkuListingInfo).filter_by(sku_id=sku.id).one()
    assert info.images == ["https://oss/spu-ref/b.jpg"]


def test_一次性重查_换掉自动填的坏图_人改过的不碰(db, crawler):
    from app.services.auto_listing.backfill import recheck_crawled_images

    a = _sku(db, "M-1", images=[])
    db.commit()
    run_backfill(db, dry_run=False)
    search = db.query(SpuImageSearch).one()
    search.status = SpuImageSearch.READY
    search.pool_images = [{"url": "https://oss/spu-ref/wm.jpg"}, {"url": "https://oss/spu-ref/good.jpg"}]
    db.commit()
    run_backfill(db, dry_run=False)
    info = db.query(SkuListingInfo).filter_by(sku_id=a.id).one()
    assert info.images == ["https://oss/spu-ref/wm.jpg", "https://oss/spu-ref/good.jpg"]

    # 爬虫补了质量分
    search.pool_images = [{"url": "https://oss/spu-ref/good.jpg", "quality_grade": "good"},
                          {"url": "https://oss/spu-ref/wm.jpg", "quality_grade": "bad", "quality_flags": ["水印"]}]
    db.commit()
    assert recheck_crawled_images(db)["replaced"] == 1 and info.images[0].endswith("wm.jpg"), "预演不改"
    r = recheck_crawled_images(db, dry_run=False)
    assert r["replaced"] == 1
    db.refresh(info)
    assert info.images == ["https://oss/spu-ref/good.jpg"] and _row(db, a).last_error == HELD_READY_CRAWLED

    info.images = ["https://oss/hand/1.jpg"]  # 人换过图
    db.commit()
    assert recheck_crawled_images(db, dry_run=False)["edited_by_hand"] == 1
    db.refresh(info)
    assert info.images == ["https://oss/hand/1.jpg"]


def test_同型号多件只搜一次(db, crawler):
    _sku(db, "M-1", images=[])
    _sku(db, "M-2", images=[])
    db.commit()
    run_backfill(db, dry_run=False)
    assert crawler == ["小米 空气净化器4PRO"]


def test_爬虫图被标需处理就转人工缺图(db, crawler):
    sku = _sku(db, images=[])
    db.commit()
    run_backfill(db, dry_run=False)
    db.query(SpuImageSearch).one().status = SpuImageSearch.REJECTED
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["outcomes"] == {"missing_photo": 1}
    assert "需处理" in _row(db, sku).last_error


def test_有实拍图就不叫爬虫(db, crawler):
    _sku(db)
    db.commit()
    run_backfill(db, dry_run=False)
    assert crawler == []


def test_行情低于成本单独计数_看板标红(db):
    _sku(db, cost_price=Decimal("2000"))
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["outcomes"] == {"below_cost": 1}
    item = api.list_rows(stage=None, q=None, issue=None, db=db, _=None, page=1, page_size=50).items[0]
    assert item.issue == "below_cost" and item.below_cost is True


def test_认不出型号填了目录里有的_当场备好(db):
    sku = _sku(db, brand="杂牌", model="不知道", product_name="一台净化器")
    db.commit()
    run_backfill(db, dry_run=False)
    row = _row(db, sku)
    page = api.list_rows(stage=None, q=None, issue="unresolved", db=db, _=None, page=1, page_size=50)
    assert page.total == 1
    out = api.identify_row(row.id, api.IdentifyIn(brand="小米", model="空气净化器4PRO"), db=db, _=None)
    assert out.in_catalog is True and out.row.issue == "ready"
    assert sku.brand == "小米" and sku.model == "空气净化器4PRO"


def test_认不出型号填了目录里也没有_告诉人去加(db):
    sku = _sku(db, brand="杂牌", model="不知道", product_name="一台净化器")
    db.commit()
    run_backfill(db, dry_run=False)
    out = api.identify_row(_row(db, sku).id, api.IdentifyIn(brand="杂牌", model="X100"), db=db, _=None)
    assert out.in_catalog is False and out.row.issue == "unresolved"


def test_不是认不出型号的行不让填(db):
    from fastapi import HTTPException

    sku = _sku(db)
    db.commit()
    run_backfill(db, dry_run=False)
    with pytest.raises(HTTPException):
        api.identify_row(_row(db, sku).id, api.IdentifyIn(brand="小米", model="X"), db=db, _=None)


def test_人工填过的价和图不覆盖(db):
    sku = _sku(db)
    db.add(SkuListingInfo(sku_id=sku.id, price=Decimal("1500"), images=["https://oss/人工.jpg"],
                          status=ListingInfoStatus.PUBLISHED))
    db.commit()
    run_backfill(db, dry_run=False)
    info = db.query(SkuListingInfo).filter_by(sku_id=sku.id).one()
    assert info.price == Decimal("1500") and info.images == ["https://oss/人工.jpg"]
    assert info.status == ListingInfoStatus.PUBLISHED, "已经走到发布的状态不往回改"


def test_没实拍但人工上架信息里有图_算有图(db):
    sku = _sku(db, images=[])
    db.add(SkuListingInfo(sku_id=sku.id, images=["https://oss/人工.jpg"]))
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["outcomes"] == {"ready": 1}


def test_没行情价就等_拿到价再点一次就备好(db):
    sku = _sku(db, brand="华为", model="MateBook14")
    db.add(WarehouseSpu(spu_code="90000700", brand="华为", model="MateBook14"))
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["watch_created"] == 1, "在库型号顺手同步进行情监控清单"
    assert r["outcomes"] == {"waiting_price": 1}
    assert _row(db, sku).stage == AutoListingStage.COLLECTING

    db.query(CrawlProduct).filter_by(name="华为 MateBook14").one().last_price = Decimal("3000")
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["new"] == 0 and r["rerun"] == 1
    assert r["outcomes"] == {"ready": 1}


def test_补了图再点一次就备好(db):
    sku = _sku(db, images=[])
    db.commit()
    run_backfill(db, dry_run=False)
    sku.images = ["https://oss/补拍.jpg"]
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["rerun"] == 1 and r["outcomes"] == {"ready": 1}


def test_解析不出型号单独计数(db):
    _sku(db, brand="杂牌", model="不存在的型号", product_name="不知道是啥")
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["outcomes"] == {"unresolved": 1}


def test_只登记没挂着_没锁定_在库_没进过流水线的(db):
    shop = SaleShop(code="S1", label="店1", xianyu_user_name="n")
    db.add(shop)
    listed = _sku(db, "M-LISTED")
    db.flush()
    db.add(SkuShopListing(sku_id=listed.id, sale_shop_id=shop.id, publish_status=ShopListingStatus.LISTED))
    _sku(db, "M-LOCKED", reserve_source="SALE")
    _sku(db, "M-SHIPPED", status=SkuStatus.SHIPPED)
    old = _sku(db, "M-OLD")
    db.add(SkuAutoListing(sku_id=old.id, stage=AutoListingStage.DONE))
    ok = _sku(db, "M-OK")
    db.commit()
    r = run_backfill(db, dry_run=False)
    assert r["new"] == 1
    assert db.query(SkuAutoListing).filter_by(hold_publish=True).one().sku_id == ok.id


def test_试算只数不动(db):
    _sku(db)
    db.commit()
    r = run_backfill(db, dry_run=True)
    assert r["dry_run"] and r["new"] == 1 and r["outcomes"] == {}
    assert db.query(SkuAutoListing).count() == 0


def test_看板行带存量标记(db):
    sku = _sku(db)
    db.commit()
    run_backfill(db, dry_run=False)
    page = api.list_rows(stage=None, q=None, issue=None, db=db, _=None, page=1, page_size=50)
    assert page.items[0].hold_publish is True


def test_新入库登记的行默认不是存量(db):
    """hold_publish 默认关：入库登记的行还走原来的逻辑。"""
    from app.services.auto_listing.pipeline import enqueue

    sku = _sku(db, images=[])
    row = enqueue(db, sku)
    db.commit()
    assert row.hold_publish is False


def _listed(db, sku):
    shop = db.query(SaleShop).filter_by(code="S1").first()
    if shop is None:
        shop = SaleShop(code="S1", label="店1", xianyu_user_name="n")
        db.add(shop)
        db.flush()
    db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, publish_status=ShopListingStatus.LISTED))


def _stuck_inbound(db, sku):
    row = SkuAutoListing(sku_id=sku.id, stage=AutoListingStage.NEEDS_HUMAN,
                         last_error="解析不出所属 SPU（品牌/型号不在对照表里）")
    db.add(row)
    return row


def test_入库时认不出型号又没上架的_改成存量行(db):
    from app.services.auto_listing.backfill import adopt_unresolved_inbound

    free = _stuck_inbound(db, _sku(db, "M-FREE", brand=None, model=None, product_name="gpw3"))
    on_sale = _sku(db, "M-ONSALE", brand=None, model=None, product_name="gpw3")
    sale_row = _stuck_inbound(db, on_sale)
    _listed(db, on_sale)
    locked = _stuck_inbound(db, _sku(db, "M-LOCK", brand=None, model=None, reserve_source="SALE"))
    other = SkuAutoListing(sku_id=_sku(db, "M-COST", cost_price=Decimal("2000")).id,
                           stage=AutoListingStage.NEEDS_HUMAN, last_error="不自动定价：market_below_cost")
    db.add(other)
    db.commit()

    assert [r.id for r in adopt_unresolved_inbound(db, dry_run=True)] == [free.id]
    assert free.hold_publish is False, "预演不动库"
    adopt_unresolved_inbound(db, dry_run=False)
    assert free.hold_publish is True
    assert not sale_row.hold_publish and not locked.hold_publish and not other.hold_publish


def test_在卖的货不进填型号弹窗_也不让填(db):
    from fastapi import HTTPException

    on_sale = _sku(db, "M-ONSALE", brand=None, model=None, product_name="gpw3")
    row = _stuck_inbound(db, on_sale)
    _listed(db, on_sale)
    free = _sku(db, "M-FREE", brand=None, model=None, product_name="gpw3")
    _stuck_inbound(db, free)
    db.commit()
    page = api.list_rows(stage=None, q=None, issue="unresolved", db=db, _=None, page=1, page_size=50)
    assert [i.sku_code for i in page.items] == ["M-FREE"]
    with pytest.raises(HTTPException):
        api.identify_row(row.id, api.IdentifyIn(brand="小米", model="空气净化器4PRO"), db=db, _=None)
    assert on_sale.brand is None, "在卖的货不改"
