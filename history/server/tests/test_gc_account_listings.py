"""设备列表点进一个闲鱼号:它发过的商品(禅道 #101)。"""
from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.database import get_db
from app.deps import create_access_token
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus, StaffRole, StaffStatus
from app.main import app
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing, Staff

T0 = datetime(2026, 11, 9, 2, 0)


@pytest.fixture()
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _auth(db, role):
    staff = Staff(staff_no=f"no-{role}", username=f"u-{role}", password_hash="x", name="u",
                  role=role, status=StaffStatus.ACTIVE)
    db.add(staff)
    db.commit()
    return {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


def _sku(db, code, status=SkuStatus.IN_STOCK, title=None, price=None):
    sku = Sku(sku_code=code, product_name=f"商品{code}", purchase_order_id="po", inspection_id=f"in-{code}",
              cost_price=Decimal("1"), status=status)
    db.add(sku)
    db.flush()
    if title:
        db.add(SkuListingInfo(sku_id=sku.id, title=title, desc=f"{title} 的描述", price=Decimal(price),
                              status=ListingInfoStatus.PUBLISHED))
    return sku


def _seed(db):
    shop = SaleShop(code="gc-a", label="号A", xianyu_user_name="号A", gc_account_id="acc-a", enabled=True)
    old = SaleShop(code="old-a", label="号A老店", xianyu_user_name="号A", gc_account_id="acc-a", enabled=False)
    other = SaleShop(code="gc-b", label="号B", xianyu_user_name="号B", gc_account_id="acc-b", enabled=True)
    db.add_all([shop, old, other])
    db.flush()
    on_sale = _sku(db, "S1", title="AOC 24寸显示器", price="499")
    sold = _sku(db, "S2", status=SkuStatus.SHIPPED, title="小米净化器", price="300")
    twice = _sku(db, "S3", title="罗技鼠标", price="80")
    elsewhere = _sku(db, "S4", title="别的号的货", price="1")
    db.add_all([
        SkuShopListing(sku_id=on_sale.id, sale_shop_id=shop.id, gc_account_id="acc-a",
                       publish_status=ShopListingStatus.LISTED, created_at=T0, updated_at=T0),
        SkuShopListing(sku_id=sold.id, sale_shop_id=shop.id, gc_account_id=None,
                       publish_status=ShopListingStatus.SOLD, sold_at=T0, created_at=T0, updated_at=T0),
        # 同一件货挂在同一个号的两个店铺上:只算一条,留在架的
        SkuShopListing(sku_id=twice.id, sale_shop_id=old.id, gc_account_id=None,
                       publish_status=ShopListingStatus.DELISTED, created_at=T0, updated_at=T0),
        SkuShopListing(sku_id=twice.id, sale_shop_id=shop.id, gc_account_id="acc-a",
                       publish_status=ShopListingStatus.LISTED, created_at=T0, updated_at=T0 + timedelta(hours=1)),
        # 店铺是 B 的,但行上写的是别的号:按行上的号算,不归 A
        SkuShopListing(sku_id=elsewhere.id, sale_shop_id=other.id, gc_account_id="acc-b",
                       publish_status=ShopListingStatus.LISTED, created_at=T0, updated_at=T0),
    ])
    db.commit()


def test_account_listings(client, db_session):
    _seed(db_session)
    r = client.get("/api/gc-ops/accounts/acc-a/listings", headers=_auth(db_session, StaffRole.SALES))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["shop_labels"]) == {"号A", "号A老店"}
    assert body["counts"] == {"LISTED": 2, "SOLD": 1}
    codes = [i["sku_code"] for i in body["items"]]
    assert codes == ["S3", "S1", "S2"]          # 在售在前,同状态新的在前;S4 不是这个号的
    s1 = body["items"][1]
    assert s1["title"] == "AOC 24寸显示器" and s1["desc"] == "AOC 24寸显示器 的描述"
    assert float(s1["price"]) == 499


def test_account_listings_empty_and_auth(client, db_session):
    assert client.get("/api/gc-ops/accounts/acc-x/listings").status_code == 401
    r = client.get("/api/gc-ops/accounts/acc-x/listings", headers=_auth(db_session, StaffRole.WAREHOUSE))
    assert r.status_code == 200
    assert r.json() == {"account_id": "acc-x", "shop_labels": [], "counts": {}, "items": []}
