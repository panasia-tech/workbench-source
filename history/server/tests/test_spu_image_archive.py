"""SPU 共享同款图库:审核通过整池归档、按型号共享、上架页可读(2026-11-11)。"""
from decimal import Decimal
from types import SimpleNamespace

from app.enums import ListingInfoStatus, SkuStatus
from app.models import (
    SaleShop,
    Sku,
    SkuListingInfo,
    SpuImageSearch,
    WarehouseSpu,
    WarehouseSpuImage,
)
from app.services import shop_images as SI
from app.services import spu_image_archive as A
from app.services.spu_resolve import MATCH_BRAND_MODEL


POOL = [
    {"url": "https://oss.example.com/spu-ref/1/pool/a.jpg", "crawler_url": "c1",
     "source_url": "https://source/1", "width": 1200, "height": 900,
     "quality_grade": "good", "quality_score": 91, "product_confidence": 0.9, "score": 99},
    {"url": "https://oss.example.com/spu-ref/1/pool/b.jpg", "crawler_url": "c2",
     "source_url": "https://source/2", "width": 1000, "height": 800},
]


def _spu(db, code="1", brand="AOC", model="24G2Z"):
    spu = WarehouseSpu(spu_code=code, brand=brand, model=model, enabled=True)
    db.add(spu)
    db.flush()
    return spu


def _sku(db, spu, code="SK1"):
    sku = Sku(
        sku_code=code, product_name="显示器", purchase_order_id="po-" + code,
        inspection_id="in-" + code, cost_price=Decimal("1000"),
        status=SkuStatus.IN_STOCK, images=["oss/real.jpg"],
    )
    db.add(sku)
    db.flush()
    db.add(SkuListingInfo(sku_id=sku.id, images=["oss/real.jpg"], status=ListingInfoStatus.READY))
    return sku


def _search(db, spu, pool=None, status=SpuImageSearch.READY):
    row = SpuImageSearch(spu_id=spu.id, query=spu.brand_model, status=status,
                         pool_images=list(pool or POOL), formal_count=len(pool or POOL))
    db.add(row)
    db.flush()
    return row


def test_upsert_from_pool_is_idempotent_and_marks_cover(db_session):
    spu = _spu(db_session)
    row = _search(db_session, spu)

    assert A.upsert_from_pool(
        db_session, spu, row, approved=True, cover_crawler_url="c2"
    ) == 2
    assert row.archive_count == 2
    assert db_session.query(WarehouseSpuImage).count() == 2
    cover = db_session.query(WarehouseSpuImage).filter_by(is_cover=True).one()
    assert cover.url.endswith("/b.jpg") and cover.crawler_task_id is None

    # 重复跑不会重复插入,主图跟随最新选择
    assert A.upsert_from_pool(
        db_session, spu, row, approved=True, cover_crawler_url="c1"
    ) == 2
    assert db_session.query(WarehouseSpuImage).count() == 2
    cover = db_session.query(WarehouseSpuImage).filter_by(is_cover=True).one()
    assert cover.url.endswith("/a.jpg")


def test_upsert_from_pool_requires_approved(db_session):
    spu = _spu(db_session)
    row = _search(db_session, spu)

    assert A.upsert_from_pool(db_session, spu, row) == 0
    assert db_session.query(WarehouseSpuImage).count() == 0
    assert A.upsert_from_pool(db_session, spu, row, approved=True) == 2


def test_same_brand_model_spus_share_archive_but_different_model_does_not(db_session):
    spu1 = _spu(db_session, code="1")
    spu2 = _spu(db_session, code="2")          # 同品牌同型号,不同 SPU 编码
    other = _spu(db_session, code="3", brand="LG", model="27GP850")
    row = _search(db_session, spu1)
    A.upsert_from_pool(db_session, spu1, row, approved=True)

    shared = A.images_for_spu(db_session, spu2)
    assert [p["url"] for p in shared] == [p["url"] for p in POOL]
    assert A.images_for_spu(db_session, other) == []


def test_needs_changes_rejects_task_rows(db_session):
    spu = _spu(db_session)
    row = _search(db_session, spu)
    row.task_id = "task-1"
    db_session.flush()
    A.upsert_from_pool(db_session, spu, row, approved=True)

    assert A.mark_task_rejected(db_session, "task-1") == 2
    assert A.images_for_spu(db_session, spu) == []


def test_rebuild_from_pool_reads_ready_rows_without_network(db_session):
    spu = _spu(db_session)
    _search(db_session, spu)
    waiting = _spu(db_session, code="2", model="N50PRO6")
    _search(db_session, waiting, status=SpuImageSearch.REVIEWING)

    result = A.rebuild_from_pool(db_session)
    assert result == {"spus": 1, "images": 2, "skipped": 0}
    assert db_session.query(WarehouseSpuImage).count() == 2


def test_options_expose_preview_kind_and_archive_count(db_session, monkeypatch):
    spu = _spu(db_session)
    sku = _sku(db_session, spu)
    row = _search(db_session, spu)
    A.upsert_from_pool(db_session, spu, row, approved=True)
    db_session.add(SaleShop(code="s1", label="店1", xianyu_user_name="甲", enabled=True, sort_order=0))
    db_session.commit()

    monkeypatch.setattr(
        SI, "resolve_spu",
        lambda db, sku: SimpleNamespace(matched=True, spu=spu, how=MATCH_BRAND_MODEL, ambiguous=1),
    )
    monkeypatch.setattr(SI, "sign_oss_thumb_url", lambda u, **kw: f"thumb:{u}")
    monkeypatch.setattr(SI, "sign_oss_publish_image_url", lambda u, **kw: f"preview:{u}")

    opts = SI.options(db_session, sku)
    assert opts["crawl_status"] == "已合格"
    assert opts["archive_count"] == 2
    assert opts["photos"][0]["kind"] == "实拍"
    assert opts["photos"][0]["preview"].startswith("preview:")
    assert opts["crawled"][0]["kind"] == "同款"
    assert opts["crawled"][0]["preview"].startswith("preview:")
    assert opts["crawled"][0]["approved"] is True
    assert opts["spu_match"]["spu_code"] == spu.spu_code
