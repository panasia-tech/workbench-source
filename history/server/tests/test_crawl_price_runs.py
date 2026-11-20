"""行情同一天重跑不覆盖、留历史（F01-06）。

# 这里钉死的

  1. crawl_price 语义不变：一个型号一天一条、当天最新，价格历史折线照旧一天一个点；
  2. 每次上报都往 crawl_price_run 追加一条，同一天跑两次两条都在；
  3. summary 只抄小字段（口径、样本数这类），挂牌明细不复制；
  4. 轮次：此刻正好一轮在跑就记它，两轮以上认不准就空着；raw 写明了的按写明的；
  5. 逐次接口只读、分页、新的在前，标出哪一次是当天行情。
"""
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.database import Base, get_db
from app.deps import create_access_token
from app.enums import SkuStatus, StaffRole, StaffStatus
from app.main import app
from app.models import CrawlPrice, CrawlPriceRun, CrawlProduct, SalesOutbound, Sku, Staff, WarehouseSpu
from app.models.workbench import CrawlRunStatus, MarketCrawlRun
from app.services import crawl_price_runs
from app.services.finance import china_today


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


def _raw(price, valid=12):
    return {
        "source": "cleaned_average", "keywords": ["Rokid X1"], "account": "土星",
        "average": price, "lowest": price - 100, "median": price,
        "cards": 30, "uniqueCards": 25,
        "priceBreakdown": {"validCount": valid, "allCandidateCount": 25,
                           "includedListings": [{"title": "Rokid X1 9成新", "price": price}]},
        "queryLogs": ["很长的日志"], "snapshotPaths": ["/x/y.html"],
        "candidates": [{"title": "Rokid X1", "price": price}],
    }


def test_same_day_rerun_keeps_every_run(client, db_session):
    bot, headers = _auth(db_session, StaffRole.CRAWLER, "bot")
    for price in (1000, 1080):
        res = client.post("/api/market/prices", headers=headers,
                          json={"product_name": "Rokid X1", "price": price, "raw": _raw(price)})
        assert res.status_code == 200, res.text

    prod = db_session.query(CrawlProduct).filter_by(name="Rokid X1").one()
    day_rows = db_session.query(CrawlPrice).filter_by(product_id=prod.id).all()
    assert len(day_rows) == 1 and float(day_rows[0].price) == 1080  # 当天最新照旧
    assert float(prod.last_price) == 1080

    runs = db_session.query(CrawlPriceRun).filter_by(product_id=prod.id).order_by(CrawlPriceRun.crawled_at).all()
    assert [float(r.price) for r in runs] == [1000, 1080]
    first = runs[0]
    assert first.crawl_date == china_today()
    assert first.source == "cleaned_average" and first.sample_count == 12
    assert first.uploader_id == bot.id and first.crawl_price_id == day_rows[0].id
    assert first.run_id is None  # 没有在跑的轮次
    assert first.summary["breakdown"]["validCount"] == 12 and first.summary["median"] == 1000
    for heavy in ("priceBreakdown", "queryLogs", "snapshotPaths", "candidates"):
        assert heavy not in first.summary


def test_sample_count_falls_back_and_summary_handles_ocr():
    assert crawl_price_runs.sample_count({"priceBreakdown": {"validCount": 0}, "uniqueCards": 7}) == 7
    assert crawl_price_runs.sample_count({"cards": 3}) == 3
    assert crawl_price_runs.sample_count(None) is None
    assert crawl_price_runs.summarize({"source": "ocr", "parsed": {"price": 999}, "raw_text": "x" * 5000}) == {
        "source": "ocr", "parsed": {"price": 999},
    }
    assert crawl_price_runs.summarize(None) is None


def _running(db, device_id, local_run_id=None, started_ago=timedelta(minutes=5)):
    row = MarketCrawlRun(device_id=device_id, status=CrawlRunStatus.RUNNING, local_run_id=local_run_id,
                         started_at=datetime.utcnow() - started_ago)
    db.add(row)
    db.commit()
    return row


def _build(db, raw):
    return crawl_price_runs.build_run(db, product_id="p", crawl_date=date.today(), price=1, trend_delta=None,
                                      search_heat=None, raw=raw, uploader_id=None, crawl_price_id=None)


def test_run_attribution(db_session):
    stale = _running(db_session, "pc-old", started_ago=timedelta(hours=30))  # 崩了没报结束的老轮次不算
    live = _running(db_session, "pc-a", local_run_id="local-1")
    run = _build(db_session, {})
    assert (run.run_id, run.device_id, run.local_run_id) == (live.id, "pc-a", "local-1")

    _running(db_session, "pc-b")  # 两轮在跑，认不准
    run = _build(db_session, {"source": "cleaned_average"})
    assert run.run_id is None and run.device_id is None

    # raw 写明了的按写明的
    run = _build(db_session, {"erp_run_id": stale.id})
    assert run.run_id == stale.id and run.device_id == "pc-old"
    run = _build(db_session, {"local_run_id": "local-1", "device_id": "pc-explicit"})
    assert run.run_id == live.id and run.device_id == "pc-explicit"


def test_runs_endpoint_paginates_and_marks_day_latest(client, db_session):
    _, headers = _auth(db_session, StaffRole.SALES, "s1")
    db_session.add(WarehouseSpu(spu_code="6900000000001", brand="Rokid", model="X1", enabled=True))
    prod = CrawlProduct(name="Rokid X1")
    db_session.add(prod)
    db_session.add(Sku(sku_code="S-1", barcode="6900000000001", purchase_order_id="po", inspection_id="in",
                       product_name="Rokid 眼镜", brand="Rokid", model="X1", cost_price=100, status=SkuStatus.IN_STOCK, images=[]))
    db_session.flush()
    today, yesterday = date.today(), date.today() - timedelta(days=1)
    base = datetime(2026, 11, 10, 2, 0, 0)
    db_session.add(CrawlPrice(product_id=prod.id, crawl_date=yesterday, price=900))
    db_session.add(CrawlPrice(product_id=prod.id, crawl_date=today, price=1080))
    for i, (d, price) in enumerate(((yesterday, 900), (today, 1000), (today, 1050), (today, 1080))):
        db_session.add(CrawlPriceRun(product_id=prod.id, crawl_date=d, crawled_at=base + timedelta(hours=i),
                                     price=price, source="cleaned_average", sample_count=10 + i))
    db_session.commit()

    res = client.get("/api/inventory/skus/S-1/price-history/runs", headers=headers,
                     params={"page_size": 2})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["market_name"] == "Rokid X1" and body["total"] == 4
    assert [(i["price"], i["is_day_latest"]) for i in body["items"]] == [(1080, True), (1050, False)]
    first = body["items"][0]
    assert first["price_basis"] == "平均挂牌价" and first["sample_count"] == 13
    assert first["crawled_at"] == "2026-11-10T13:00:00"  # 北京时间

    page2 = client.get("/api/inventory/skus/S-1/price-history/runs", headers=headers,
                       params={"page_size": 2, "page": 2}).json()
    assert [(i["price"], i["is_day_latest"]) for i in page2["items"]] == [(1000, False), (900, True)]

    one_day = client.get("/api/inventory/skus/S-1/price-history/runs", headers=headers,
                         params={"crawl_date": yesterday.isoformat()}).json()
    assert one_day["total"] == 1 and one_day["items"][0]["price"] == 900

    # 原来的价格历史不受影响：一天一个点
    hist = client.get("/api/inventory/skus/S-1/price-history", headers=headers).json()
    assert [p["price"] for p in hist["series"]] == [900, 1080]


def test_runs_endpoint_without_market_product(client, db_session):
    _, headers = _auth(db_session, StaffRole.SALES, "s2")
    db_session.add(Sku(sku_code="S-2", barcode="6900000000002", purchase_order_id="po", inspection_id="in",
                       product_name="没监控的货", brand="X", model="Y", cost_price=1, status=SkuStatus.IN_STOCK, images=[]))
    db_session.commit()
    body = client.get("/api/inventory/skus/S-2/price-history/runs", headers=headers).json()
    assert body["items"] == [] and body["total"] == 0 and body["market_name"] is None
    assert client.get("/api/inventory/skus/NOPE/price-history/runs", headers=headers).status_code == 404
