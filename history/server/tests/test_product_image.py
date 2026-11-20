"""图片爬虫对接(2026-11-04):按 SPU 搜图、员工审过转存参考图、AI 补图照它重绘但要人确认。

11-04 京东云实测正式池里混着促销海报、保护壳广告、相近变体,所以:没审过不用;审过的拿来重绘,
出的图也和文生图一样要人确认才上架;人点「重新生成」就别再照同一张画。
爬虫 HTTP 用 httpx.MockTransport 打桩,图床上传打桩。
"""
import asyncio
from decimal import Decimal

import httpx
import pytest

import app.services.gc_bridge.ai_image_publish as AIP
import app.services.gc_bridge.assembler as ASM
import app.services.product_image as PI
from app.enums import ListingInfoStatus, SkuStatus
from app.models import AiRedrawJob, SaleShop, Sku, SkuListingInfo, SkuShopListing, SpuImageSearch, WarehouseSpu, WarehouseSpuImage
from app.services.spu_resolve import SpuMatch

REF = "https://oss.example.com/spu-ref/90000720/abc.jpg"


class _Crawler:
    """假爬虫:记下收到的请求,任务状态由测试改。"""

    def __init__(self):
        self.searches: list[str] = []
        self.refreshes: list[bool | None] = []
        self.tasks: dict[str, dict] = {}
        self.down = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers.get("cookie") == "employee_access=tok", "要带令牌 cookie"
        if self.down:
            raise httpx.ConnectError("down")
        if request.method == "POST" and request.url.path == "/v1/images/search":
            import json
            body = json.loads(request.content)
            q = body["query"]
            self.searches.append(q)
            self.refreshes.append(body.get("refresh"))
            tid = f"img_{len(self.searches)}"
            self.tasks[tid] = {"status": "queued", "images": []}
            return httpx.Response(202, json={"task_id": tid, "status": "queued"})
        if request.url.path.startswith("/v1/images/tasks/"):
            tid = request.url.path.rsplit("/", 1)[1]
            if tid not in self.tasks:
                return httpx.Response(404, json={"detail": "not found"})
            return httpx.Response(200, json={"task_id": tid, **self.tasks[tid]})
        if request.url.path.endswith(".webp"):
            return httpx.Response(200, content=b"RIFF\x00\x00\x00\x00WEBPVP8L", headers={"content-type": "text/plain"})
        if request.url.path.startswith("/files/"):
            return httpx.Response(200, content=b"\xff\xd8jpeg", headers={"content-type": "image/jpeg"})
        return httpx.Response(404)


@pytest.fixture
def crawler(monkeypatch):
    c = _Crawler()
    from app.config import settings
    monkeypatch.setattr(settings, "product_image_base_url", "https://panel.example.com")
    monkeypatch.setattr(settings, "product_image_token", "tok")
    monkeypatch.setattr(PI, "_client", lambda: httpx.Client(
        base_url="https://panel.example.com", cookies={"employee_access": "tok"},
        transport=httpx.MockTransport(c.handler)))
    uploads = []

    def fake_upload(folder, name, content, ctype):
        uploads.append((folder, name, content, ctype))
        return {"public_url": f"https://oss.example.com/{folder}/{name}"}

    monkeypatch.setattr(PI, "upload_object", fake_upload)
    c.uploads = uploads
    return c


def _spu(db):
    spu = WarehouseSpu(spu_code="90000720", brand="AOC", model="24G2Z", enabled=True)
    db.add(spu)
    db.commit()
    return spu


def _img(name, *, conf=0.9, score=1.0, watermark="none"):
    return {"url": f"https://panel.example.com/files/{name}.jpg", "source_url": f"https://shop.example/{name}",
            "watermark": watermark, "product_confidence": conf, "score": score}


# ---------- 发起与跟进 ----------

def test_not_configured_does_nothing(db_session):
    spu = _spu(db_session)
    assert PI.request_for_spu(db_session, spu) is None
    assert PI.advance_open(db_session) == 0
    assert db_session.query(SpuImageSearch).count() == 0


def test_request_once_per_spu(db_session, crawler):
    spu = _spu(db_session)
    row = PI.request_for_spu(db_session, spu)
    db_session.commit()
    assert crawler.searches == ["AOC 24G2Z"] and row.status == SpuImageSearch.SEARCHING and row.task_id == "img_1"
    PI.request_for_spu(db_session, spu)
    assert crawler.searches == ["AOC 24G2Z"], "在搜的不重复发"
    row = PI.request_for_spu(db_session, spu, force=True)
    assert crawler.refreshes == [False, True], "强制重搜要让爬虫开新任务,不能还旧任务"
    assert row.task_id == "img_2"


def test_crawler_down_does_not_raise(db_session, crawler):
    crawler.down = True
    assert PI.request_for_spu(db_session, _spu(db_session)) is None


def test_waits_for_review_then_stores_the_best_formal_image(db_session, crawler):
    spu = _spu(db_session)
    row = PI.request_for_spu(db_session, spu)
    db_session.commit()

    crawler.tasks["img_1"] = {"status": "completed", "review_status": "pending",
                              "images": [_img("poster", watermark="visible", conf=0.99), _img("real", conf=0.8)]}
    assert PI.advance_open(db_session) == 0
    assert row.status == SpuImageSearch.REVIEWING and row.formal_count == 2
    assert [u[0] for u in crawler.uploads] == ["spu-ref/90000720/pool"] * 2, "等审核时整池先转存,上架页好挑"
    assert [p["crawler_url"] for p in row.pool_images] == [_img("poster")["url"], _img("real")["url"]]
    assert PI.advance_open(db_session) == 0
    assert len(crawler.uploads) == 2, "转存过的不重复下载"

    crawler.tasks["img_1"].update(review_status="approved", reviewer="小王")
    assert PI.advance_open(db_session) == 1
    db_session.refresh(row)
    assert row.status == SpuImageSearch.READY and row.reviewer == "小王"
    assert row.source_url == "https://shop.example/real", "有水印的排后面"
    [(folder, _, content, ctype)] = [u for u in crawler.uploads if not u[0].endswith("/pool")]
    assert folder == "spu-ref/90000720" and content == b"\xff\xd8jpeg" and ctype == "image/jpeg"
    assert row.reference_url.startswith("https://oss.example.com/spu-ref/90000720/")
    assert PI.reference_for_spu(db_session, spu.id) == row.reference_url


@pytest.mark.parametrize("task,status", [
    ({"status": "completed", "review_status": "needs_changes", "review_note": "全是配件", "images": [_img("a")]},
     SpuImageSearch.REJECTED),
    ({"status": "failed", "error": "没有图片通过型号校验", "images": []}, SpuImageSearch.FAILED),
])
def test_rejected_or_failed_is_not_used(db_session, crawler, task, status):
    spu = _spu(db_session)
    row = PI.request_for_spu(db_session, spu)
    db_session.commit()
    crawler.tasks["img_1"] = task
    assert PI.advance_open(db_session) == 1
    assert row.status == status and row.error and PI.reference_for_spu(db_session, spu.id) is None


# ---------- 接 AI 补图 ----------

@pytest.fixture
def publish_stubs(monkeypatch):
    monkeypatch.setattr(ASM, "sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr(AIP, "sign_media_payload", lambda obj, expires=86400: [f"{u}?signed" for u in obj])
    from app.config import settings
    monkeypatch.setattr(settings, "redraw_provider", "apinebula")
    monkeypatch.setattr(AIP.redraw_worker, "enqueue", lambda job_id: None)

    async def publish(db, sku, info, shop_ids):
        raise AssertionError("爬虫参考图重绘的不该自动下发")

    monkeypatch.setattr(AIP, "gc_publish_shops", publish)


def _seed_sku(db, spu):
    monkeypatch_match = SpuMatch(spu=spu, how="brand_model")
    sku = Sku(sku_code="513211540223", product_name="AOC 24G2Z", model="24G2Z", purchase_order_id="po1",
              inspection_id="in1", cost_price=Decimal("1"), status=SkuStatus.IN_STOCK, images=[],
              suggest_price=Decimal("100"))
    db.add(sku)
    shop = SaleShop(code="s0", label="闲鱼A", xianyu_user_name="闲鱼A", enabled=True, sort_order=0,
                    gc_account_id="acc-a")
    db.add(shop)
    db.flush()
    info = SkuListingInfo(sku_id=sku.id, images=[], price=Decimal("1"), express_fee=Decimal("0"),
                          status=ListingInfoStatus.READY)
    db.add(info)
    db.commit()
    return sku, info, monkeypatch_match


def _wait(db, sku, info):
    async def mark(db_, sku_, info_, shop_ids, job_id):
        row = SkuShopListing(sku_id=sku_.id, sale_shop_id=db_.query(SaleShop).first().id, ai_image_job_id=job_id)
        db_.add(row)
        db_.commit()
        return [row]
    return mark


def test_ai_fallback_redraws_from_crawled_reference_and_waits_for_a_person(db_session, crawler, publish_stubs,
                                                                          monkeypatch):
    spu = _spu(db_session)
    sku, info, match = _seed_sku(db_session, spu)
    monkeypatch.setattr(AIP, "resolve_spu", lambda db, s: match)
    db_session.add(SpuImageSearch(spu_id=spu.id, query="AOC 24G2Z", task_id="img_9",
                                  status=SpuImageSearch.READY, reference_url=REF))
    db_session.commit()
    monkeypatch.setattr(AIP, "_mark_waiting", _wait(db_session, sku, info))

    _, waiting = asyncio.run(AIP.publish_or_wait_for_image(db_session, sku, info, None))
    assert waiting and crawler.searches == [], "已经有参考图,不再搜"
    [job] = db_session.query(AiRedrawJob).all()
    assert job.source_image_url == f"{REF}?signed" and AIP.needs_confirm(job)
    assert job.prompt.endswith(AIP._REFERENCE_SUFFIX)

    job.status, job.result_url = "SUCCEEDED", "https://oss.example.com/listing/ai-redraw/r.png"
    db_session.commit()
    assert asyncio.run(AIP.advance_waiting(db_session)) == 0
    db_session.refresh(info)
    assert info.ai_image_unconfirmed is True, "照爬虫图画的要人确认"
    assert AIP.latest_ai_image(db_session, sku.sku_code) is None, "不能当现成可直接用的 AI 图"

    AIP.regenerate(db_session, sku, info, hint="显示器")
    newest = db_session.query(AiRedrawJob).order_by(AiRedrawJob.created_at.desc(), AiRedrawJob.id).all()
    assert any(j.source_image_url == "" for j in newest), "人说不对就别再照同一张爬虫图画,改文生图"


def test_ai_fallback_without_reference_kicks_off_a_search(db_session, crawler, publish_stubs, monkeypatch):
    spu = _spu(db_session)
    sku, info, match = _seed_sku(db_session, spu)
    monkeypatch.setattr(AIP, "resolve_spu", lambda db, s: match)
    monkeypatch.setattr(AIP, "_mark_waiting", _wait(db_session, sku, info))

    asyncio.run(AIP.publish_or_wait_for_image(db_session, sku, info, None))
    [job] = db_session.query(AiRedrawJob).all()
    assert job.source_image_url == "", "这次照旧文生图"
    assert crawler.searches == ["AOC 24G2Z"]
    assert db_session.query(SpuImageSearch).one().status == SpuImageSearch.SEARCHING


# ---------- 管理接口 ----------

def _stock(db, spu, code, images=()):
    from app.models import WarehouseSpuSku
    db.add(Sku(sku_code=code, product_name=spu.brand_model, purchase_order_id="po", inspection_id="in",
               cost_price=Decimal("1"), status=SkuStatus.IN_STOCK, images=list(images), suggest_price=Decimal("1")))
    db.add(WarehouseSpuSku(spu_id=spu.id, sku_code=code))


def test_backfill_searches_models_with_most_photoless_stock_first(db_session, crawler):
    import app.routers.product_image as R
    few = WarehouseSpu(spu_code="1", brand="SONOS", model="ONE", enabled=True)
    many = WarehouseSpu(spu_code="2", brand="金士顿", model="飓风2", enabled=True)
    shot = WarehouseSpu(spu_code="3", brand="AOC", model="C27G3Z", enabled=True)
    db_session.add_all([few, many, shot])
    db_session.flush()
    _stock(db_session, few, "a1")
    _stock(db_session, many, "b1")
    _stock(db_session, many, "b2")
    _stock(db_session, shot, "c1", images=["https://oss/x.jpg"])
    db_session.commit()

    assert R.backfill(limit=1, db=db_session, _=None).requested == 1
    assert crawler.searches == ["金士顿 飓风2"], "缺图件数多的先搜;有实拍的不搜"
    assert R.backfill(limit=5, db=db_session, _=None).requested == 1
    assert crawler.searches == ["金士顿 飓风2", "SONOS ONE"]


def test_list_reports_counts_and_what_is_left_to_backfill(db_session, crawler, monkeypatch):
    import app.routers.product_image as R
    monkeypatch.setattr(R, "sign_oss_thumb_url", lambda url: f"{url}?thumb")
    spu = _spu(db_session)
    other = WarehouseSpu(spu_code="9", brand="SONOS", model="PORT", enabled=True)
    db_session.add(other)
    db_session.flush()
    _stock(db_session, spu, "a1")
    _stock(db_session, other, "b1")
    db_session.add(SpuImageSearch(spu_id=spu.id, query="AOC 24G2Z", status=SpuImageSearch.READY,
                                  reference_url=REF, formal_count=6))
    db_session.commit()

    out = R.list_searches(status=None, db=db_session, _=None)
    assert out.enabled and out.review_url == "https://panel.example.com/employee?access_key=tok"
    assert out.counts[SpuImageSearch.READY] == 1 and out.counts[SpuImageSearch.SEARCHING] == 0
    assert out.pending_backfill == 1, "SONOS PORT 缺图还没搜"
    [item] = out.items
    assert item.status_label == "参考图可用" and item.missing_photo_skus == 1
    assert item.reference_preview == f"{REF}?thumb"


def test_webp_served_as_text_plain_is_still_stored(db_session, crawler):
    spu = _spu(db_session)
    row = PI.request_for_spu(db_session, spu)
    db_session.commit()
    crawler.tasks["img_1"] = {"status": "completed", "review_status": "approved",
                              "images": [{**_img("rog"), "url": "https://panel.example.com/files/rog.webp"}]}
    assert PI.advance_open(db_session) == 1
    assert row.status == SpuImageSearch.READY
    [(_, _, _, ctype)] = [u for u in crawler.uploads if not u[0].endswith("/pool")]
    assert ctype == "image/webp"


# ---------- 上架用图质量分(爬虫 11-10 起给) ----------

def test_refresh_pools_does_not_archive_pending_review(db_session, crawler):
    """待审核的爬虫图只同步任务态图池,不能写进商品档案。"""
    spu = _spu(db_session)
    row = PI.request_for_spu(db_session, spu)
    db_session.commit()
    crawler.tasks["img_1"] = {
        "status": "completed", "review_status": "pending", "images": [_img("pending")]
    }
    PI.advance_open(db_session)
    db_session.refresh(row)
    assert row.status == SpuImageSearch.REVIEWING

    PI.refresh_pools(db_session)
    db_session.refresh(row)
    assert row.status == SpuImageSearch.REVIEWING
    assert row.archive_count == 0
    assert db_session.query(WarehouseSpuImage).count() == 0


def test_quality_follows_crawler_and_ready_pools_resync_without_changing_status(db_session, crawler):
    spu = _spu(db_session)
    row = PI.request_for_spu(db_session, spu)
    db_session.commit()
    crawler.tasks["img_1"] = {"status": "completed", "review_status": "approved", "reviewer": "小王",
                              "images": [_img("a"), _img("b")]}
    PI.advance_open(db_session)
    db_session.refresh(row)
    assert row.status == SpuImageSearch.READY and "quality_grade" not in row.pool_images[0]
    ref = row.reference_url

    # 爬虫补评老任务后:顺序变了,带上质量分
    crawler.tasks["img_1"]["images"] = [
        {**_img("b"), "quality_grade": "good", "quality_flags": ["白底"], "quality_score": 115},
        {**_img("a"), "quality_grade": "bad", "quality_flags": ["水印"], "quality_score": 50},
    ]
    assert PI.refresh_pools(db_session) == 1
    db_session.refresh(row)
    assert [(p["crawler_url"].rsplit("/", 1)[1], p["quality_grade"]) for p in row.pool_images] == [("b.jpg", "good"), ("a.jpg", "bad")]
    assert row.status == SpuImageSearch.READY and row.reference_url == ref
    assert len([u for u in crawler.uploads if u[0].endswith("/pool")]) == 2, "转存过的不重复下载"
    assert [p["url"] for p in PI.usable_for_listing(row.pool_images)] == [row.pool_images[0]["url"]]


def test_reference_prefers_good_quality(db_session):
    picked = PI._pick([{**_img("wm"), "quality_grade": "bad", "product_confidence": 0.99},
                       {**_img("ok"), "quality_grade": "good", "product_confidence": 0.7}])
    assert picked["url"].endswith("ok.jpg")


def test_pool_keeps_size_so_screenshots_can_be_told_apart(db_session, crawler):
    spu = _spu(db_session)
    row = PI.request_for_spu(db_session, spu)
    db_session.commit()
    shot = {**_img("shot"), "width": 1080, "height": 2340, "quality_grade": "bad", "quality_flags": ["海报字"]}
    crawler.tasks["img_1"] = {"status": "completed", "review_status": "pending",
                              "images": [shot, {**_img("ok"), "width": 1200, "height": 1200}]}
    PI.advance_open(db_session)
    db_session.refresh(row)
    first = row.pool_images[0]
    assert (first["width"], first["height"], first["quality_flags"]) == (1080, 2340, ["海报字"])
    # 像聊天 / 订单截图的不自动用;没评过质量的照用
    assert [p["crawler_url"].rsplit("/", 1)[1] for p in PI.usable_for_listing(row.pool_images)] == ["ok.jpg"]


def test_reference_skips_screenshots_and_avatars(db_session):
    picked = PI._pick([{**_img("face"), "width": 500, "height": 500, "quality_flags": ["人像"], "product_confidence": 0.99},
                       {**_img("plain"), "product_confidence": 0.5}])
    assert picked["url"].endswith("plain.jpg")
