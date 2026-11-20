"""老板全量台账第三步：买卖分开、财务槽位、单店月度损益、代持协议提醒。

红线：
  1. 销售店收钱（收款号 / 平台商户号）；采购号只能因公付（挂采购支付宝）或外币卡；引流号不收不付；
  2. 引流号只往销售店引流；还有引流号指着的店不能删、不能改成别的用途；
  3. 设备用途要和挂在上面的账号一致；
  4. 单店损益按 ERP 出库：卖了多少 − 成本 − 服务费 − 本月退货回冲的毛利；采购净支出 = 采购付款 − 采购退款；
  5. 代持协议 30 天内到期提醒。
"""

from datetime import date, datetime
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import LedgerBillRow, LedgerShop, ReturnOrder, SalesOutbound, SaleShop, Sku, SkuShopListing, Staff
from app.routers import ledger as api
from app.services import ledger as lg

TODAY = date(2026, 11, 15)


@pytest.fixture()
def ctx(db_session, monkeypatch):
    monkeypatch.setattr(lg, "_today", lambda: TODAY)
    db = db_session
    admin = Staff(id="admin", staff_no="admin", username="admin", password_hash="x", name="管理员",
                  role=StaffRole.ADMIN, status=StaffStatus.ACTIVE)
    db.add(admin)
    db.commit()
    lp = api.create_row("legal_person", api.RowIn(name="林一"), db=db, user=admin)["id"]
    ent = api.create_row("entity", api.RowIn(legal_person_id=lp, name="林一五金店"), db=db, user=admin)["id"]
    return db, admin, lp, ent


def _row(db, admin, level, **kw):
    return api.create_row(level, api.RowIn(**kw), db=db, user=admin)["id"]


def _edit(db, admin, level, rid, **kw):
    return api.update_row(level, rid, api.RowIn(**kw), db=db, user=admin)


def _bad(fn, *a, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    assert e.value.status_code == 400
    return e.value.detail


def test_买卖分开_采购号只能因公付_引流号不收不付(ctx):
    db, admin, lp, ent = ctx
    sales = _row(db, admin, "alipay", entity_id=ent, account="s@x")
    _row(db, admin, "alipay", entity_id=ent, account="m@x", role="master")
    buy = _row(db, admin, "alipay", entity_id=ent, account="b@x", role="purchase", corporate_pay=True)
    shop = _row(db, admin, "shop", alipay_id=sales, name="林一的闲鱼")

    assert "销售店只能用" in _bad(_row, db, admin, "shop", entity_id=ent, alipay_id=buy, name="x", channel="corporate_pay")
    assert "采购号只能用" in _bad(_row, db, admin, "shop", alipay_id=sales, name="x", role="purchase")
    assert "采购支付宝" in _bad(_row, db, admin, "shop", alipay_id=sales, name="x", role="purchase", channel="corporate_pay")
    db.rollback()
    dp = _row(db, admin, "shop", alipay_id=buy, name="点评买券 1", role="purchase", channel="corporate_pay", platform="dianping")
    assert db.get(LedgerShop, dp).entity_id == ent
    _row(db, admin, "shop", entity_id=ent, name="海外会员", role="purchase", channel="overseas", platform="other")

    mk = _row(db, admin, "shop", entity_id=ent, name="小红书种草 1", role="marketing", platform="xhs", channel="alipay",
              alipay_id=sales, merchant_no="123", lead_shop_id=shop)
    m = db.get(LedgerShop, mk)
    assert (m.channel, m.alipay_id, m.merchant_no) == ("none", None, None)  # 引流号不收不付，填了也不记
    assert "只能往销售店引流" in _bad(_edit, db, admin, "shop", mk, lead_shop_id=dp)
    db.rollback()
    assert "引流号" in _bad(api.delete_row, "shop", shop, db=db, user=admin)
    assert "引流号" in _bad(_edit, db, admin, "shop", shop, role="purchase", channel="corporate_pay", alipay_id=buy)
    db.rollback()
    # 采购支付宝下挂着采购号，改成收款号就对不上了
    assert "对不上" in _bad(_edit, db, admin, "alipay", buy, role="sales", corporate_pay=False)


def test_设备用途要和账号一致(ctx):
    db, admin, lp, ent = ctx
    buy = _row(db, admin, "alipay", entity_id=ent, account="b@x", role="purchase")
    sell_dev = _row(db, admin, "device", kind="phone", name="销售机")
    buy_dev = _row(db, admin, "device", kind="phone", name="采购机", purpose="purchase")
    msg = _bad(_row, db, admin, "shop", alipay_id=buy, name="抖音买券", role="purchase", channel="corporate_pay",
               platform="douyin_app", device_id=sell_dev)
    assert "采购用的设备" in msg and "销售机" in msg
    db.rollback()
    acc = _row(db, admin, "shop", alipay_id=buy, name="抖音买券", role="purchase", channel="corporate_pay",
               platform="douyin_app", device_id=buy_dev)
    assert "设备用途要和账号一致" in _bad(_edit, db, admin, "device", buy_dev, purpose="sales")
    assert db.get(LedgerShop, acc).device_id == buy_dev


def test_单店月度损益_退货回冲毛利(ctx):
    db, admin, lp, ent = ctx
    db.add(SaleShop(id="ss1", code="S1", label="海胆", xianyu_user_name="haidan"))
    sales = _row(db, admin, "alipay", entity_id=ent, account="s@x")
    shop = _row(db, admin, "shop", alipay_id=sales, name="林一的闲鱼", sale_shop_id="ss1")

    def sold(code, price, cost, at, **kw):
        sku = Sku(sku_code=code, product_name="货", purchase_order_id="po", inspection_id="i", cost_price=Decimal(cost),
                  status="SHIPPED")
        db.add(sku); db.flush()
        db.add(SkuShopListing(sku_id=sku.id, sale_shop_id="ss1", publish_status="SOLD"))
        ob = SalesOutbound(outbound_no=f"OB{code}", sku_id=sku.id, outbound_type="MANUAL", sale_price=Decimal(price),
                           cost_price=Decimal(cost), operator_id="admin", created_at=at, **kw)
        db.add(ob); db.flush()
        return sku, ob

    sold("A", "1000", "600", datetime(2026, 11, 10, 4), platform_fee=Decimal("16"))
    sold("B", "500", "300", datetime(2026, 11, 12, 4), worry_free=False)  # 没填服务费，按 1.6% 估 8
    sku, ob = sold("C", "200", "150", datetime(2026, 10, 20, 4))  # 上个月卖的，这个月退回来
    db.add(ReturnOrder(return_no="R1", sku_id=sku.id, sku_code="C", product_name="货", status="DONE", outbound_id=ob.id,
                       created_by_id="admin", created_at=datetime(2026, 11, 13, 4)))
    db.commit()

    m = api.read_legal_person(lp, db=db, user=admin)["entities"][0]["alipays"][0]["shops"][0]["month"]
    assert m == {"gmv": "1500.00", "cost": "900.00", "fee": "24.00", "refund": "200.00", "count": 2, "returns": 1,
                 "net": "526.00", "month": "2026-11"}  # 1500 − 900 − 24 − (200 − 150)
    months = api.shop_months(shop, n=2, db=db, user=admin)["items"]
    assert [x["month"] for x in months] == ["2026-11", "2026-10"]
    assert months[1]["gmv"] == "200.00" and months[1]["count"] == 1


def test_采购净支出_代持协议提醒_财务槽位(ctx):
    db, admin, lp, ent = ctx
    buy = _row(db, admin, "alipay", entity_id=ent, account="b@x", role="purchase", daily_limit="50000",
               single_limit="100000", book_code="1012.ALI-E1-B1")
    for i, (flow, inc, exp) in enumerate((("purchase_out", 0, 300), ("purchase_out", 0, 200), ("purchase_refund_in", 120, 0),
                                          ("sales_in", 999, 0))):
        db.add(LedgerBillRow(alipay_id=buy, bill_date=date(2026, 11, 3), flow_no=f"F{i}", income=Decimal(inc),
                             expense=Decimal(exp), flow=flow))
    _edit(db, admin, "legal_person", lp, agreement_end="2026-12-01", face_sla="2 小时内")
    _edit(db, admin, "entity", ent, business_scope="日用百货零售")
    assert "开票口径" in _bad(_row, db, admin, "shop", entity_id=ent, name="x", channel="wechat", invoice_mode="乱填")
    db.rollback()
    db.commit()
    out = api.read_legal_person(lp, db=db, user=admin)
    a = out["entities"][0]["alipays"][0]
    assert a["month_purchase"] == "380.00"  # 300 + 200 − 120，卖货进账不算
    assert (a["daily_limit"], a["single_limit"], a["book_code"]) == ("50000.00", "100000.00", "1012.ALI-E1-B1")
    assert out["alerts"] == [{"level": "warn", "text": "代持协议还有 16 天到期，要续签"}]
    assert out["face_sla"] == "2 小时内" and out["entities"][0]["business_scope"] == "日用百货零售"
    assert api.list_legal_persons(q=None, needs_check=None, page=1, size=30, db=db, _=admin)["items"][0]["alerts"] >= 1
