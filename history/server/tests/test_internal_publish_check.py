"""群控真机发布前回 ERP 再核一次（E05-10）。

钉死的口径：
  1. 货不在库、被锁、这家店（同一个闲鱼号）已在架/已售 → 不能发；这单被新作业顶掉了也不能发。
  2. 开了上架审批：这一单要发的店铺现在的批准还得能用；批准又改过版本（换了价/图）也不能发。
  3. 焕新（删掉重发）不看在架、不等审批，只看货在不在库、ERP 里这家店还在不在架、有没有上下架在途。
  4. 判断不了的（ERP 里没有对应店铺行）不拦。
"""
from decimal import Decimal

import pytest

from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus, StaffRole, StaffStatus
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing, Staff
from app.routers import internal_publish_check as P
from app.routers import listing_approval as R
from app.services import listing_approval as la
from app.services.app_settings import set_setting


@pytest.fixture(autouse=True)
def _no_oss(monkeypatch):
    monkeypatch.setattr(R, "sign_oss_url", lambda u, expires=86400: u)
    monkeypatch.setattr(la, "market_of", lambda db, sku: {"price": Decimal("1500"), "basis": "成交均价",
                                                          "date": None, "query": "x"})


def _staff(db, name, role):
    row = Staff(staff_no=name, username=name, name=name, role=role, status=StaffStatus.ACTIVE, password_hash="x")
    db.add(row)
    db.flush()
    return row


@pytest.fixture()
def w(db_session):
    db = db_session
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1000"), status=SkuStatus.IN_STOCK, images=["oss/a.jpg", "oss/b.jpg"])
    s1 = SaleShop(code="s1", label="店1", xianyu_user_name="甲", enabled=True, sort_order=0, gc_account_id="acc1")
    s2 = SaleShop(code="s2", label="店2", xianyu_user_name="乙", enabled=True, sort_order=1, gc_account_id="acc2")
    db.add_all([sku, s1, s2])
    db.flush()
    db.add(SkuListingInfo(sku_id=sku.id, images=["oss/a.jpg"], price=Decimal("1100"),
                          status=ListingInfoStatus.READY))
    clerk = _staff(db, "员工", StaffRole.SALES)
    boss = _staff(db, "老板", StaffRole.ADMIN)
    db.commit()

    class W:
        pass

    x = W()
    x.db, x.sku, x.s1, x.s2, x.clerk, x.boss = db, sku, s1, s2, clerk, boss
    return x


def _row(w, shop, status=ShopListingStatus.LISTING, job="job-1", **kw):
    row = SkuShopListing(sku_id=w.sku.id, sale_shop_id=shop.id, publish_status=status,
                         gc_account_id=shop.gc_account_id, gc_job_id=job, **kw)
    w.db.add(row)
    w.db.commit()
    return row


def _approve(w, shop, price=1300, images=("oss/a.jpg",)):
    R.save_draft("SK1", shop.id, R.DraftIn(price=price, images=list(images)), w.db, w.clerk)
    R.submit("SK1", R.ShopIdsIn(shop_ids=[shop.id]), w.db, w.clerk)
    R.review("SK1", R.ReviewIn(shop_ids=[shop.id], approve=True), w.db, w.boss)
    return la.current(w.db, w.sku.id, shop.id)


def _on(w):
    set_setting(w.db, la.REQUIRED_KEY, "1", None)
    set_setting(w.db, la.RATIO_KEY, "1.00", None)
    # 这些用例验的是“提交后等别人批”的旧流程；提交即发布由 test_listing_approval 覆盖
    set_setting(w.db, la.AUTO_PUBLISH_KEY, "0", None)
    w.db.commit()


def _check(w, account="acc1", job="job-1", refresh=False):
    return P.publish_check(P.PublishCheckIn(sku_code="SK1", account_id=account, job_id=job, refresh=refresh), w.db)


# ---------------------------------------------------------------- 普通发布
def test_in_stock_and_publishing_is_allowed(w):
    _row(w, w.s1)
    assert _check(w) == {"allow": True, "reason": None}


def test_unknown_sku_is_blocked(w):
    out = P.publish_check(P.PublishCheckIn(sku_code="NOPE", account_id="acc1"), w.db)
    assert out == {"allow": False, "reason": "ERP 里没有这个货号"}


@pytest.mark.parametrize("status,reserve,reason", [
    (SkuStatus.RESERVED, None, "货不在库（已预留）"),
    (SkuStatus.SHIPPED, None, "货不在库（已出库）"),
    (SkuStatus.IN_STOCK, "SWITCH", "货已锁定"),
])
def test_sold_or_locked_stock_is_blocked(w, status, reserve, reason):
    _row(w, w.s1)
    w.sku.status, w.sku.reserve_source = status, reserve
    w.db.commit()
    assert _check(w) == {"allow": False, "reason": reason}


@pytest.mark.parametrize("status,reason", [
    (ShopListingStatus.LISTED, "这家店已经在架了"),
    (ShopListingStatus.SOLD, "这家店这件货已经卖掉了"),
])
def test_shop_already_listed_or_sold_is_blocked(w, status, reason):
    _row(w, w.s1, status=status, job=None)
    assert _check(w)["reason"] == reason


def test_other_shop_on_same_account_counts(w):
    """两个店铺挂同一个号 = 闲鱼上同一条链接。"""
    twin = SaleShop(code="s3", label="店3", xianyu_user_name="甲", enabled=True, sort_order=2, gc_account_id="acc1")
    w.db.add(twin)
    w.db.commit()
    _row(w, w.s1)
    _row(w, twin, status=ShopListingStatus.LISTED, job=None)
    assert _check(w)["reason"] == "这家店已经在架了"


def test_other_account_does_not_count(w):
    _row(w, w.s1)
    _row(w, w.s2, status=ShopListingStatus.LISTED, job=None)
    assert _check(w)["allow"] is True


def test_superseded_job_is_blocked(w):
    _row(w, w.s1, job="job-2")
    assert _check(w, job="job-1")["reason"] == "这家店已经换了一单新的上架作业，这一单作废"
    assert _check(w, job="job-2")["allow"] is True


def test_no_erp_row_is_not_blocked(w):
    """ERP 里没有店铺行：判断不了，不拦。"""
    assert _check(w, account="acc-unknown")["allow"] is True


# ---------------------------------------------------------------- 上架审批
def test_approval_on_needs_usable_approval(w):
    _on(w)
    _row(w, w.s1)
    assert _check(w)["reason"] == "上架审批：还没提交上架审批"
    approval = _approve(w, w.s1)
    w.db.query(SkuShopListing).update({SkuShopListing.listing_approval_id: approval.id})
    w.db.commit()
    assert _check(w)["allow"] is True


def test_approval_invalidated_after_job_was_created(w):
    _on(w)
    approval = _approve(w, w.s1)
    _row(w, w.s1, listing_approval_id=approval.id)
    w.sku.cost_price = Decimal("1100")
    w.db.commit()
    assert _check(w)["reason"] == "上架审批：批准之后成本变了，要重新审批"


def test_approval_edited_after_job_was_created(w):
    _on(w)
    old = _approve(w, w.s1, price=1300)
    _row(w, w.s1, listing_approval_id=old.id)
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=1350, images=["oss/a.jpg"]), w.db, w.clerk)
    assert _check(w)["reason"] == "上架审批：还没提交上架审批"
    _approve(w, w.s1, price=1350)
    assert _check(w)["reason"] == "上架审批：批准的内容改过了，这一单带的是旧的价和图"


def test_approval_falls_back_to_shops_on_account(w):
    """作业号对不上店铺行（老作业）：按挂在这个号上的启用店铺核。"""
    _on(w)
    assert _check(w, job="job-old")["reason"] == "上架审批：还没提交上架审批"
    _approve(w, w.s1)
    assert _check(w, job="job-old")["allow"] is True


def test_approval_switch_off_ignores_approval(w):
    _row(w, w.s1)
    assert _check(w)["allow"] is True


# ---------------------------------------------------------------- 焕新
def test_refresh_ignores_listed_and_approval(w):
    _on(w)
    _row(w, w.s1, status=ShopListingStatus.LISTED, job=None)
    assert _check(w, job="job-r", refresh=True) == {"allow": True, "reason": None}


def test_refresh_blocked_when_stock_gone(w):
    _row(w, w.s1, status=ShopListingStatus.LISTED, job=None)
    w.sku.status = SkuStatus.RESERVED
    w.db.commit()
    assert _check(w, job="job-r", refresh=True)["reason"] == "货不在库（已预留）"


@pytest.mark.parametrize("status,job,reason", [
    (ShopListingStatus.DELISTED, None, "ERP 里这家店已经不是在架状态"),
    (ShopListingStatus.LISTED, "job-del", "这家店还有上下架在途"),
])
def test_refresh_blocked_when_erp_shop_changed(w, status, job, reason):
    _row(w, w.s1, status=status, job=job)
    assert _check(w, job="job-r", refresh=True)["reason"] == reason


def test_route_is_registered_and_local_only():
    """走 nginx 进来的（这里 TestClient 的客户端不是本机）一律 403。"""
    from fastapi.testclient import TestClient

    from app.main import app

    resp = TestClient(app).post("/api/internal/publish-check", json={"sku_code": "SK1", "account_id": "acc1"})
    assert resp.status_code == 403 and resp.json()["detail"] == "只允许本机调用"


def test_cancelled_by_precheck_settles_the_shop_as_failed(w, monkeypatch):
    """群控按再核取消任务后，ERP 回写照现有失败路径把店铺收成 FAILED，不会卡在「上架中」。"""
    import asyncio

    import app.services.gc_bridge.listing_ops as L

    row = _row(w, w.s1)

    async def list_listings(sku, account_id=None):
        return []

    async def list_tasks(job_id):
        return [{"account_id": "acc1", "status": "CANCELLED", "failed_step": "erp_precheck",
                 "error": "发布前回 ERP 再核不通过:货不在库（已预留）"}]

    monkeypatch.setattr(L.gc, "list_listings", list_listings)
    monkeypatch.setattr(L.gc, "list_tasks", list_tasks)
    assert asyncio.run(L.sync_gc_publish_status(w.db, w.sku)) == 1
    w.db.refresh(row)
    assert row.publish_status == ShopListingStatus.FAILED and row.gc_job_id is None
    assert row.last_error == "[erp_precheck] 发布前回 ERP 再核不通过:货不在库（已预留）"
