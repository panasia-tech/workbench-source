"""商品详情「价格历史 / 行情价」：行情按款、在售按标题认成色、成交取同款出库价。"""
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.database import Base, get_db
from app.deps import create_access_token
from app.enums import SkuStatus, StaffRole, StaffStatus
from app.main import app
from app.models import CrawlPrice, CrawlProduct, SalesOutbound, Sku, Staff, WarehouseSpu


@pytest.fixture()
def client(db_session):
    Base.metadata.create_all(db_session.get_bind(), tables=[SalesOutbound.__table__])
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _auth(db, role, username):
    staff = Staff(staff_no=f"no-{username}", username=username, password_hash="x",
                  name=username, role=role, status=StaffStatus.ACTIVE)
    db.add(staff)
    db.commit()
    return staff, {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


def _sku(db, code, grade=None, status=SkuStatus.IN_STOCK):
    row = Sku(sku_code=code, barcode="6900000000001", purchase_order_id="po", inspection_id="in",
              product_name="Rokid 眼镜", brand="Rokid", model="X1", condition_grade=grade,
              cost_price=100, status=status, images=[])
    db.add(row)
    db.commit()
    return row


def test_price_history_market_listings_and_sales(client, db_session):
    staff, headers = _auth(db_session, StaffRole.SALES, "s1")
    db_session.add(WarehouseSpu(spu_code="6900000000001", brand="Rokid", model="X1", enabled=True))
    prod = CrawlProduct(name="Rokid X1")
    db_session.add(prod)
    db_session.flush()
    today = date.today()
    for days_ago, price in ((70, 1300), (40, 1200), (10, 1100), (1, 980)):
        raw = None
        if days_ago == 1:
            raw = {"priceBreakdown": {"includedListings": [
                {"title": "Rokid X1 9成新 全套", "price": 1080, "itemUrl": "https://www.goofish.com/item?id=1"},
                {"title": "Rokid X1 眼镜 85新", "price": 960, "itemUrl": ""},
                {"title": "Rokid X1", "price": "坏数据"},
            ]}}
        db_session.add(CrawlPrice(product_id=prod.id, crawl_date=today - timedelta(days=days_ago),
                                  price=price, raw=raw))
    base = _sku(db_session, "S-1", grade="9新")
    sold = _sku(db_session, "S-SOLD", grade="7新", status=SkuStatus.SHIPPED)
    db_session.add(SalesOutbound(outbound_no="O1", sku_id=sold.id, outbound_type="SALE", sale_price=1150,
                                 cost_price=900, operator_id=staff.id,
                                 created_at=datetime.combine(today - timedelta(days=3), datetime.min.time())))
    db_session.commit()

    res = client.get(f"/api/inventory/skus/{base.sku_code}/price-history", headers=headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["market_name"] == "Rokid X1"
    assert [p["price"] for p in body["series"]] == [1300, 1200, 1100, 980]
    st = body["stats"]
    assert st["latest"]["price"] == 980 and st["latest"]["change_pct"] == round((980 - 1200) / 1200 * 100, 1)
    assert st["avg30"]["price"] == round((1100 + 980) / 2, 2)
    assert st["high"]["price"] == 1300 and st["low"]["price"] == 980
    recs = body["records"]
    listed = [r for r in recs if r["status"] == "在售"]
    assert [(r["grade"], r["price"]) for r in listed] == [("9新", 1080), ("8新", 960)]
    sold_rows = [r for r in recs if r["status"] == "成交"]
    assert [(r["grade"], r["grade_key"], r["price"], r["channel"]) for r in sold_rows] == [("7新", "7", 1150, "我们卖出")]


def test_price_history_without_market_data(client, db_session):
    _, headers = _auth(db_session, StaffRole.WAREHOUSE, "w1")
    row = _sku(db_session, "S-NOMARKET")
    body = client.get(f"/api/inventory/skus/{row.sku_code}/price-history", headers=headers).json()
    assert body["stats"] is None and body["series"] == [] and body["records"] == []


def test_price_history_404_and_device_forbidden(client, db_session):
    _, headers = _auth(db_session, StaffRole.SALES, "s2")
    assert client.get("/api/inventory/skus/NOPE/price-history", headers=headers).status_code == 404
    _, crawler = _auth(db_session, StaffRole.CRAWLER, "c1")
    row = _sku(db_session, "S-X")
    assert client.get(f"/api/inventory/skus/{row.sku_code}/price-history", headers=crawler).status_code == 403


# ---- #108 行情图表（11-11）：按页签拆折线和统计，记录带图和发布价 ----
from app.models import SkuListingInfo  # noqa: E402


def _day(prod, d, price, listings):
    return CrawlPrice(product_id=prod.id, crawl_date=d, price=price, raw={"priceBreakdown": {
        "includedListings": [{"title": t, "price": p, "itemId": f"i{n}", "itemUrl": f"u{n}"}
                             for n, (t, p) in enumerate(listings)]}})


def test_by_grade_series_and_stats(client, db_session):
    _, headers = _auth(db_session, StaffRole.SALES, "s3")
    db_session.add(WarehouseSpu(spu_code="6900000000001", brand="Rokid", model="X1", enabled=True))
    prod = CrawlProduct(name="Rokid X1")
    db_session.add(prod)
    db_session.flush()
    last = date(2026, 11, 6)        # 采集停了几天：按最后一天往前算
    db_session.add_all([
        _day(prod, last - timedelta(days=10), 1200, [("X1 全新未拆", 1300), ("X1 9成新", 1100)]),
        _day(prod, last - timedelta(days=1), 1000, [("X1 全新", 1200), ("X1 95新", 1000), ("X1 7成新", 700)]),
        _day(prod, last, 900, [("X1 99新", 900), ("X1 6成新 屏幕划痕", 500), ("X1 眼镜", 950)]),
    ])
    base = _sku(db_session, "S-G")
    db_session.commit()

    body = client.get(f"/api/inventory/skus/{base.sku_code}/price-history", headers=headers).json()
    assert body["as_of"] == "2026-11-06"
    assert body["product_id"] == base.sku_code
    assert body["sentiment"]["basis"] == "price_trend"
    assert body["sentiment"]["up_pct"] == 0 and body["sentiment"]["down_pct"] == 100
    assert body["item"]["item_id"] == "i0" and body["item"]["url"] == "u0"
    g = body["by_grade"]
    assert set(g) == {"all", "new", "9", "8", "7"}
    # 全部 = 每日行情；分成色 = 当天标题写了这个成色的挂牌均价，没有的那天不出点
    assert [p["price"] for p in g["all"]["series"]] == [1200, 1000, 900]
    assert [(p["date"], p["price"]) for p in g["new"]["series"]] == [("2026-10-27", 1300), ("2026-11-05", 1200)]
    assert [p["price"] for p in g["7"]["series"]] == [700, 500]      # 7新及以下含 6新
    assert g["8"]["series"] == [] and g["8"]["summary"] is None
    # 近 7 天（11-05、11-06）：全部取每日行情均价；较前 7 天（10-24~10-30，只有 10-27 那天 1200）
    assert g["all"]["summary"]["avg7"] == 950 and g["all"]["summary"]["change_pct"] == -20.8
    assert g["8"]["summary"] is None and g["7"]["summary"]["change_pct"] is None   # 前 7 天这档没货
    assert g["all"]["summary"]["days"] == 2 and g["all"]["summary"]["listings"] == 6
    assert g["9"]["summary"]["avg7"] == 950 and g["9"]["summary"]["band"] == {"low": 900, "high": 1000}
    assert g["new"]["summary"]["avg7"] == 1200


def test_records_carry_image_and_list_price(client, db_session, monkeypatch):
    import app.routers.price_history as PH
    monkeypatch.setattr(PH, "thumb_url_for_cover", lambda url: f"signed:{url}")
    staff, headers = _auth(db_session, StaffRole.SALES, "s4")
    db_session.add(WarehouseSpu(spu_code="6900000000001", brand="Rokid", model="X1", enabled=True))
    prod = CrawlProduct(name="Rokid X1")
    db_session.add(prod)
    db_session.flush()
    db_session.add(_day(prod, date.today(), 1000, [("X1 9成新", 1000)]))
    base = _sku(db_session, "S-R")
    sold = _sku(db_session, "S-R2", grade="9新", status=SkuStatus.SHIPPED)
    sold.cover_url = "https://oss/x.jpg"
    db_session.add(SkuListingInfo(sku_id=sold.id, price=1299))
    db_session.add(SalesOutbound(outbound_no="O9", sku_id=sold.id, outbound_type="SALE", sale_price=1150,
                                 cost_price=900, operator_id=staff.id, created_at=datetime.utcnow()))
    db_session.commit()

    recs = client.get(f"/api/inventory/skus/{base.sku_code}/price-history", headers=headers).json()["records"]
    on = next(r for r in recs if r["status"] == "在售")
    assert on["image"] is None and on["list_price"] == 1000 and on["item_id"] == "i0"
    done = next(r for r in recs if r["status"] == "成交")
    assert done["image"] == "signed:https://oss/x.jpg" and done["list_price"] == 1299
    assert done["title"] == "Rokid 眼镜" and done["sku_code"] == "S-R2"


def test_item_web_url_from_id_only_and_none_without_link(client, db_session):
    """有商品 ID 就能拼出网页商品页；一条可跳转的在售都没有时 item 为 null。"""
    _, headers = _auth(db_session, StaffRole.SALES, "s6")
    db_session.add(WarehouseSpu(spu_code="6900000000001", brand="Rokid", model="X1", enabled=True))
    prod = CrawlProduct(name="Rokid X1")
    db_session.add(prod)
    db_session.flush()
    db_session.add(CrawlPrice(product_id=prod.id, crawl_date=date.today(), price=1000, raw={"priceBreakdown": {
        "includedListings": [{"title": "X1 9成新", "price": 1000, "itemId": "1039589470156", "itemUrl": ""}]}}))
    base = _sku(db_session, "S-ITEM")
    db_session.commit()

    body = client.get(f"/api/inventory/skus/{base.sku_code}/price-history", headers=headers).json()
    assert body["item"]["item_id"] == "1039589470156"
    assert body["item"]["web_url"] == "https://www.goofish.com/item?id=1039589470156"

    # 另一个型号没有行情/在售链接 → 不给「前往闲鱼」假入口
    other = _sku(db_session, "S-NOLINK")
    other.model = "X2"
    other.barcode = "6900000000002"
    db_session.commit()
    body = client.get(f"/api/inventory/skus/{other.sku_code}/price-history", headers=headers).json()
    assert body["item"] is None


def test_listing_image_becomes_https_thumbnail(client, db_session):
    _, headers = _auth(db_session, StaffRole.SALES, "s5")
    db_session.add(WarehouseSpu(spu_code="6900000000001", brand="Rokid", model="X1", enabled=True))
    prod = CrawlProduct(name="Rokid X1")
    db_session.add(prod)
    db_session.flush()
    db_session.add(CrawlPrice(product_id=prod.id, crawl_date=date.today(), price=1000, raw={"priceBreakdown": {
        "includedListings": [
            {"title": "X1 9成新", "price": 1000, "itemId": "a",
             "picUrl": "http://img.alicdn.com/bao/uploaded/i3/O1CN01x.jpg"},
            {"title": "X1 8成新", "price": 900, "itemId": "b"},
        ]}}))
    base = _sku(db_session, "S-PIC")
    db_session.commit()
    recs = client.get(f"/api/inventory/skus/{base.sku_code}/price-history", headers=headers).json()["records"]
    by_id = {r["item_id"]: r["image"] for r in recs}
    assert by_id == {"a": "https://img.alicdn.com/bao/uploaded/i3/O1CN01x.jpg_220x220.jpg", "b": None}
