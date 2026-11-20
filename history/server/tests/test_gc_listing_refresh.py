"""链接焕新(ERP 这一半):拉群控单子 → 判库存/店铺状态 → 现组发布内容 → 开焕新作业。

gc client 全 monkeypatch(不连真 gc);async 用 asyncio.run 直调。
"""
import asyncio
from datetime import datetime, timedelta
from decimal import Decimal

import pytest

import app.services.gc_bridge.assembler as ASM
import app.services.gc_bridge.listing_refresh as R
from app.config import settings
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing
from app.services.gc_bridge import client as gc


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setattr(ASM, "sign_oss_publish_image_url", lambda u, expires=86400: f"{u}?signed")
    monkeypatch.setattr(settings, "gc_publish_confirm", True)


def _seed(db, code="SK1", *, status=SkuStatus.IN_STOCK, publish_status=ShopListingStatus.LISTED,
          acc="acc-1", enabled=True, worry_free=False, gc_job_id=None, ai_unconfirmed=False):
    sku = Sku(sku_code=code, product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1"), status=status, images=["oss/sku/product/a.jpg"],
              suggest_price=Decimal("100"))
    shop = SaleShop(code=f"gc-{code}", label="店1", xianyu_user_name="店1", gc_account_id=acc,
                    enabled=enabled, sort_order=0, worry_free_sell=worry_free)
    db.add_all([sku, shop])
    db.flush()
    db.add(SkuListingInfo(sku_id=sku.id, images=["oss/sku/product/b.jpg"], price=Decimal("520"),
                          express_fee=Decimal("0"), status=ListingInfoStatus.PUBLISHED,
                          ai_image_unconfirmed=ai_unconfirmed))
    row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_account_id=acc,
                         publish_status=publish_status, gc_job_id=gc_job_id)
    db.add(row)
    db.commit()
    return sku, shop, row


def _item(code="SK1", acc="acc-1", lid=None, status="LIVE"):
    return {"listing_id": lid or f"lst-{code}", "sku": code, "account_id": acc,
            "account_nick": "店1", "status": status, "published_at": "2026-10-05T02:00:00"}


def _mock(monkeypatch, items, rooms=None, reject=None):
    calls = []

    async def list_refresh_candidates():
        return {"items": items, "rooms": rooms if rooms is not None else {"acc-1": 10},
                "held_for_buyers": 1, "min_age_days": 7}

    async def create_refresh_job(listing_id, spec, source="ERP"):
        if reject and listing_id in reject:
            raise reject[listing_id]
        calls.append({"listing_id": listing_id, "spec": spec, "source": source})
        return {"id": f"job-{listing_id}"}

    monkeypatch.setattr(gc, "list_refresh_candidates", list_refresh_candidates)
    monkeypatch.setattr(gc, "create_refresh_job", create_refresh_job)
    return calls


def test_in_stock_listed_item_gets_a_fresh_spec(db_session, monkeypatch):
    _seed(db_session, worry_free=True)
    calls = _mock(monkeypatch, [_item()])
    stats = asyncio.run(R.run_listing_refresh(db_session))
    assert stats["created"] == 1 and stats["skipped"] == 0
    (c,) = calls
    assert c["listing_id"] == "lst-SK1"
    spec = c["spec"]
    assert spec["images"] == ["oss/sku/product/b.jpg?signed"]   # 现签的图,不是 7 天前过期的
    assert spec["price"] == 520
    assert spec["confirm_publish"] is True
    assert spec["worry_free_sell"] is True                    # 按店铺解析
    assert stats["created_items"][0]["job_id"] == "job-lst-SK1"


@pytest.mark.parametrize("kw, why", [
    ({"status": SkuStatus.RESERVED}, "不在库"),
    ({"status": SkuStatus.SHIPPED}, "不在库"),
    ({"publish_status": ShopListingStatus.LISTING}, "不是在架"),
    ({"publish_status": ShopListingStatus.SOLD}, "不是在架"),
    ({"gc_job_id": "job-x"}, "在途"),
    ({"enabled": False}, "停用"),
    ({"ai_unconfirmed": True}, "AI 图"),
])
def test_skips(db_session, monkeypatch, kw, why):
    _seed(db_session, **kw)
    calls = _mock(monkeypatch, [_item()])
    stats = asyncio.run(R.run_listing_refresh(db_session))
    assert calls == [] and stats["created"] == 0
    assert any(why in r for r in stats["reasons"])


def test_unknown_sku_and_shop_skipped(db_session, monkeypatch):
    _seed(db_session)
    calls = _mock(monkeypatch, [_item("NOPE"), _item(acc="acc-other")], rooms={"acc-1": 10, "acc-other": 10})
    stats = asyncio.run(R.run_listing_refresh(db_session))
    assert calls == []
    assert set(stats["reasons"]) == {"ERP 里没有这个货号", "ERP 里这家店不是在架状态"}


def test_dry_run_opens_nothing(db_session, monkeypatch):
    _seed(db_session)
    calls = _mock(monkeypatch, [_item()])
    stats = asyncio.run(R.run_listing_refresh(db_session, dry_run=True))
    assert calls == [] and stats["created"] == 1


def test_room_and_limit(db_session, monkeypatch):
    for code in ("A", "B", "C"):
        _seed(db_session, code)
    calls = _mock(monkeypatch, [_item(c) for c in ("A", "B", "C")], rooms={"acc-1": 2})
    stats = asyncio.run(R.run_listing_refresh(db_session))
    assert [c["listing_id"] for c in calls] == ["lst-A", "lst-B"]
    assert stats["reasons"] == {"这个号今天的焕新额度用完了": 1}

    for code in ("D", "E"):
        _seed(db_session, code)
    calls = _mock(monkeypatch, [_item(c) for c in ("D", "E")])
    asyncio.run(R.run_listing_refresh(db_session, limit=1))
    assert [c["listing_id"] for c in calls] == ["lst-D"]


def test_gc_rejections_are_skips_not_crashes(db_session, monkeypatch):
    for code in ("A", "B", "C"):
        _seed(db_session, code)
    calls = _mock(monkeypatch, [_item(c) for c in ("A", "B", "C")], reject={
        "lst-A": gc.GcBridgeError("缺少商品图", status=400),
        "lst-B": gc.GcRefreshSkipped("这个号今天的焕新额度用完了", status=409),
    })
    stats = asyncio.run(R.run_listing_refresh(db_session))
    assert calls == []          # 群控说额度满了,同号后面的不再去问
    assert stats["reasons"] == {"发布内容不合格：缺少商品图": 1, "群控：这个号今天的焕新额度用完了": 1,
                                "这个号今天的焕新额度用完了": 1}


def test_script_refuses_fill_only_mode(monkeypatch):
    from scripts import run_listing_refresh as S
    monkeypatch.setattr(settings, "listing_refresh_enabled", True)
    monkeypatch.setattr(settings, "gc_publish_enabled", True)
    monkeypatch.setattr(settings, "gc_publish_confirm", False)
    assert "只填不发" in S._why_not(dry_run=False)
    assert S._why_not(dry_run=True) is None          # 预演只读,照样能看
    monkeypatch.setattr(settings, "listing_refresh_enabled", False)
    assert "未开启" in S._why_not(dry_run=False)


# ---------------------------------------------------------------- 详情页的暂停 / 推迟
def test_paused_sku_is_skipped_but_deleted_link_still_republishes(db_session, monkeypatch):
    sku, _, _ = _seed(db_session)
    sku.auto_refresh_paused = True
    db_session.commit()
    calls = _mock(monkeypatch, [_item()])
    stats = asyncio.run(R.run_listing_refresh(db_session))
    assert stats["created"] == 0 and stats["reasons"] == {"这件货暂停了自动上架": 1}
    assert calls == []
    # 旧链接已删：闲鱼上空着，暂停也要发回去
    calls = _mock(monkeypatch, [_item(status="PENDING_REPUBLISH")])
    assert asyncio.run(R.run_listing_refresh(db_session))["created"] == 1


def test_postponed_sku_waits_until_that_day(db_session, monkeypatch):
    sku, _, _ = _seed(db_session)
    today = (datetime.utcnow() + timedelta(hours=8)).date()
    sku.auto_refresh_not_before = today + timedelta(days=1)
    db_session.commit()
    _mock(monkeypatch, [_item()])
    assert asyncio.run(R.run_listing_refresh(db_session))["created"] == 0
    sku.auto_refresh_not_before = today
    db_session.commit()
    assert asyncio.run(R.run_listing_refresh(db_session))["created"] == 1
