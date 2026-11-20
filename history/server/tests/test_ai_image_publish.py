"""手动上架缺商品图:先 AI 生成主图,再上架(2026-10-08)。

现场:小程序「店铺上架」点了几个没拍照的货,群控一律拒收「缺少商品图」,提示一闪而过,同事反复点。
接上 AI 兜底后,文生图把「盛色 N50PRO6」这台显示器画成了耳机(没参考时 AI 只能凭型号名猜品类)。
用户定:有同款实拍图的拿它当参考重绘、自动上架;没有同款的照样生成,但要人确认才上架。
async 用 asyncio.run 直调;群控 client、生图投递、SPU 解析全部打桩。
"""
import asyncio
from datetime import datetime, timedelta
from decimal import Decimal

import pytest

import app.services.gc_bridge.ai_image_publish as AIP
import app.services.gc_bridge.assembler as ASM
import app.services.gc_bridge.listing_ops as L
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus
from app.models import AiRedrawJob, SaleShop, Sku, SkuListingInfo, SkuShopListing
from app.services.gc_bridge.client import GcBridgeError

OSS = "https://oss.example.com/listing/ai-redraw/x.png"
SIBLING_PHOTO = "https://oss.example.com/sku/product/sibling-front.jpg"


class _NoMatch:
    matched = False
    query = None
    spu = None


@pytest.fixture(autouse=True)
def _stubs(monkeypatch):
    monkeypatch.setattr(ASM, "sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr(AIP, "sign_media_payload", lambda obj, expires=86400: [f"{u}?signed" for u in obj])
    from app.config import settings
    monkeypatch.setattr(settings, "redraw_provider", "apinebula")
    # 对照表解析不出 → 同款按同品名找、提示词按品名拼
    monkeypatch.setattr(AIP, "resolve_spu", lambda db, sku: _NoMatch())
    enqueued = []
    monkeypatch.setattr(AIP.redraw_worker, "enqueue", lambda job_id: enqueued.append(job_id))
    return enqueued


def _seed(db, *, sku_images=None, shops=("闲鱼A",), sibling_images=None, sibling_listing_images=None):
    sku = Sku(sku_code="513211540248", product_name="盛色 N50PRO6", model="N50PRO6", purchase_order_id="po1",
              inspection_id="in1", cost_price=Decimal("1"), status=SkuStatus.IN_STOCK,
              images=list(sku_images or []), suggest_price=Decimal("100"),
              cover_url="https://oss.example.com/migrate/qinsilk/goods/order-screenshot.jpg")
    db.add(sku)
    if sibling_images is not None or sibling_listing_images is not None:
        sib = Sku(sku_code="513211540218", product_name="盛色 N50PRO6", model="N50PRO6", purchase_order_id="po2",
                  inspection_id="in2", cost_price=Decimal("1"), status=SkuStatus.IN_STOCK,
                  images=list(sibling_images or []), suggest_price=Decimal("100"))
        db.add(sib)
        db.flush()
        if sibling_listing_images is not None:
            db.add(SkuListingInfo(sku_id=sib.id, images=list(sibling_listing_images), price=Decimal("1"),
                                  status=ListingInfoStatus.PUBLISHED))
    shop_rows = []
    for i, nick in enumerate(shops):
        s = SaleShop(code=f"s{i}", label=nick, xianyu_user_name=nick, enabled=True, sort_order=i,
                     gc_account_id=f"acc-{nick}")
        db.add(s)
        shop_rows.append(s)
    db.flush()
    info = SkuListingInfo(sku_id=sku.id, images=[], price=Decimal("369.05"),
                          express_fee=Decimal("0"), status=ListingInfoStatus.READY)
    db.add(info)
    db.commit()
    return sku, shop_rows, info


def _mock_gc(monkeypatch, *, reject=None):
    calls = []

    async def noop_sync(db):
        return None

    async def get_account(aid):
        return {"id": aid, "nick": aid.replace("acc-", ""), "device_id": "dev1"}

    async def list_devices():
        return []

    async def create_publish_job(sku, account_ids, spec, source="ERP", worry_free_by_account=None):
        if reject:
            raise GcBridgeError(reject, status=400)
        calls.append({"sku": sku, "account_ids": account_ids, "images": spec.get("images")})
        return {"id": f"job-pub-{len(calls)}"}

    monkeypatch.setattr(L, "sync_gc_shops", noop_sync)
    monkeypatch.setattr(L.gc, "get_account", get_account)
    monkeypatch.setattr(L.gc, "list_devices", list_devices)
    monkeypatch.setattr(L.gc, "create_publish_job", create_publish_job)
    return calls


def _rows(db, sku):
    db.expire_all()
    return db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id).all()


def _publish(db, sku, info):
    return asyncio.run(AIP.publish_or_wait_for_image(db, sku, info, None))


def _finish_job(db, *, status="SUCCEEDED", error=None, created=None):
    job = db.query(AiRedrawJob).order_by(AiRedrawJob.created_at.desc()).first()
    job.status = status
    job.error_message = error
    if status == "SUCCEEDED":
        job.result_url = OSS
    if created:
        job.created_at = created
    db.commit()
    return job


# ---------- 有图 / 现成的图 ----------

def test_with_real_photos_publishes_right_away(db_session, monkeypatch, _stubs):
    sku, _, info = _seed(db_session, sku_images=["oss/sku/product/a.jpg"])
    calls = _mock_gc(monkeypatch)
    rows, waiting = _publish(db_session, sku, info)
    assert not waiting and calls[0]["images"] == ["oss/sku/product/a.jpg"] and _stubs == []


def test_existing_reference_based_ai_image_is_used_directly(db_session, monkeypatch, _stubs):
    sku, _, info = _seed(db_session)
    db_session.add(AiRedrawJob(sku_code=sku.sku_code, source_image_url="https://ref?signed", prompt="p",
                               status="SUCCEEDED",
                               result_url=OSS + "?OSSAccessKeyId=k&Expires=1&Signature=x"))
    db_session.commit()
    calls = _mock_gc(monkeypatch)
    rows, waiting = _publish(db_session, sku, info)
    assert not waiting and calls[0]["images"] == [OSS], "照参考图画的直接用,存干净链接"
    assert _stubs == []


def test_existing_text_to_image_result_waits_for_a_person_instead_of_redrawing(db_session, monkeypatch, _stubs):
    sku, _, info = _seed(db_session)
    db_session.add(AiRedrawJob(sku_code=sku.sku_code, source_image_url="", prompt="p",
                               status="SUCCEEDED", result_url=OSS))
    db_session.commit()
    calls = _mock_gc(monkeypatch)
    rows, waiting = _publish(db_session, sku, info)
    assert waiting and calls == [] and _stubs == [], "不重画,也不直接发"
    db_session.refresh(info)
    assert info.images == [OSS] and info.ai_image_unconfirmed is True


# ---------- 同款参考 ----------

def test_same_model_photo_is_the_reference_and_publishes_automatically(db_session, monkeypatch, _stubs):
    sku, _, info = _seed(db_session, shops=("闲鱼A", "闲鱼B"), sibling_listing_images=[SIBLING_PHOTO])
    _mock_gc(monkeypatch)
    rows, waiting = _publish(db_session, sku, info)
    assert waiting
    [job] = db_session.query(AiRedrawJob).all()
    assert job.source_image_url == SIBLING_PHOTO + "?signed", "参考图给签名链接(私有桶要能下载)"
    assert "以参考图中的商品为准" in job.prompt and "盛色 N50PRO6" in job.prompt
    _finish_job(db_session)
    calls = _mock_gc(monkeypatch)
    assert asyncio.run(AIP.advance_waiting(db_session)) == 2
    assert calls[0]["images"] == [OSS] and sorted(calls[0]["account_ids"]) == ["acc-闲鱼A", "acc-闲鱼B"]
    db_session.refresh(info)
    assert info.ai_image_unconfirmed is False
    assert asyncio.run(AIP.advance_waiting(db_session)) == 0, "下发过的不再下发(否则一件货挂两份)"


def test_private_and_ai_images_are_never_used_as_reference(db_session, monkeypatch, _stubs):
    sku, _, info = _seed(db_session, sibling_listing_images=[
        "https://oss.example.com/asset/x_order_1.jpg",          # 买家成交截图
        "https://oss.example.com/sku/location/shelf.jpg",        # 库位图
        "https://oss.example.com/listing/ai-redraw/old.png",     # AI 图不当参考
    ])
    _mock_gc(monkeypatch)
    _publish(db_session, sku, info)
    [job] = db_session.query(AiRedrawJob).all()
    assert job.source_image_url == "", "没有能用的同款实拍图 → 文生图(要人确认)"


def test_falls_back_to_sibling_own_photos(db_session, monkeypatch, _stubs):
    sku, _, info = _seed(db_session, sibling_images=[SIBLING_PHOTO])
    _mock_gc(monkeypatch)
    _publish(db_session, sku, info)
    [job] = db_session.query(AiRedrawJob).all()
    assert job.source_image_url.startswith(SIBLING_PHOTO)


# ---------- 没同款:文生图要人确认 ----------

def test_text_to_image_waits_for_confirmation_then_publishes(db_session, monkeypatch, _stubs):
    sku, _, info = _seed(db_session, shops=("闲鱼A", "闲鱼B"))
    calls = _mock_gc(monkeypatch)
    rows, waiting = _publish(db_session, sku, info)
    assert waiting and calls == []
    [job] = db_session.query(AiRedrawJob).all()
    assert job.source_image_url == "", "不拿封面当参考:封面里有订单截图"
    assert all(r.publish_status == ShopListingStatus.LISTING and r.ai_image_job_id == job.id
               for r in _rows(db_session, sku))
    db_session.refresh(info)
    assert info.status == ListingInfoStatus.PUBLISHING

    _finish_job(db_session)
    assert asyncio.run(AIP.advance_waiting(db_session)) == 0, "文生图出来了也不发,等人确认"
    db_session.refresh(info)
    assert info.images == [OSS] and info.ai_image_unconfirmed is True and calls == []
    assert asyncio.run(AIP.advance_waiting(db_session)) == 0 and calls == []

    assert AIP.confirm(db_session, info) == 2
    assert asyncio.run(AIP.advance_waiting(db_session)) == 2
    assert calls[0]["images"] == [OSS]
    assert all(r.gc_job_id and not r.ai_image_job_id for r in _rows(db_session, sku))


def test_publishing_again_while_unconfirmed_keeps_waiting(db_session, monkeypatch, _stubs):
    sku, _, info = _seed(db_session)
    calls = _mock_gc(monkeypatch)
    _publish(db_session, sku, info)
    _finish_job(db_session)
    asyncio.run(AIP.advance_waiting(db_session))
    db_session.refresh(info)
    rows, waiting = _publish(db_session, sku, info)
    assert waiting and calls == [] and db_session.query(AiRedrawJob).count() == 1


def test_regenerate_with_category_hint(db_session, monkeypatch, _stubs):
    sku, _, info = _seed(db_session)
    _mock_gc(monkeypatch)
    _publish(db_session, sku, info)
    _finish_job(db_session)
    asyncio.run(AIP.advance_waiting(db_session))
    db_session.refresh(info)
    assert info.ai_image_unconfirmed

    new = AIP.regenerate(db_session, sku, info, "显示器")
    assert "显示器 盛色 N50PRO6" in new.prompt
    db_session.refresh(info)
    assert info.images == [] and info.ai_image_unconfirmed is False, "不对的图清掉"
    assert all(r.ai_image_job_id == new.id for r in _rows(db_session, sku))


def test_regenerate_needs_waiting_shops_and_confirm_needs_an_image(db_session, monkeypatch):
    sku, _, info = _seed(db_session)
    with pytest.raises(ValueError, match="先点上架"):
        AIP.regenerate(db_session, sku, info, "")
    with pytest.raises(ValueError, match="没有待确认"):
        AIP.confirm(db_session, info)


# ---------- 失败路径 ----------

def test_provider_without_text_to_image_says_so(db_session, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "redraw_provider", "alapi")
    sku, _, info = _seed(db_session)
    _mock_gc(monkeypatch)
    with pytest.raises(ValueError, match="上传商品主图"):
        _publish(db_session, sku, info)


def test_generation_failed_marks_shops_failed_with_reason(db_session, monkeypatch):
    sku, _, info = _seed(db_session, shops=("闲鱼A", "闲鱼B"))
    _mock_gc(monkeypatch)
    _publish(db_session, sku, info)
    _finish_job(db_session, status="FAILED", error="没有按照预期生成图片")
    assert asyncio.run(AIP.advance_waiting(db_session)) == 2
    for r in _rows(db_session, sku):
        assert r.publish_status == ShopListingStatus.FAILED and not r.ai_image_job_id
        assert "AI 生成主图失败" in r.last_error and "上传商品主图" in r.last_error


def test_generation_stuck_times_out(db_session, monkeypatch):
    sku, _, info = _seed(db_session)
    _mock_gc(monkeypatch)
    _publish(db_session, sku, info)
    _finish_job(db_session, status="RUNNING", created=datetime.utcnow() - AIP.JOB_TIMEOUT - timedelta(minutes=1))
    assert asyncio.run(AIP.advance_waiting(db_session)) == 1
    assert "超时" in _rows(db_session, sku)[0].last_error


def test_real_photos_uploaded_while_waiting_are_used_instead(db_session, monkeypatch):
    sku, _, info = _seed(db_session)
    _mock_gc(monkeypatch)
    _publish(db_session, sku, info)
    info.images = ["oss/sku/product/real.jpg"]
    db_session.commit()
    calls = _mock_gc(monkeypatch)
    assert asyncio.run(AIP.advance_waiting(db_session)) == 1
    assert calls[0]["images"] == ["oss/sku/product/real.jpg"]


def test_gc_rejects_after_image_ready(db_session, monkeypatch):
    sku, _, info = _seed(db_session, sibling_listing_images=[SIBLING_PHOTO])
    _mock_gc(monkeypatch)
    _publish(db_session, sku, info)
    _finish_job(db_session)
    _mock_gc(monkeypatch, reject="售价必须大于 0 元，请填写正确售价后再上架")
    assert asyncio.run(AIP.advance_waiting(db_session)) == 1
    r = _rows(db_session, sku)[0]
    assert r.publish_status == ShopListingStatus.FAILED and "售价" in r.last_error and not r.ai_image_job_id
    db_session.refresh(info)
    assert info.images == [OSS], "图是好的,留着下次直接用"


# ---------- 接口 ----------

def test_publish_endpoint_tells_the_page_it_is_generating_a_main_image(db_session, monkeypatch):
    from app.config import settings
    from app.routers import listing as R
    monkeypatch.setattr(settings, "gc_publish_enabled", True)
    sku, _, _ = _seed(db_session)
    _mock_gc(monkeypatch)
    res = asyncio.run(R._publish_sku_response(db_session, sku.sku_code, None))
    assert res["ai_image"] is True and res["job_id"] is None and res["shops"] == 1
    assert "AI 生成主图" in res["message"]


def test_publish_endpoint_unchanged_when_there_are_photos(db_session, monkeypatch):
    from app.config import settings
    from app.routers import listing as R
    monkeypatch.setattr(settings, "gc_publish_enabled", True)
    sku, _, _ = _seed(db_session, sku_images=["oss/sku/product/a.jpg"])
    _mock_gc(monkeypatch)
    res = asyncio.run(R._publish_sku_response(db_session, sku.sku_code, None))
    assert res == {"gc": True, "async": True, "job_id": "job-pub-1", "shops": 1}


def test_confirm_and_regenerate_endpoints(db_session, monkeypatch, _stubs):
    from fastapi import HTTPException

    from app.routers import listing as R
    from app.schemas.listing import AiImageRegenerateRequest
    sku, _, info = _seed(db_session)
    _mock_gc(monkeypatch)
    with pytest.raises(HTTPException) as e:
        R.confirm_ai_image(sku.sku_code, db=db_session, _=None)
    assert e.value.status_code == 400
    _publish(db_session, sku, info)
    _finish_job(db_session)
    asyncio.run(AIP.advance_waiting(db_session))
    res = R.regenerate_ai_image(sku.sku_code, AiImageRegenerateRequest(hint="显示器"), db=db_session, _=None)
    assert res["ok"] and "重新生成" in res["message"]
    _finish_job(db_session)
    asyncio.run(AIP.advance_waiting(db_session))
    res = R.confirm_ai_image(sku.sku_code, db=db_session, _=None)
    assert res["ok"] and res["shops"] == 1 and "马上开始上架" in res["message"]


def test_saving_the_form_only_counts_as_confirming_when_images_change(db_session, monkeypatch, _stubs):
    from app.routers import listing as R
    from app.schemas.listing import ListingInfoUpdate
    sku, _, info = _seed(db_session)
    _mock_gc(monkeypatch)
    _publish(db_session, sku, info)
    _finish_job(db_session)
    asyncio.run(AIP.advance_waiting(db_session))

    def save(images):
        body = ListingInfoUpdate(title="t", desc="d", price=Decimal("369.05"), images=images,
                                 stuff_status=95)
        return R.save_listing(sku.sku_code, body, db=db_session, user=type("U", (), {"id": None})())

    out = save([OSS + "?OSSAccessKeyId=k&Expires=1&Signature=x"])
    assert out.ai_image_unconfirmed is True, "原样存回那张 AI 图不算确认"
    out = save(["oss/sku/product/real.jpg"])
    assert out.ai_image_unconfirmed is False, "换成实拍图 = 不用 AI 图了"
