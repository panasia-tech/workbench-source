"""上架前按店铺选图(2026-11-05):勾了几个店铺,员工就给每个店铺挑一组图,店铺之间不能重复。

钉死的口径:
  1. 候选 = 这件货自己的图 + 爬虫转存的同款正式图;员工标了「需处理」的爬虫图不给。
  2. 每个店铺都要有图;只能用候选里的图;同一张图不能给两个店铺。
  3. 一个号一个作业,发自己那组图;图记在店铺行上,链接焕新重发也用它。
"""
import asyncio
from decimal import Decimal
from types import SimpleNamespace

import pytest

import app.services.gc_bridge.assembler as ASM
import app.services.gc_bridge.listing_ops as L
import app.services.shop_images as SI
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing, SpuImageSearch, WarehouseSpu
from app.services.gc_bridge import listing_refresh as LR

POOL = [{"url": "https://oss.example.com/spu-ref/9/pool/p1.webp", "crawler_url": "c1", "source_url": "s1"},
        {"url": "https://oss.example.com/spu-ref/9/pool/p2.jpg", "crawler_url": "c2", "source_url": "s2"}]


@pytest.fixture(autouse=True)
def _no_oss(monkeypatch):
    monkeypatch.setattr(ASM, "sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr("app.services.oss_media.sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr(LR, "sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr(SI, "sign_oss_thumb_url", lambda u, **kw: f"thumb:{u}")
    monkeypatch.setattr(SI, "sign_oss_publish_image_url", lambda u, expires=86400: u)


@pytest.fixture()
def w(db_session, monkeypatch):
    db = db_session
    spu = WarehouseSpu(spu_code="9", brand="AOC", model="24G2Z", enabled=True)
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1000"), status=SkuStatus.IN_STOCK, images=["oss/a.jpg", "oss/b.jpg"])
    s1 = SaleShop(code="s1", label="店1", xianyu_user_name="甲", enabled=True, sort_order=0, gc_account_id="acc1")
    s2 = SaleShop(code="s2", label="店2", xianyu_user_name="乙", enabled=True, sort_order=1, gc_account_id="acc2")
    db.add_all([spu, sku, s1, s2])
    db.flush()
    db.add(SkuListingInfo(sku_id=sku.id, images=["oss/a.jpg", "oss/b.jpg"], status=ListingInfoStatus.READY))
    search = SpuImageSearch(spu_id=spu.id, query="AOC 24G2Z", status=SpuImageSearch.READY, pool_images=POOL)
    db.add(search)
    db.commit()
    monkeypatch.setattr(SI, "resolve_spu", lambda db, sku: SimpleNamespace(matched=True, spu=spu))
    return SimpleNamespace(db=db, sku=sku, s1=s1, s2=s2, search=search,
                           info=db.query(SkuListingInfo).one())


def _mock_gc(monkeypatch):
    calls = []

    async def noop(db):
        return None

    async def get_account(aid):
        return {"id": aid, "nick": {"acc1": "甲", "acc2": "乙"}[aid], "device_id": "d"}

    async def create_publish_job(sku, account_ids, spec, source="ERP", worry_free_by_account=None):
        calls.append({"accounts": account_ids, "spec": spec})
        return {"id": f"job-{len(calls)}"}

    async def list_devices():
        return []

    monkeypatch.setattr(L, "sync_gc_shops", noop)
    monkeypatch.setattr(L.gc, "get_account", get_account)
    monkeypatch.setattr(L.gc, "create_publish_job", create_publish_job)
    monkeypatch.setattr(L.gc, "list_devices", list_devices)
    return calls


def test_options_are_own_photos_plus_crawled_pool(w):
    opts = SI.options(w.db, w.sku)
    assert [p["url"] for p in opts["photos"]] == ["oss/a.jpg", "oss/b.jpg"]
    assert [p["url"] for p in opts["crawled"]] == [POOL[0]["url"], POOL[1]["url"]]
    assert opts["crawled"][0]["thumb"] == f"thumb:{POOL[0]['url']}" and opts["crawl_status"] == "已合格"


def test_rejected_crawl_is_not_offered(w):
    w.search.status = SpuImageSearch.REJECTED
    w.db.commit()
    assert SI.options(w.db, w.sku)["crawled"] == []


def test_options_requests_search_only_when_never_searched(w, monkeypatch):
    """打开上架页:从没搜过的型号顺手发起搜图;已经搜过(含已合格)的不重搜,免得打回爬取中。"""
    asked = []
    monkeypatch.setattr(SI.product_image, "request_for_spu", lambda db, spu, **kw: asked.append(spu.id))
    SI.options(w.db, w.sku)
    assert asked == []
    w.db.delete(w.search)
    w.db.commit()
    SI.options(w.db, w.sku)
    assert len(asked) == 1


def test_each_shop_gets_its_own_images_in_its_own_job(w, monkeypatch):
    calls = _mock_gc(monkeypatch)
    picks = {w.s1.id: ["oss/a.jpg", POOL[0]["url"]], w.s2.id: [POOL[1]["url"]]}
    rows = asyncio.run(L.gc_publish_shops(w.db, w.sku, w.info, None, shop_images=picks))
    by_acc = {c["accounts"][0]: c["spec"]["images"] for c in calls}
    assert by_acc == {"acc1": ["oss/a.jpg", POOL[0]["url"]], "acc2": [POOL[1]["url"]]}
    assert {r.sale_shop_id: r.images for r in rows} == picks


@pytest.mark.parametrize("picks,why", [
    (lambda w: {w.s1.id: ["oss/a.jpg"], w.s2.id: ["oss/a.jpg"]}, "同一张图"),
    (lambda w: {w.s1.id: ["oss/a.jpg"]}, "店2」还没选图"),
    (lambda w: {w.s1.id: ["oss/a.jpg"], w.s2.id: ["https://evil.example/x.jpg"]}, "不在这件货的候选里"),
])
def test_bad_picks_are_refused_before_anything_is_sent(w, monkeypatch, picks, why):
    calls = _mock_gc(monkeypatch)
    with pytest.raises(ValueError, match=why):
        asyncio.run(L.gc_publish_shops(w.db, w.sku, w.info, None, shop_images=picks(w)))
    assert calls == []


def test_refresh_republishes_the_shops_own_images_and_shared_publish_clears_them(w, monkeypatch):
    w.db.add(SkuShopListing(sku_id=w.sku.id, sale_shop_id=w.s1.id, publish_status=ShopListingStatus.LISTED,
                            gc_account_id="acc1", images=[POOL[1]["url"]]))
    w.db.commit()
    why, spec = LR._refresh_spec(w.db, {"sku": "SK1", "account_id": "acc1", "status": "LIVE"})
    assert why is None and spec["images"] == [POOL[1]["url"]]

    calls = _mock_gc(monkeypatch)
    row = w.db.query(SkuShopListing).one()
    row.publish_status = ShopListingStatus.DELISTED
    w.db.commit()
    asyncio.run(L.gc_publish_shops(w.db, w.sku, w.info, [w.s1.id]))
    assert calls[0]["spec"]["images"] == ["oss/a.jpg", "oss/b.jpg"] and row.images is None


# ---------------------------------------------------------------- 上架图管理(禅道 #102)
# 口径:一个号用的图 = 它单独挑过的那组,没挑过就是公用那组;各号一张都不能重复;
# 改了只存店铺行(下次发布 / 链接焕新才换到闲鱼上);上传的图只认这件货自己的目录。

def _row(w, shop, status=ShopListingStatus.LISTED, images=None):
    row = SkuShopListing(sku_id=w.sku.id, sale_shop_id=shop.id, publish_status=status,
                         gc_account_id=shop.gc_account_id, images=images)
    w.db.add(row)
    w.db.commit()
    return row


@pytest.fixture()
def _signed(monkeypatch):
    monkeypatch.setattr(SI, "sign_oss_publish_image_url", lambda u, **kw: f"full:{u}")
    monkeypatch.setattr(SI, "public_url_to_object_key", lambda u: u.split("oss.example.com/", 1)[-1])


def test_overview_shows_each_accounts_images_and_who_uses_each_picture(w, _signed):
    _row(w, w.s1, images=[POOL[0]["url"]])
    _row(w, w.s2)
    out = SI.overview(w.db, w.sku)
    acc = {a["shop_label"]: a for a in out["accounts"]}
    assert acc["店1"]["own"] and [i["url"] for i in acc["店1"]["images"]] == [POOL[0]["url"]]
    assert not acc["店2"]["own"] and [i["url"] for i in acc["店2"]["images"]] == ["oss/a.jpg", "oss/b.jpg"]
    lib = {x["url"]: x for x in out["library"]}
    assert lib["oss/a.jpg"]["kind"] == "实拍" and lib["oss/a.jpg"]["used_by"] == ["店2"]
    assert lib[POOL[0]["url"]]["used_by"] == ["店1"]
    # 已经挂在号上的爬虫图算进「全部图片」,同款图里只剩没用过的
    assert [c["url"] for c in out["crawled"]] == [POOL[1]["url"]]
    assert out["image_count"] == 3 and out["live_count"] == 2


def test_two_live_accounts_on_the_shared_set_are_flagged(w, _signed):
    _row(w, w.s1)
    _row(w, w.s2)
    acc = {a["shop_label"]: a for a in SI.overview(w.db, w.sku)["accounts"]}
    assert acc["店1"]["shares_with"] == ["店2"]


def test_save_own_set_reorder_and_back_to_shared(w, _signed):
    row = _row(w, w.s1)
    SI.save_for_shop(w.db, w.sku, w.s1.id, [POOL[1]["url"], "oss/b.jpg"])
    assert row.images == [POOL[1]["url"], "oss/b.jpg"]
    SI.save_for_shop(w.db, w.sku, w.s1.id, [])
    assert row.images is None


def test_save_refuses_a_picture_another_account_holds(w, _signed):
    _row(w, w.s1)                       # 店1 在架,用公用图 a、b
    _row(w, w.s2, images=[POOL[0]["url"]])
    with pytest.raises(ValueError, match="给「店1」用了"):
        SI.save_for_shop(w.db, w.sku, w.s2.id, ["oss/a.jpg"])
    # 店2 回到公用图也不行:公用图在店1 上挂着
    with pytest.raises(ValueError, match="公用图里有一张"):
        SI.save_for_shop(w.db, w.sku, w.s2.id, [])


def test_upload_must_come_from_this_skus_own_folder(w, _signed):
    row = _row(w, w.s1)
    mine = f"https://oss.example.com/{SI.upload_dir(w.sku)}x1.jpg"
    SI.save_for_shop(w.db, w.sku, w.s1.id, [mine])
    assert row.images == [mine]
    # 上传过的图之后算进这件货的图里,上架页也能选
    assert mine in [p["url"] for p in SI.options(w.db, w.sku)["photos"]]
    with pytest.raises(ValueError, match="不在这件货的图里"):
        SI.save_for_shop(w.db, w.sku, w.s1.id, ["https://oss.example.com/sku/other/location.jpg"])


def test_save_is_refused_when_approval_is_on_or_row_missing(w, _signed, monkeypatch):
    with pytest.raises(LookupError):
        SI.save_for_shop(w.db, w.sku, w.s1.id, ["oss/a.jpg"])
    _row(w, w.s1)
    monkeypatch.setattr("app.services.listing_approval.approval_required", lambda db: True)
    with pytest.raises(ValueError, match="审批"):
        SI.save_for_shop(w.db, w.sku, w.s1.id, ["oss/a.jpg"])


def test_publish_picks_cannot_reuse_a_live_accounts_pictures(w, monkeypatch):
    calls = _mock_gc(monkeypatch)
    _row(w, w.s1, images=[POOL[0]["url"]])
    with pytest.raises(ValueError, match="同一张图"):
        asyncio.run(L.gc_publish_shops(w.db, w.sku, w.info, [w.s2.id], shop_images={w.s2.id: [POOL[0]["url"]]}))
    assert calls == []
