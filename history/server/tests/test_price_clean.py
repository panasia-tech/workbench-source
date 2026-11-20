"""步入式价格清洗（11-13）：样本按规则先筛、剔除要原因、离群标出、中位数、样本不足 / 过期 / 低于成本线拦、管理员生效、旧版本留着。"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.enums import SkuStatus, StaffRole, StaffStatus
from app.models import CrawlPrice, CrawlProduct, PriceSample, Sku, Staff
from app.routers import price_clean as R
from app.services import price_clean as pc


def _staff(db, name, role):
    s = Staff(staff_no=name, username=name, name=name, role=role, status=StaffStatus.ACTIVE, password_hash="x")
    db.add(s)
    db.flush()
    return s


def _cand(price, title="戴尔 U2720Q 27寸 4K 显示器 成色好", item=None):
    return {"price": price, "title": title, "itemId": item or f"id-{price}-{title[:2]}", "query": "U2720Q",
            "itemUrl": "fleamarket://item?id=x"}


@pytest.fixture()
def w(db_session, monkeypatch):
    db = db_session
    sku = Sku(sku_code="SK1", product_name="戴尔 U2720Q", model="U2720Q", product_type="显示器",
              purchase_order_id="p", inspection_id="i", cost_price=Decimal("1000"), status=SkuStatus.IN_STOCK, images=[])
    product = CrawlProduct(name="U2720Q")
    db.add_all([sku, product])
    db.flush()
    cands = [_cand(p, item=f"n{i}") for i, p in enumerate((1500, 1550, 1600, 1600, 1650, 1700, 1750))] + [
        _cand(50, "U2720Q 显示器 先咨询"),              # 3C 诱饵价
        _cand(300, "U2720Q 屏幕维修 换屏"),             # 维修
        _cand(9999, "U2720Q 全新未拆"),                 # 离群
        _cand(1600, item="n2"),                         # 同一商品 ID 重复
    ]
    db.add(CrawlPrice(product_id=product.id, crawl_date=date.today() - timedelta(days=1), price=Decimal("1650"),
                      raw={"source": "cleaned_average", "candidates": cands,
                           "snapshotEntries": [{"query": "U2720Q", "path": "C:\\\\snap\\\\a.html"}]}))
    clerk = _staff(db, "员工", StaffRole.SALES)
    boss = _staff(db, "老板", StaffRole.ADMIN)
    db.commit()
    monkeypatch.setattr(pc, "_market_product", lambda db, sku: (product, "U2720Q"))

    class W:
        pass

    x = W()
    x.db, x.sku, x.clerk, x.boss, x.product = db, sku, clerk, boss, product
    return x


def test_样本先按规则筛_去重_离群_中位数(w):
    out = R.start("SK1", w.db, w.clerk)
    t = out["task"]
    reasons = {s["price"]: s["reject_reason"] for s in t["samples"] if not s["kept"]}
    assert reasons[50] == "低于 100 元诱饵价"
    assert "维修" in reasons[300]
    assert reasons[9999].startswith("离群价")
    assert t["effective"]["count"] == 7 and t["effective"]["total"] == 10, "重复的商品 ID 只留一条"
    assert t["effective"]["median"] == 1600 and t["effective"]["method"] == "中位数"
    assert t["samples"][0]["snapshot_path"].endswith("a.html")


def test_剔除要原因_回收价不算销售价_人改过的可以恢复(w):
    out = R.start("SK1", w.db, w.clerk)
    sid = next(s["id"] for s in out["task"]["samples"] if s["price"] == 1750)
    with pytest.raises(HTTPException, match="剔除要写原因"):
        R.edit_sample("SK1", sid, R.SampleIn(kept=False), w.db, w.clerk)
    out = R.edit_sample("SK1", sid, R.SampleIn(kept=False, reason="配置不同"), w.db, w.clerk)
    assert out["task"]["effective"]["count"] == 6
    sid2 = next(s["id"] for s in out["task"]["samples"] if s["price"] == 1500)
    out = R.edit_sample("SK1", sid2, R.SampleIn(price_type="RECYCLE"), w.db, w.clerk)
    assert out["task"]["effective"]["count"] == 5 and out["task"]["effective"]["other_types"] == {"回收价": 1}
    out = R.edit_sample("SK1", sid, R.SampleIn(kept=True), w.db, w.clerk)
    assert out["task"]["effective"]["count"] == 6


def test_确认_拦样本不足_低于成本线_改价要依据_管理员生效_旧版本替换(w):
    R.start("SK1", w.db, w.clerk)
    with pytest.raises(HTTPException, match="低于成本线 1000"):
        R.confirm("SK1", R.ConfirmIn(price=900), w.db, w.clerk)
    with pytest.raises(HTTPException, match="要写依据"):
        R.confirm("SK1", R.ConfirmIn(price=1580), w.db, w.clerk)
    out = R.confirm("SK1", R.ConfirmIn(price=1600), w.db, w.clerk)
    v1 = out["versions"][0]
    assert v1["version"] == 1 and v1["status"] == "PENDING" and out["current"] is None
    with pytest.raises(HTTPException, match="已经出了版本"):
        R.confirm("SK1", R.ConfirmIn(price=1600), w.db, w.clerk)
    with pytest.raises(HTTPException):
        pc.review(w.db, w.db.get(pc.PriceVersion, v1["id"]), w.clerk, approve=True, note=None)
    out = R.review(v1["id"], R.ReviewIn(approve=True), w.db, w.boss)
    assert out["current"]["price"] == 1600 and out["current"]["usable"] is True
    # 再洗一次出 v2，生效后 v1 变成已替换、还留着
    R.start("SK1", w.db, w.clerk)
    out = R.confirm("SK1", R.ConfirmIn(price=1650, note="成色比同款好"), w.db, w.clerk)
    v2 = out["versions"][0]
    out = R.review(v2["id"], R.ReviewIn(approve=True), w.db, w.boss)
    assert [(v["version"], v["status"]) for v in out["versions"]] == [(2, "ACTIVE"), (1, "SUPERSEDED")]


def test_样本不足和过期都不能出价(w):
    out = R.start("SK1", w.db, w.clerk)
    keep = [s for s in out["task"]["samples"] if s["kept"]]
    for s in keep[:5]:
        R.edit_sample("SK1", s["id"], R.SampleIn(kept=False, reason="配置不同"), w.db, w.clerk)
    with pytest.raises(HTTPException, match="少于 3 条"):
        R.confirm("SK1", R.ConfirmIn(price=1600), w.db, w.clerk)
    # 样本是 8 天前采的：过期
    w.db.query(CrawlPrice).update({"crawl_date": date.today() - timedelta(days=8)})
    w.db.commit()
    out = R.start("SK1", w.db, w.clerk)
    assert out["task"]["stale"] is True
    with pytest.raises(HTTPException, match="超过 7 天算旧"):
        R.confirm("SK1", R.ConfirmIn(price=1600), w.db, w.clerk)


def test_非3C不设诱饵价门槛_缺型号不能开始(w):
    w.sku.product_type = "电影票券"
    w.db.commit()
    out = R.start("SK1", w.db, w.clerk)
    fifty = next(s for s in out["task"]["samples"] if s["price"] == 50)
    assert "诱饵" not in (fifty["reject_reason"] or ""), "票券不设 100 元门槛（它被剔是因为离群）"
    w.sku.model = None
    w.db.commit()
    with pytest.raises(HTTPException, match="还缺型号"):
        R.start("SK1", w.db, w.clerk)


def test_管理员今天里有待生效的清洗价(w):
    from app.services import sales_workbench as sw

    R.start("SK1", w.db, w.clerk)
    R.confirm("SK1", R.ConfirmIn(price=1600), w.db, w.clerk)
    got = sw._price_review(w.db, w.boss)
    assert got == {"count": 1, "url": "/pages/price-clean/index?code=SK1"}
    assert sw._price_review(w.db, w.clerk) is None


def test_低于成本线写依据能确认_新确认作废旧的待生效_旧版本不能顶掉新的(w):
    R.start("SK1", w.db, w.clerk)
    out = R.confirm("SK1", R.ConfirmIn(price=900, note="行情跌破成本的老库存"), w.db, w.clerk)
    v1 = out["versions"][0]
    assert v1["status"] == "PENDING" and v1["price"] == 900
    R.start("SK1", w.db, w.clerk)
    out = R.confirm("SK1", R.ConfirmIn(price=1600), w.db, w.clerk)
    assert [(v["version"], v["status"]) for v in out["versions"]] == [(2, "PENDING"), (1, "SUPERSEDED")]
    with pytest.raises(HTTPException, match="只有待生效"):
        R.review(v1["id"], R.ReviewIn(approve=True), w.db, w.boss)


def test_别人重新开始了_改样本和确认都对不上(w):
    a = R.start("SK1", w.db, w.clerk)["task"]
    R.start("SK1", w.db, w.boss)
    sid = a["samples"][0]["id"]
    with pytest.raises(HTTPException, match="刷新看最新样本"):
        R.edit_sample("SK1", sid, R.SampleIn(kept=True, task_id=a["id"]), w.db, w.clerk)
    with pytest.raises(HTTPException, match="刷新看最新样本"):
        R.confirm("SK1", R.ConfirmIn(price=1600, task_id=a["id"]), w.db, w.clerk)


def test_过期的待生效不再催_页面能退回(w):
    from app.services import sales_workbench as sw

    R.start("SK1", w.db, w.clerk)
    out = R.confirm("SK1", R.ConfirmIn(price=1600), w.db, w.clerk)
    v = w.db.get(pc.PriceVersion, out["versions"][0]["id"])
    v.expires_on = date.today() - timedelta(days=3)
    w.db.commit()
    page = R.read("SK1", w.db, w.boss)
    assert page["versions"][0]["status"] == "EXPIRED" and page["versions"][0]["pending"] is True
    assert sw._price_review(w.db, w.boss) is None
    out = R.review(v.id, R.ReviewIn(approve=False, note="过期了重洗"), w.db, w.boss)
    assert out["versions"][0]["status"] == "REJECTED"
