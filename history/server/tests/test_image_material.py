"""上架素材分池(2026-11-10):候选图可用 / 待复核 / 淘汰。

钉死的口径:
  1. 爬虫评 bad 的(水印、海报字、拼图、人像、长图)待复核:挑图时还在、角标写毛病,自动补图不用;
  2. 像头像、表情包、聊天 / 订单截图、纯文字的爬虫图直接淘汰,写原因;封面不在实拍图里的淘汰;
  3. 员工标的淘汰(要写原因)盖过规则,淘汰的图上架挑图、加图都看不到,保存 / 发布也不收;
  4. 改回可用:规则的淘汰作废,但 bad 的还是待复核,不会因此被自动补图拿去用。
"""
import asyncio
from decimal import Decimal
from types import SimpleNamespace

import pytest

import app.services.gc_bridge.assembler as ASM
import app.services.gc_bridge.listing_ops as L
import app.services.image_material as IM
import app.services.shop_images as SI
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus
from app.models import (
    ImageMaterialMark,
    SaleShop,
    Sku,
    SkuListingInfo,
    SkuShopListing,
    SpuImageSearch,
    WarehouseSpu,
)

GOOD = {"url": "https://oss.example.com/spu-ref/9/pool/good.jpg", "width": 1200, "height": 1200,
        "quality_grade": "good", "quality_flags": ["白底"]}
WM = {"url": "https://oss.example.com/spu-ref/9/pool/wm.jpg", "width": 1200, "height": 900,
      "quality_grade": "bad", "quality_flags": ["小图", "水印"]}
AVATAR = {"url": "https://oss.example.com/spu-ref/9/pool/face.jpg", "width": 640, "height": 640,
          "quality_grade": "bad", "quality_flags": ["小图", "人像"]}
OLD = {"url": "https://oss.example.com/spu-ref/9/pool/old.jpg"}  # 老任务没评过
POOL = [GOOD, WM, AVATAR, OLD]


# ---------------------------------------------------------------- 规则

@pytest.mark.parametrize("item, status, reason", [
    (GOOD, IM.USABLE, None),
    (OLD, IM.USABLE, None),
    (WM, IM.REVIEW, "水印"),                      # 按毛病轻重给原因,不是先来的「小图」
    ({**GOOD, "quality_grade": "bad", "quality_flags": ["拼图"]}, IM.REVIEW, "拼图"),
    (AVATAR, IM.REJECTED, "像头像"),
    ({**GOOD, "width": 240, "height": 240}, IM.REJECTED, "太小，像头像或表情包"),
    ({**GOOD, "url": "https://x/spu-ref/1/pool/a.GIF"}, IM.REJECTED, "动图，像表情包"),
    ({"url": "u", "width": 1080, "height": 2340, "quality_grade": "bad", "quality_flags": ["海报字"]},
     IM.REJECTED, "像聊天或订单截图"),
    ({"url": "u", "quality_grade": "bad", "quality_flags": ["长图", "海报字"]}, IM.REJECTED, "像长截图或详情页"),
    ({**GOOD, "quality_text_ratio": 0.35}, IM.REJECTED, "几乎全是字"),
    # 竖着拍的实物图、没满屏字:不算截图
    ({"url": "u", "width": 1080, "height": 1920, "quality_grade": "good", "quality_flags": []}, IM.USABLE, None),
    # 大图里有人像(发布会、模特):不是头像,待复核
    ({"url": "u", "width": 1600, "height": 1200, "quality_grade": "bad", "quality_flags": ["人像"]}, IM.REVIEW, "人像"),
])
def test_rules(item, status, reason):
    v = IM.rule_verdict(item)
    assert (v.status, v.reason) == (status, reason)


def test_manual_mark_beats_rules_but_bad_stays_in_review():
    rejected = ImageMaterialMark(status=ImageMaterialMark.REJECTED, reason="不是这个型号")
    usable = ImageMaterialMark(status=ImageMaterialMark.USABLE)
    assert IM.verdict(IM.rule_verdict(GOOD), rejected, GOOD).status == IM.REJECTED
    # 人说「不是头像」:淘汰作废,但质量 bad 照样待复核
    v = IM.verdict(IM.rule_verdict(AVATAR), usable, AVATAR)
    assert (v.status, v.reason, v.manual) == (IM.REVIEW, "人像", True)
    gif = {**OLD, "url": "https://x/a.gif"}
    assert IM.verdict(IM.rule_verdict(gif), usable, gif).status == IM.USABLE


def test_reject_needs_a_reason(db_session):
    with pytest.raises(ValueError, match="原因"):
        IM.set_mark(db_session, "https://x/a.jpg", "rejected", reason="  ")
    with pytest.raises(ValueError):
        IM.set_mark(db_session, "https://x/a.jpg", "review")


# ---------------------------------------------------------------- 挑图、管理页

@pytest.fixture(autouse=True)
def _no_oss(monkeypatch):
    monkeypatch.setattr(ASM, "sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr("app.services.oss_media.sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr(SI, "sign_oss_thumb_url", lambda u, **kw: f"thumb:{u}")
    monkeypatch.setattr(SI, "sign_oss_publish_image_url", lambda u, **kw: f"full:{u}")
    monkeypatch.setattr(SI, "public_url_to_object_key", lambda u: u.split("oss.example.com/", 1)[-1])


@pytest.fixture()
def w(db_session, monkeypatch):
    db = db_session
    spu = WarehouseSpu(spu_code="9", brand="AOC", model="24G2Z", enabled=True)
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1000"), status=SkuStatus.IN_STOCK, images=["oss/a.jpg", "oss/b.jpg"],
              cover_url="https://oss.example.com/cover.jpg?OSSAccessKeyId=k&Expires=1&Signature=x")
    s1 = SaleShop(code="s1", label="店1", xianyu_user_name="甲", enabled=True, sort_order=0, gc_account_id="acc1")
    s2 = SaleShop(code="s2", label="店2", xianyu_user_name="乙", enabled=True, sort_order=1, gc_account_id="acc2")
    db.add_all([spu, sku, s1, s2])
    db.flush()
    db.add(SkuListingInfo(sku_id=sku.id, images=["oss/a.jpg", "oss/b.jpg"], status=ListingInfoStatus.READY))
    db.add(SpuImageSearch(spu_id=spu.id, query="AOC 24G2Z", status=SpuImageSearch.READY, pool_images=POOL))
    db.commit()
    monkeypatch.setattr(SI, "resolve_spu", lambda db, sku: SimpleNamespace(matched=True, spu=spu))
    return SimpleNamespace(db=db, sku=sku, s1=s1, s2=s2, spu=spu, info=db.query(SkuListingInfo).one())


def _row(w, shop, status=ShopListingStatus.LISTED, images=None):
    row = SkuShopListing(sku_id=w.sku.id, sale_shop_id=shop.id, publish_status=status,
                         gc_account_id=shop.gc_account_id, images=images)
    w.db.add(row)
    w.db.commit()
    return row


def _mock_gc(monkeypatch):
    async def noop(db):
        return None

    async def get_account(aid):
        return {"id": aid, "nick": {"acc1": "甲", "acc2": "乙"}[aid], "device_id": "d"}

    async def create_publish_job(*a, **kw):
        raise AssertionError("淘汰的图不该发出去")

    async def list_devices():
        return []

    monkeypatch.setattr(L, "sync_gc_shops", noop)
    monkeypatch.setattr(L.gc, "get_account", get_account)
    monkeypatch.setattr(L.gc, "create_publish_job", create_publish_job)
    monkeypatch.setattr(L.gc, "list_devices", list_devices)


def test_options_drop_rejected_and_put_review_last(w):
    opts = SI.options(w.db, w.sku)
    crawled = [(c["url"].rsplit("/", 1)[1], c["status"], c["reason"]) for c in opts["crawled"]]
    assert crawled == [("good.jpg", "usable", ""), ("old.jpg", "usable", ""), ("wm.jpg", "review", "水印")]
    assert opts["rejected_count"] == 1 and opts["reject_reasons"]
    assert [p["status"] for p in opts["photos"]] == ["usable", "usable"]


def test_staff_rejects_a_photo_it_leaves_every_picker_and_can_come_back(w, monkeypatch):
    row = _row(w, w.s1, images=["oss/a.jpg"])
    out = SI.mark_image(w.db, w.sku, "oss/b.jpg", "rejected", "模糊 / 太小", "小王")
    assert out["status"] == "rejected" and out["reason"] == "模糊 / 太小" and out["used_by"] == []
    assert [p["url"] for p in SI.options(w.db, w.sku)["photos"]] == ["oss/a.jpg"]
    ov = SI.overview(w.db, w.sku)
    assert "oss/b.jpg" not in [x["url"] for x in ov["library"]]
    gone = {x["url"]: x for x in ov["rejected"]}
    assert gone["oss/b.jpg"]["reason"] == "模糊 / 太小" and gone["oss/b.jpg"]["manual"]

    # 号上还挂着的图被淘汰:提醒谁在用,保存时要先拿掉
    out = SI.mark_image(w.db, w.sku, "oss/a.jpg", "rejected", "别家的实物", "小王")
    assert out["used_by"] == ["店1"]
    acc = SI.overview(w.db, w.sku)["accounts"][0]
    assert acc["images"][0]["rejected"] == "别家的实物"
    with pytest.raises(ValueError, match="淘汰"):
        SI.save_for_shop(w.db, w.sku, w.s1.id, ["oss/a.jpg", GOOD["url"]])

    # 发布也不收
    _mock_gc(monkeypatch)
    with pytest.raises(ValueError, match="候选"):
        asyncio.run(L.gc_publish_shops(w.db, w.sku, w.info, [w.s2.id], shop_images={w.s2.id: ["oss/b.jpg"]}))

    # 改回可用
    SI.mark_image(w.db, w.sku, "oss/a.jpg", "usable", None, "小王")
    SI.save_for_shop(w.db, w.sku, w.s1.id, ["oss/a.jpg", GOOD["url"]])
    assert row.images == ["oss/a.jpg", GOOD["url"]]
    mark = w.db.query(ImageMaterialMark).filter_by(url="oss/a.jpg").one()
    assert mark.status == "usable" and mark.reason is None and mark.marked_by == "小王" and mark.sku_id == w.sku.id


def test_rejecting_a_crawled_picture_applies_to_the_whole_model(w):
    SI.mark_image(w.db, w.sku, GOOD["url"] + "?OSSAccessKeyId=k&Expires=1&Signature=x", "rejected", "不是这个型号", "小王")
    mark = w.db.query(ImageMaterialMark).one()
    assert mark.url == GOOD["url"] and mark.spu_id == w.spu.id
    assert GOOD["url"] not in [c["url"] for c in SI.options(w.db, w.sku)["crawled"]]
    # 自动补图也不再用它
    pool = w.db.query(SpuImageSearch).one().pool_images
    assert [p["url"] for p in IM.usable_crawled(w.db, pool)] == [OLD["url"]]


def test_rule_rejected_crawled_picture_can_be_restored_but_stays_in_review(w):
    out = SI.mark_image(w.db, w.sku, AVATAR["url"], "usable", None, "小王")
    assert (out["status"], out["reason"]) == ("review", "人像")
    assert AVATAR["url"] in [c["url"] for c in SI.options(w.db, w.sku)["crawled"]]
    pool = w.db.query(SpuImageSearch).one().pool_images
    assert AVATAR["url"] not in [p["url"] for p in IM.usable_crawled(w.db, pool)]


def test_unknown_picture_cannot_be_marked(w):
    with pytest.raises(LookupError):
        SI.mark_image(w.db, w.sku, "https://oss.example.com/sku/other/x.jpg", "rejected", "截图", "小王")


def test_cover_that_is_not_a_photo_is_rejected(w):
    # 上架信息里混进了封面(封面里抽查到过买家订单截图)
    cover = "https://oss.example.com/cover.jpg"
    w.info.images = ["oss/a.jpg", cover]
    w.db.commit()
    assert cover not in [p["url"] for p in SI.options(w.db, w.sku)["photos"]]
    gone = {x["url"]: x for x in SI.overview(w.db, w.sku)["rejected"]}
    assert gone[cover]["reason"].startswith("封面") and not gone[cover]["manual"]
    # 封面就是实拍第一张(资产录入)的不算
    w.sku.images = [cover, "oss/a.jpg"]
    w.db.commit()
    assert cover in [p["url"] for p in SI.options(w.db, w.sku)["photos"]]


def test_route_marks_and_maps_errors(w):
    from fastapi import HTTPException

    from app.routers.listing import set_image_status
    from app.schemas.listing import ImageMaterialSet

    user = SimpleNamespace(name="小王", username="wang")
    out = set_image_status("SK1", ImageMaterialSet(url="oss/b.jpg", status="rejected", reason="截图"), w.db, user)
    assert (out["status"], out["reason"]) == ("rejected", "截图")
    with pytest.raises(HTTPException) as e:
        set_image_status("SK1", ImageMaterialSet(url="oss/a.jpg", status="rejected"), w.db, user)
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        set_image_status("SK1", ImageMaterialSet(url="oss/zzz.jpg", status="usable"), w.db, user)
    assert e.value.status_code == 404


def test_crawled_picture_already_on_an_account_keeps_its_review_badge(w):
    _row(w, w.s1, images=[WM["url"]])
    lib = {x["url"]: x for x in SI.overview(w.db, w.sku)["library"]}
    assert (lib[WM["url"]]["status"], lib[WM["url"]]["reason"]) == ("review", "水印")
