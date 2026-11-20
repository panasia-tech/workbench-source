"""gc 售出同步:gc SOLD 账本 → ERP 标店 SOLD + 锁库存 + 全账号下架(delist_sku)。

gc client 全 monkeypatch(不连真 gc);async 用 asyncio.run 直调。
"""
import asyncio
from decimal import Decimal

import app.services.gc_bridge.sold_sync as S
from app.enums import ReserveSource, ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuShopListing


def _seed(db, *, sku_status=SkuStatus.IN_STOCK):
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1"), status=sku_status,
              images=["oss/sku/product/a.jpg"], suggest_price=Decimal("100"))
    shop_sold = SaleShop(code="gc-a1", label="售出店", xianyu_user_name="售出店",
                         gc_account_id="acc-1", enabled=True, sort_order=0)
    shop_live = SaleShop(code="gc-a2", label="在架店", xianyu_user_name="在架店",
                         gc_account_id="acc-2", enabled=True, sort_order=1)
    db.add_all([sku, shop_sold, shop_live])
    db.flush()
    row_sold = SkuShopListing(sku_id=sku.id, sale_shop_id=shop_sold.id,
                              gc_account_id="acc-1", publish_status=ShopListingStatus.LISTED)
    row_live = SkuShopListing(sku_id=sku.id, sale_shop_id=shop_live.id,
                              gc_account_id="acc-2", publish_status=ShopListingStatus.LISTED)
    db.add_all([row_sold, row_live])
    db.commit()
    return sku, row_sold, row_live


def _mock_gc(monkeypatch, sold_listings):
    calls = {"delist": [], "delist_accounts": []}

    async def list_listings(sku=None, account_id=None, status=None):
        return sold_listings if status == "SOLD" else []

    async def create_delist_job(sku, source="ERP", account_ids=None):
        calls["delist"].append(sku)
        calls["delist_accounts"].append(account_ids)
        return {"id": "job-del-1"}

    # sold_sync 与 listing_ops 共用同一 client 模块对象,patch 一处即全局
    monkeypatch.setattr(S.gc, "list_listings", list_listings)
    monkeypatch.setattr(S.gc, "create_delist_job", create_delist_job)
    return calls


def test_sold_marks_row_reserves_sku_and_delists_others(db_session, monkeypatch):
    sku, row_sold, row_live = _seed(db_session)
    calls = _mock_gc(monkeypatch, [{"sku": "SK1", "account_id": "acc-1"}])

    stats = asyncio.run(S.sync_gc_sold(db_session))

    assert stats == {"sold": 1, "delist_jobs": 1, "skipped": 0}
    # 售出店铺行:SOLD 终态
    assert row_sold.publish_status == ShopListingStatus.SOLD and row_sold.sold_at is not None
    # SKU 锁占用(待发货)
    assert sku.status == SkuStatus.RESERVED and sku.reserve_source == ReserveSource.PLATFORM_SOLD
    # 其它在架店铺:建了全账号下架作业,行上打了在途标记(等回写 DELISTED)
    assert calls["delist"] == ["SK1"]
    assert calls["delist_accounts"] == [None]   # 不带账号过滤:「下架所选店铺」的过滤不能漏到售出这条路上
    assert row_live.gc_job_id == "job-del-1" and row_live.publish_status == ShopListingStatus.LISTED


def test_second_run_idempotent(db_session, monkeypatch):
    sku, row_sold, row_live = _seed(db_session)
    calls = _mock_gc(monkeypatch, [{"sku": "SK1", "account_id": "acc-1"}])
    asyncio.run(S.sync_gc_sold(db_session))
    # 回写完成后 row_live 已 DELISTED(gc_job_id 清空)
    row_live.publish_status = ShopListingStatus.DELISTED
    row_live.gc_job_id = None
    db_session.commit()

    stats = asyncio.run(S.sync_gc_sold(db_session))
    assert stats["sold"] == 0 and stats["delist_jobs"] == 0
    assert calls["delist"] == ["SK1"]          # 没重复建下架作业
    assert row_sold.publish_status == ShopListingStatus.SOLD   # 终态不被回退


def test_retries_delist_when_previous_round_in_flight(db_session, monkeypatch):
    # 首轮其它店铺有在途作业 → 不建下架;下轮在途清了 → 补建(不丢下架)
    sku, row_sold, row_live = _seed(db_session)
    row_live.gc_job_id = "job-pub-x"         # 模拟在途
    db_session.commit()
    calls = _mock_gc(monkeypatch, [{"sku": "SK1", "account_id": "acc-1"}])

    stats1 = asyncio.run(S.sync_gc_sold(db_session))
    assert stats1["delist_jobs"] == 0 and calls["delist"] == []

    row_live.gc_job_id = None                # 在途结束
    db_session.commit()
    stats2 = asyncio.run(S.sync_gc_sold(db_session))
    assert stats2["sold"] == 0               # 店铺行已 SOLD,不重复标
    assert stats2["delist_jobs"] == 1 and calls["delist"] == ["SK1"]


def test_other_shop_mid_selected_delist_does_not_hold_back_full_delist(db_session, monkeypatch):
    # 售出时另一家店正在「下架所选店铺」(那单只下它自己,设备离线能排 12 小时):
    # 不能等它跑完才建全网下架,其余在架店铺这段时间还能被买走
    sku, row_sold, row_live = _seed(db_session)
    shop3 = SaleShop(code="gc-a3", label="下架中店", xianyu_user_name="下架中店",
                     gc_account_id="acc-3", enabled=True, sort_order=2)
    db_session.add(shop3)
    db_session.flush()
    row_busy = SkuShopListing(sku_id=sku.id, sale_shop_id=shop3.id, gc_account_id="acc-3",
                              gc_job_id="job-del-selected", publish_status=ShopListingStatus.LISTED)
    db_session.add(row_busy)
    db_session.commit()
    calls = _mock_gc(monkeypatch, [{"sku": "SK1", "account_id": "acc-1"}])

    stats = asyncio.run(S.sync_gc_sold(db_session))
    assert stats["delist_jobs"] == 1
    assert calls["delist_accounts"] == [None]          # 全账号,连同正在下架的那家一起
    assert row_live.gc_job_id == "job-del-1"

    stats2 = asyncio.run(S.sync_gc_sold(db_session))   # 在架行都带作业号了:不每轮重复建
    assert stats2["delist_jobs"] == 0 and calls["delist"] == ["SK1"]


def test_shipped_sku_still_delists_but_not_reserved(db_session, monkeypatch):
    sku, row_sold, row_live = _seed(db_session, sku_status=SkuStatus.SHIPPED)
    calls = _mock_gc(monkeypatch, [{"sku": "SK1", "account_id": "acc-1"}])
    stats = asyncio.run(S.sync_gc_sold(db_session))
    assert sku.status == SkuStatus.SHIPPED   # 已出库不再锁
    assert stats["delist_jobs"] == 1 and calls["delist"] == ["SK1"]


def test_unknown_sku_skipped(db_session, monkeypatch):
    _mock_gc(monkeypatch, [{"sku": "NOPE", "account_id": "acc-1"}])
    stats = asyncio.run(S.sync_gc_sold(db_session))
    assert stats == {"sold": 0, "delist_jobs": 0, "skipped": 1}


# ---- 11-11 #111 核查补的漏洞:换码后账本对不上、该下没下掉的链接没人知道 ----
from app.enums import StaffRole, StaffStatus, StockEventType  # noqa: E402
from app.models import EventLog, Staff, StockEvent  # noqa: E402


def test_heal_pushes_recodes_in_order(db_session, monkeypatch):
    sku, _, _ = _seed(db_session)
    from datetime import datetime, timedelta
    t0 = datetime(2026, 10, 30)
    db_session.add_all([
        StockEvent(sku_id=sku.id, event_type=StockEventType.RECODE, created_at=t0 + timedelta(days=1),
                   payload={"old": "MID", "new": "SK1"}),
        StockEvent(sku_id=sku.id, event_type=StockEventType.RECODE, created_at=t0,
                   payload={"old": "OLD", "new": "MID"}),
        StockEvent(sku_id=sku.id, event_type="INBOUND", payload={"old": "X", "new": "Y"}),
    ])
    db_session.commit()
    sent = []

    async def recode_listings(pairs):
        sent.append(pairs)
        return 2

    monkeypatch.setattr(S.gc, "recode_listings", recode_listings)
    assert asyncio.run(S.heal_recoded_listings(db_session)) == 2
    assert sent == [[{"old": "OLD", "new": "MID", "at": "2026-10-30T00:00:00"},
                     {"old": "MID", "new": "SK1", "at": "2026-10-31T00:00:00"}]]


def test_heal_sends_reused_old_codes_with_time(db_session, monkeypatch):
    # 06 月 sancg73→TMP-010,之后另一台 G73 又建成 sancg73:照样推,带上换码时间,gc 只改那之前建的链接
    # (原来按「现在有货在用」跳过,后来那台再换号就不算在用了,06 月那条又把它的链接改走)
    sku, _, _ = _seed(db_session)
    from datetime import datetime
    other = Sku(sku_code="sancg73", product_name="盛色 G73", purchase_order_id="po1", inspection_id="in1",
                cost_price=Decimal("1"), status=SkuStatus.IN_STOCK)
    db_session.add(other)
    db_session.add(StockEvent(sku_id=sku.id, event_type=StockEventType.RECODE, created_at=datetime(2026, 6, 1),
                              payload={"old": "SANCG73", "new": "TMP-010"}))
    db_session.commit()
    sent = []

    async def recode_listings(pairs):
        sent.append(pairs)
        return 0

    monkeypatch.setattr(S.gc, "recode_listings", recode_listings)
    asyncio.run(S.heal_recoded_listings(db_session))
    assert sent == [[{"old": "SANCG73", "new": "TMP-010", "at": "2026-06-01T00:00:00"}]]


def _admin(db):
    db.add(Staff(staff_no="A", username="admin", name="管理员", role=StaffRole.ADMIN,
                 status=StaffStatus.ACTIVE, password_hash="x"))
    db.commit()


def _mock_stuck(monkeypatch, listings=(), accounts=()):
    async def list_listings(sku=None, account_id=None, status=None):
        return [l for l in listings if l["sku"] == sku]

    async def list_accounts():
        return list(accounts)

    monkeypatch.setattr(S.gc, "list_listings", list_listings)
    monkeypatch.setattr(S.gc, "list_accounts", list_accounts)


def test_shipped_but_still_live_notifies_once(db_session, monkeypatch):
    _admin(db_session)
    sku, row_sold, row_live = _seed(db_session, sku_status=SkuStatus.SHIPPED)
    # ERP 两行都还写着在架,gc 账本里只有 acc-2 真的还挂着
    _mock_stuck(monkeypatch, listings=[{"sku": "SK1", "account_id": "acc-1", "status": "DELISTED"},
                                       {"sku": "SK1", "account_id": "acc-2", "status": "LIVE"}])
    sent = []
    note = lambda staff, title, body: sent.append((title, body))  # noqa: E731
    assert asyncio.run(S.warn_stuck_listings(db_session, notifier=note)) == {"left_live": 1, "frozen": 0}
    assert len(sent) == 1 and sent[0][0] == "出库后链接没下掉"
    assert "在架店" in sent[0][1] and "售出店" not in sent[0][1]
    # 下一轮(5 分钟后)不再发
    asyncio.run(S.warn_stuck_listings(db_session, notifier=note))
    assert len(sent) == 1
    assert db_session.query(EventLog).filter(EventLog.event_type == S.LEFT_EVENT).count() == 1


def test_in_stock_or_already_gone_does_not_notify(db_session, monkeypatch):
    _admin(db_session)
    _seed(db_session)   # 在库的货挂着是正常的
    _mock_stuck(monkeypatch, listings=[{"sku": "SK1", "account_id": "acc-2", "status": "LIVE"}])
    sent = []
    assert asyncio.run(S.warn_stuck_listings(db_session, notifier=lambda *a: sent.append(a))) == \
        {"left_live": 0, "frozen": 0}
    assert sent == []


def test_delist_stuck_on_frozen_account_notifies_once(db_session, monkeypatch):
    _admin(db_session)
    sku, row_sold, row_live = _seed(db_session, sku_status=SkuStatus.SHIPPED)
    row_sold.publish_status = ShopListingStatus.SOLD
    row_live.gc_job_id = "job-del-1"      # 下架中
    db_session.commit()
    _mock_stuck(monkeypatch, accounts=[{"id": "acc-1", "status": "ACTIVE", "risk_state": "NORMAL"},
                                       {"id": "acc-2", "status": "FROZEN", "risk_state": "FROZEN"}])
    sent = []
    note = lambda staff, title, body: sent.append((title, body))  # noqa: E731
    # 刚卡上不说（冻结也包括掉登录，通常几分钟自己好）
    assert asyncio.run(S.warn_stuck_listings(db_session, notifier=note))["frozen"] == 0
    from datetime import datetime, timedelta
    row_live.updated_at = datetime.utcnow() - timedelta(hours=3)
    db_session.commit()
    assert asyncio.run(S.warn_stuck_listings(db_session, notifier=note))["frozen"] == 1
    assert "在架店" in sent[0][1] and "冻结" in sent[0][1] and "解冻后会自动下" in sent[0][1]
    asyncio.run(S.warn_stuck_listings(db_session, notifier=note))
    assert len(sent) == 1


def test_delist_on_healthy_account_is_not_stuck(db_session, monkeypatch):
    _admin(db_session)
    sku, _, row_live = _seed(db_session, sku_status=SkuStatus.SHIPPED)
    row_live.gc_job_id = "job-del-1"
    db_session.commit()
    _mock_stuck(monkeypatch, accounts=[{"id": "acc-2", "status": "ACTIVE", "risk_state": "NORMAL"}])
    assert asyncio.run(S.warn_stuck_listings(db_session, notifier=lambda *a: None)) == \
        {"left_live": 0, "frozen": 0}


def test_list_listings_reads_every_page(monkeypatch):
    # gc 一页最多 200:不翻页的话已售账本过了 50 条(默认页大小),后面的售出就同步不到
    from app.services.gc_bridge import client as C
    pages = []

    async def _get(path, params=None):
        pages.append(params["page"])
        return [{"i": n} for n in range(C._LISTING_PAGE if params["page"] < 3 else 7)]

    monkeypatch.setattr(C, "_get", _get)
    rows = asyncio.run(C.list_listings(status="SOLD"))
    assert pages == [1, 2, 3] and len(rows) == 2 * C._LISTING_PAGE + 7


def test_buyer_cancelled_releases_and_sync_does_not_relock(db_session, monkeypatch):
    """买家发货前取消：放回在库，已售店铺行改已下架；gc 那条一直是 SOLD，下一轮不能再锁回去。"""
    sku, row_sold, _ = _seed(db_session)
    _mock_gc(monkeypatch, [{"id": "L1", "sku": "SK1", "account_id": "acc-1"}])
    asyncio.run(S.sync_gc_sold(db_session))
    assert sku.reserve_source == ReserveSource.PLATFORM_SOLD
    S.release_platform_sold(db_session, sku, ["L1"], None, "买家拍错了退款")
    db_session.commit()
    assert sku.status == SkuStatus.IN_STOCK and sku.reserve_source is None
    assert row_sold.publish_status == ShopListingStatus.DELISTED
    stats = asyncio.run(S.sync_gc_sold(db_session))
    assert stats["sold"] == 0 and sku.status == SkuStatus.IN_STOCK
    # 不是平台售出锁定的不给放
    import pytest
    with pytest.raises(ValueError):
        S.release_platform_sold(db_session, sku, [], None, "再点一次")
