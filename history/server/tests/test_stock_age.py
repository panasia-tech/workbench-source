"""商品详情页的库龄和自动上架管理。gc client 全 monkeypatch。"""
import asyncio
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest

import app.services.gc_bridge.assembler as ASM
from app.config import settings
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing
from app.services import stock_age as S
from app.services.gc_bridge import client as gc

# 北京时间 2026-11-02 12:00
NOW = datetime(2026, 11, 2, 4, 0)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setattr(ASM, "sign_oss_publish_image_url", lambda u, expires=86400: f"{u}?signed")
    monkeypatch.setattr(settings, "gc_publish_enabled", True)
    monkeypatch.setattr(settings, "gc_publish_confirm", True)
    monkeypatch.setattr(settings, "listing_refresh_enabled", True)


def _seed(db, *, inbound=None, status=SkuStatus.IN_STOCK, publish=ShopListingStatus.LISTED):
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1"), status=status, images=["oss/sku/product/a.jpg"],
              suggest_price=Decimal("100"), inbound_at=inbound or NOW - timedelta(days=12))
    shop = SaleShop(code="gc-1", label="店1", xianyu_user_name="店1", gc_account_id="acc-1", enabled=True,
                    sort_order=0, worry_free_sell=False)
    db.add_all([sku, shop])
    db.flush()
    db.add(SkuListingInfo(sku_id=sku.id, images=["oss/sku/product/b.jpg"], price=Decimal("520"),
                          express_fee=Decimal("0"), status=ListingInfoStatus.PUBLISHED))
    db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_account_id="acc-1", publish_status=publish))
    db.commit()
    return sku, shop


def _ledger(monkeypatch, *, published=NOW - timedelta(days=6), status="LIVE", blocker=None, usable=True):
    calls = []

    async def get_refresh_status(sku):
        return {"min_age_days": 7, "items": [{
            "listing_id": "lst-1", "account_id": "acc-1", "status": status, "item_id": "i1",
            "published_at": published.isoformat(), "usable": usable, "blocker": blocker}]}

    async def create_refresh_job(listing_id, spec, source="ERP"):
        calls.append((listing_id, source))
        return {"id": "job-1"}

    monkeypatch.setattr(gc, "get_refresh_status", get_refresh_status)
    monkeypatch.setattr(gc, "create_refresh_job", create_refresh_job)
    return calls


@pytest.mark.parametrize("days,stage", [(0, "normal"), (13, "normal"), (14, "clearance"), (30, "clearance"), (31, "stale")])
def test_stage_boundaries(days, stage):
    sku = Sku(inbound_at=NOW - timedelta(days=days))
    out = S.stock_age(sku, S.DEFAULT_THRESHOLDS, NOW)
    assert (out["days"], out["stage"]) == (days, stage)


def test_days_count_by_china_calendar():
    # 北京时间 11-01 23:50 入库，11-02 00:10 看：过了零点算 1 天
    sku = Sku(inbound_at=datetime(2026, 11, 1, 15, 50))
    assert S.stock_age(sku, S.DEFAULT_THRESHOLDS, datetime(2026, 11, 1, 16, 10))["days"] == 1


def test_thresholds_default_save_and_reject_disorder(db_session):
    assert S.get_thresholds(db_session) == S.DEFAULT_THRESHOLDS
    with pytest.raises(S.StockAgeError):
        S.save_thresholds(db_session, 14, 14, 30, "u1")
    S.save_thresholds(db_session, 5, 10, 20, "u1")
    assert S.get_thresholds(db_session) == {"target_days": 5, "clearance_days": 10, "max_days": 20}


def test_next_run_is_first_0930_after_seven_days(db_session, monkeypatch):
    sku, shop = _seed(db_session)
    # 北京时间 10-27 14:32 发的：满 7 天在 11-03 14:32，那天 09:30 还不够，轮到 11-04
    _ledger(monkeypatch, published=datetime(2026, 10, 27, 6, 32))
    out = asyncio.run(S.build_stock_age(db_session, sku, now=NOW))
    assert out["auto_refresh"]["next_at"] == "2026-11-04 09:30"
    assert out["auto_refresh"]["next_in_days"] == 2
    assert out["auto_refresh"]["last_at"] == "2026-10-27 14:32"
    assert out["shops"][0]["shop_id"] == shop.id and out["shops"][0]["can_refresh"]


def test_overdue_link_shows_next_run_not_a_past_time(db_session, monkeypatch):
    sku, _ = _seed(db_session)
    _ledger(monkeypatch, published=NOW - timedelta(days=20), blocker="48 小时内有买家问过,先不动")
    out = asyncio.run(S.build_stock_age(db_session, sku, now=NOW))
    assert out["auto_refresh"]["next_at"] == "2026-11-03 09:30"
    assert not out["shops"][0]["can_refresh"]


def test_postpone_moves_next_and_pause_clears_it(db_session, monkeypatch):
    sku, _ = _seed(db_session)
    _ledger(monkeypatch, published=datetime(2026, 10, 27, 6, 32))
    S.set_auto_refresh(sku, {"not_before": date(2026, 11, 20)}, now=NOW)
    assert asyncio.run(S.build_stock_age(db_session, sku, now=NOW))["auto_refresh"]["next_at"] == "2026-11-20 09:30"
    S.set_auto_refresh(sku, {"paused": True}, now=NOW)
    assert asyncio.run(S.build_stock_age(db_session, sku, now=NOW))["auto_refresh"]["next_at"] is None
    # 旧链接已删的不受暂停影响：第二天 09:30 就要发回去
    _ledger(monkeypatch, status="PENDING_REPUBLISH")
    assert asyncio.run(S.build_stock_age(db_session, sku, now=NOW))["auto_refresh"]["next_at"] == "2026-11-03 09:30"


def test_phone_account_has_no_next_run(db_session, monkeypatch):
    sku, _ = _seed(db_session)
    _ledger(monkeypatch, usable=False, blocker="删链接只有网页版做得了,这个号不在浏览器上")
    out = asyncio.run(S.build_stock_age(db_session, sku, now=NOW))
    assert out["auto_refresh"]["next_at"] is None and out["shops"][0]["note"]


def test_gc_down_still_shows_stock_age(db_session, monkeypatch):
    sku, _ = _seed(db_session)

    async def boom(sku):
        raise RuntimeError("gc down")

    monkeypatch.setattr(gc, "get_refresh_status", boom)
    out = asyncio.run(S.build_stock_age(db_session, sku, now=NOW))
    assert out["stock_age"]["days"] == 12 and out["auto_refresh"]["ledger_ok"] is False


@pytest.mark.parametrize("bad", [date(2026, 11, 2), date(2026, 10, 1), date(2027, 3, 1)])
def test_postpone_rejects_today_past_and_far_future(db_session, bad):
    sku, _ = _seed(db_session)
    with pytest.raises(S.StockAgeError):
        S.set_auto_refresh(sku, {"not_before": bad}, now=NOW)


def test_refresh_now_ignores_pause_and_creates_job(db_session, monkeypatch):
    sku, _ = _seed(db_session)
    sku.auto_refresh_paused = True
    db_session.commit()
    calls = _ledger(monkeypatch)
    out = asyncio.run(S.refresh_now(db_session, sku, None, "u1", now=NOW))
    assert out == {"created": 1, "skipped": []} and calls == [("lst-1", "MANUAL")]


@pytest.mark.parametrize("kw,why", [
    ({"published": NOW - timedelta(hours=3)}, "上架还不到 24 小时"),
    ({"blocker": "48 小时内有买家问过,先不动"}, "48 小时内有买家问过,先不动"),
])
def test_refresh_now_skips_with_reason(db_session, monkeypatch, kw, why):
    sku, _ = _seed(db_session)
    calls = _ledger(monkeypatch, **kw)
    out = asyncio.run(S.refresh_now(db_session, sku, None, "u1", now=NOW))
    assert calls == [] and out == {"created": 0, "skipped": [{"shop": "店1", "why": why}]}


def test_refresh_now_only_selected_shop(db_session, monkeypatch):
    sku, _ = _seed(db_session)
    calls = _ledger(monkeypatch)
    out = asyncio.run(S.refresh_now(db_session, sku, ["other"], "u1", now=NOW))
    assert calls == [] and out["created"] == 0


def test_refresh_now_refused_when_switch_off(db_session, monkeypatch):
    sku, _ = _seed(db_session)
    monkeypatch.setattr(settings, "listing_refresh_enabled", False)
    with pytest.raises(S.StockAgeError):
        asyncio.run(S.refresh_now(db_session, sku, None, "u1", now=NOW))
