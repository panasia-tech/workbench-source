"""大台账对账：授权回调、令牌加密、账单解析、拉账单、和 ERP 销售单对账。

不连支付宝：call_gateway 和下载都换成假的。
红线：宁可对不上，不能对错——金额一样的单有两张就不认；授权链接一次性。
"""

import asyncio
import io
import zipfile
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import (
    LedgerAlipay, LedgerBillFetch, LedgerBillRow, LedgerEntity, LedgerLegalPerson, LedgerShop, SaleOrder, SalesOutbound, SaleShop,
    Sku, SkuShopListing, Staff,
)
from app.routers import ledger as api
from app.services import alipay as ali
from app.services import ledger_bill as lb
from app.services.ledger_crypto import seal, unseal

HEAD = "账务流水号,业务流水号,商户订单号,商品名称,发生时间,对方账号,收入金额（+元）,支出金额（-元）,账户余额（元）,交易渠道,业务类型,备注"


def _csv(*lines: str) -> bytes:
    body = "\n".join(["#支付宝账务明细查询", "#账号：[20880000]", HEAD, *lines, "#-----账务明细列表结束-----"])
    return body.encode("gbk")


def _zip(csv_bytes: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("20880000_20261109_账务明细(汇总).csv".encode("gbk").decode("cp437"), "汇总".encode("gbk"))
        zf.writestr("20880000_20261109_账务明细.csv".encode("gbk").decode("cp437"), csv_bytes)
    return buf.getvalue()


@pytest.fixture()
def ctx(db_session, monkeypatch):
    db = db_session
    admin = Staff(id="admin", staff_no="admin", username="admin", password_hash="x", name="管理员",
                  role=StaffRole.ADMIN, status=StaffStatus.ACTIVE)
    db.add(admin)
    lp = LedgerLegalPerson(name="张三")
    db.add(lp); db.flush()
    ent = LedgerEntity(legal_person_id=lp.id, name="张三五金店")
    db.add(ent); db.flush()
    row = LedgerAlipay(entity_id=ent.id, account="7fc57dab80@example.invalid")
    db.add(row); db.flush()
    db.add(SaleShop(id="ss1", code="S1", label="海胆", xianyu_user_name="haidan"))
    db.add(LedgerShop(entity_id=ent.id, alipay_id=row.id, name="张三的闲鱼", sale_shop_id="ss1"))
    db.commit()
    monkeypatch.setattr(ali, "is_configured", lambda: True)
    monkeypatch.setattr(ali.settings, "alipay_app_id", "2021000000000001")
    return db, admin, row


def _order(db, no, amount, ext=None, shop="海胆", days_ago=2):
    o = SaleOrder(order_no=no, external_order_no=ext, amount=Decimal(amount), shop_name=shop, status="COMPLETED",
                  created_by_id="admin", created_at=datetime.utcnow() - timedelta(days=days_ago))
    db.add(o); db.flush()
    return o


def _out(db, no, price, shop="ss1", worry_free=None, days_ago=3, kind="MANUAL"):
    """一件货在 shop 卖掉（记了售出）、手动出库。shop=None 表示没记在哪家店卖的。"""
    sku = Sku(sku_code=f"SKU{no}", product_name=f"货{no}", purchase_order_id="po", inspection_id="insp",
              cost_price=Decimal("1"), status="SOLD")
    db.add(sku); db.flush()
    if shop:
        db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shop, publish_status="SOLD"))
    o = SalesOutbound(outbound_no=no, sku_id=sku.id, outbound_type=kind, sale_price=Decimal(price), cost_price=Decimal("1"),
                      worry_free=worry_free, operator_id="admin", created_at=datetime.utcnow() - timedelta(days=days_ago))
    db.add(o); db.flush()
    return o


def test_令牌加密存_解得回来():
    sealed = seal("202611BBxxxx")
    assert "202611BB" not in sealed and unseal(sealed) == "202611BBxxxx"


def test_授权链接_回调换令牌_链接只能用一次(ctx, monkeypatch):
    db, admin, row = ctx
    url = api.auth_link(row.id, db=db, user=admin)["url"]
    assert url.startswith(lb.AUTH_URL) and "app_id=2021000000000001" in url
    state = url.split("state=")[1]

    async def gw(method, biz, **kw):
        assert method == "alipay.open.auth.token.app" and biz == {"grant_type": "authorization_code", "code": "CODE"}
        return {"code": "10000", "tokens": [{"app_auth_token": "TOKEN", "app_refresh_token": "DEMO_ONLY_REDACTED",
                                             "user_id": "2088123", "expires_in": 31536000}]}
    monkeypatch.setattr(ali, "call_gateway", gw)

    resp = asyncio.run(api.auth_callback(app_auth_code="CODE", state=state, db=db))
    assert resp.status_code == 200 and "授权成功" in resp.body.decode()
    db.refresh(row)
    assert row.auth_status == "authorized" and row.alipay_user_id == "2088123"
    assert unseal(row.app_auth_token_enc) == "TOKEN" and "TOKEN" not in (row.app_auth_token_enc or "")

    again = asyncio.run(api.auth_callback(app_auth_code="CODE", state=state, db=db))
    assert again.status_code == 400, "同一个链接不能用第二次"


def test_支付宝拒绝授权_记下原因(ctx, monkeypatch):
    db, admin, row = ctx
    state = api.auth_link(row.id, db=db, user=admin)["url"].split("state=")[1]

    async def gw(method, biz, **kw):
        return {"code": "40004", "sub_code": "isv.code-invalid", "sub_msg": "授权码无效"}
    monkeypatch.setattr(ali, "call_gateway", gw)
    resp = asyncio.run(api.auth_callback(app_auth_code="BAD", state=state, db=db))
    assert resp.status_code == 400
    db.refresh(row)
    assert row.auth_status == "error" and "授权码无效" in row.auth_error


def test_解析账单_zip里挑明细不挑汇总():
    items = lb.parse_bill(_zip(_csv(
        "2026110900001\t,BIZ1\t,T200P123\t,闲鱼交易\t,2026-11-09 10:01:02,买家**,1288.00,,5000.00,支付宝,交易付款,",
        "2026110900002\t,BIZ2\t,,提现\t,2026-11-09 11:00:00,,,-500.00,4500.00,支付宝,提现,",
    )))
    assert [x["flow_no"] for x in items] == ["2026110900001", "2026110900002"]
    assert items[0]["income"] == Decimal("1288.00") and items[0]["merchant_order_no"] == "T200P123"
    assert items[1]["expense"] == Decimal("500.00") and items[1]["income"] == Decimal("0")
    assert items[0]["occurred_at"] == datetime(2026, 11, 9, 10, 1, 2)


def _authorize(db, row):
    row.auth_status = "authorized"
    row.app_auth_token_enc = seal("TOKEN")
    row.authorized_at = datetime.utcnow() - timedelta(days=1)
    db.commit()


def _fake_alipay(monkeypatch, content: bytes, *, code="10000", sub_code=None):
    import httpx

    async def gw(method, biz, **kw):
        assert kw.get("app_auth_token") == "TOKEN", "要用那家企业的授权令牌去拉"
        if code != "10000":
            return {"code": code, "sub_code": sub_code, "sub_msg": "x"}
        return {"code": "10000", "bill_download_url": "https://dwbillcenter.alipay.com/x"}
    monkeypatch.setattr(ali, "call_gateway", gw)

    class Resp:
        def __init__(self):
            self.content = content

        def raise_for_status(self):
            pass

    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def get(self, url):
            return Resp()
    monkeypatch.setattr(httpx, "AsyncClient", Client)


def test_拉账单_按订单号对上_重拉不重复(ctx, monkeypatch):
    db, _, row = ctx
    _authorize(db, row)
    o = _order(db, "SO1", "1288", ext="T200P123")
    db.commit()
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    _fake_alipay(monkeypatch, _zip(_csv(f"F1,B1,T200P123,闲鱼交易,{when},买家,1288.00,,1,支付宝,交易付款,")))
    d = date.today()
    f = asyncio.run(lb.fetch_day(db, row, d)); db.commit()
    assert f.status == "ok" and f.rows == 1
    b = db.query(LedgerBillRow).one()
    assert b.sale_order_id == o.id and b.match_how == "order_no"
    asyncio.run(lb.fetch_day(db, row, d)); db.commit()
    assert db.query(LedgerBillRow).count() == 1


def test_按金额对_两张一样金额的不认(ctx, monkeypatch):
    db, _, row = ctx
    _authorize(db, row)
    _order(db, "SO1", "500")
    _order(db, "SO2", "500")
    lone = _order(db, "SO3", "799")
    db.commit()
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    _fake_alipay(monkeypatch, _csv(
        f"F1,B1,,闲鱼交易,{when},买家,500.00,,1,支付宝,交易付款,",
        f"F2,B2,,闲鱼交易,{when},买家,795.20,,1,支付宝,交易付款,",
    ))
    asyncio.run(lb.fetch_day(db, row, date.today())); db.commit()
    by = {b.flow_no: b for b in db.query(LedgerBillRow).all()}
    assert by["F1"].sale_order_id is None, "同金额两张单，宁可不对"
    assert by["F2"].sale_order_id == lone.id and by["F2"].match_how == "approx", "扣了服务费的进账按 2% 内认"


def test_别家店的单不拿来对(ctx, monkeypatch):
    db, _, row = ctx
    _authorize(db, row)
    _order(db, "SO9", "300", shop="土星")
    db.commit()
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    _fake_alipay(monkeypatch, _csv(f"F1,B1,,闲鱼交易,{when},买家,300.00,,1,支付宝,交易付款,"))
    asyncio.run(lb.fetch_day(db, row, date.today())); db.commit()
    assert db.query(LedgerBillRow).one().sale_order_id is None


def test_当天没流水和授权失效(ctx, monkeypatch):
    db, _, row = ctx
    _authorize(db, row)
    _fake_alipay(monkeypatch, b"", code="40004", sub_code="isp.bill_not_exist")
    assert asyncio.run(lb.fetch_day(db, row, date.today())).status == "empty"
    _fake_alipay(monkeypatch, b"", code="20001", sub_code="aop.invalid-app-auth-token")
    f = asyncio.run(lb.fetch_day(db, row, date.today() - timedelta(days=1)))
    assert f.status == "error" and row.auth_status == "expired"


def test_对账总览和明细(ctx, monkeypatch):
    db, admin, row = ctx
    _authorize(db, row)
    _order(db, "SO1", "1288", ext="T1")
    _order(db, "SO2", "66", ext="T2")
    db.commit()
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    _fake_alipay(monkeypatch, _csv(f"F1,B1,T1,闲鱼交易,{when},买家,1288.00,,1,支付宝,交易付款,"))
    today = date.today()
    asyncio.run(lb.fetch_day(db, row, today)); db.commit()
    ov = api.reconcile_overview(start=today.isoformat(), end=today.isoformat(), db=db, _=admin)["items"][0]
    assert ov["income_total"] == "1288.00" and ov["matched_count"] == 1 and ov["unmatched_count"] == 0
    det = api.reconcile_detail(row.id, start=today.isoformat(), end=today.isoformat(), db=db, user=admin)
    assert det["bills"][0]["order"]["order_no"] == "SO1"
    assert [o["order_no"] for o in det["orders_without_income"]] == ["SO2"], "卖了没见到进账的单要列出来"


def test_补拉_没授权的拦下(ctx):
    db, admin, row = ctx
    with pytest.raises(HTTPException):
        asyncio.run(api.reconcile_fetch(row.id, start=None, end=None, db=db, user=admin))


def test_闲鱼手动出库_扣完服务费按店铺对上(ctx, monkeypatch):
    db, admin, row = ctx
    _authorize(db, row)
    db.add(SaleShop(id="ss2", code="S2", label="土星", xianyu_user_name="tuxing"))
    a = _out(db, "OUT1", "1000")                      # 没标无忧 → 按 2.6%：974.00
    b = _out(db, "OUT2", "500", worry_free=False)      # 普通 1.6%：492.00
    _out(db, "OUT3", "1000", shop="ss2")               # 别家店卖的，同价也不拿
    _out(db, "OUT4", "88", kind="PICKUP")              # 自提不进店铺支付宝
    db.commit()
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    _fake_alipay(monkeypatch, _csv(
        f"F1,B1,,闲鱼交易,{when},买家,974.00,,1,支付宝,交易付款,",
        f"F2,B2,,闲鱼交易,{when},买家,492.00,,1,支付宝,交易付款,",
        f"F3,B3,,闲鱼交易,{when},买家,88.00,,1,支付宝,交易付款,",
    ))
    today = date.today()
    asyncio.run(lb.fetch_day(db, row, today)); db.commit()
    by = {x.flow_no: x for x in db.query(LedgerBillRow).all()}
    assert (by["F1"].sale_outbound_id, by["F1"].match_how) == (a.id, "amount")
    assert (by["F2"].sale_outbound_id, by["F2"].match_how) == (b.id, "amount")
    assert by["F3"].sale_outbound_id is None, "自提不拿来对"
    det = api.reconcile_detail(row.id, start=today.isoformat(), end=today.isoformat(), db=db, user=admin)
    got = {x["flow_no"]: x["order"] for x in det["bills"]}
    assert got["F1"]["order_no"] == "OUT1" and got["F1"]["shop_name"] == "海胆" and got["F1"]["product_title"] == "货OUT1"
    assert det["orders_without_income"] == [], "别家店的出库单不列在这个支付宝下"
    ov = api.reconcile_overview(start=today.isoformat(), end=today.isoformat(), db=db, _=admin)["items"][0]
    assert ov["matched_count"] == 2 and ov["unmatched_count"] == 1


def test_出库单认不出店铺_一分不差且唯一才认(ctx, monkeypatch):
    db, _, row = ctx
    _authorize(db, row)
    lone = _out(db, "OUT1", "300", shop=None)
    _out(db, "OUT2", "200", shop=None)
    _out(db, "OUT3", "200", shop=None)
    _out(db, "OUT4", "150", shop=None)
    db.commit()
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    _fake_alipay(monkeypatch, _csv(
        f"F1,B1,,闲鱼交易,{when},买家,292.20,,1,支付宝,交易付款,",
        f"F2,B2,,闲鱼交易,{when},买家,194.80,,1,支付宝,交易付款,",
        f"F3,B3,,闲鱼交易,{when},买家,147.00,,1,支付宝,交易付款,",
    ))
    asyncio.run(lb.fetch_day(db, row, date.today())); db.commit()
    by = {x.flow_no: x for x in db.query(LedgerBillRow).all()}
    assert (by["F1"].sale_outbound_id, by["F1"].match_how) == (lone.id, "noshop")
    assert by["F2"].sale_outbound_id is None, "两张一样的不认"
    assert by["F3"].sale_outbound_id is None, "认不出店铺的不按差一点认"


def test_销售单优先_对过的出库单不再对(ctx, monkeypatch):
    db, _, row = ctx
    _authorize(db, row)
    o = _order(db, "SO1", "600")
    _out(db, "OUT1", "600")
    db.commit()
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    _fake_alipay(monkeypatch, _csv(f"F1,B1,,闲鱼交易,{when},买家,600.00,,1,支付宝,交易付款,"))
    asyncio.run(lb.fetch_day(db, row, date.today())); db.commit()
    b = db.query(LedgerBillRow).one()
    assert b.sale_order_id == o.id and b.sale_outbound_id is None
    _fake_alipay(monkeypatch, _csv(
        f"F1,B1,,闲鱼交易,{when},买家,600.00,,1,支付宝,交易付款,",
        f"F2,B2,,闲鱼交易,{when},买家,584.40,,1,支付宝,交易付款,",
    ))
    asyncio.run(lb.fetch_day(db, row, date.today())); db.commit()
    f2 = db.query(LedgerBillRow).filter_by(flow_no="F2").one()
    assert f2.sale_outbound_id is not None and f2.match_how == "amount"
    asyncio.run(lb.fetch_day(db, row, date.today())); db.commit()
    assert db.query(LedgerBillRow).filter(LedgerBillRow.sale_outbound_id.isnot(None)).count() == 1


def test_出库填了实际服务费_按实际到账对(ctx, monkeypatch):
    db, _, row = ctx
    _authorize(db, row)
    o = _out(db, "OUT1", "2010")
    o.platform_fee = Decimal("132.66")   # 无忧卖 6% + 0.6%，按 2.6% 估就对不上
    db.commit()
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    _fake_alipay(monkeypatch, _csv(f"F1,B1,,闲鱼交易,{when},买家,1877.34,,1,支付宝,交易付款,"))
    asyncio.run(lb.fetch_day(db, row, date.today())); db.commit()
    b = db.query(LedgerBillRow).one()
    assert (b.sale_outbound_id, b.match_how) == (o.id, "amount")


def test_流水自动分类_人改过的不再覆盖_对上出库单回填服务费(ctx, monkeypatch):
    db, admin, row = ctx
    _authorize(db, row)
    o = _out(db, "OUT1", "1000", worry_free=False)   # 估 1.6% → 984，实际到账 983.40
    db.commit()
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    _fake_alipay(monkeypatch, _csv(
        f"F1,B1,,闲鱼交易,{when},买家,983.40,,1,支付宝,交易付款,",
        f"F2,B2,,闲鱼软件服务费,{when},闲鱼,,6.00,1,支付宝,服务费,",
        f"F3,B3,,提现,{when},银行卡,,500.00,1,支付宝,提现,",
        f"F4,B4,,店铺保证金,{when},闲鱼,,1000.00,1,支付宝,保证金,",
        f"F5,B5,,转账,{when},某人,20.00,,1,支付宝,转账,",
    ))
    asyncio.run(lb.fetch_day(db, row, date.today())); db.commit()
    by = {b.flow_no: b for b in db.query(LedgerBillRow).all()}
    assert {k: v.flow for k, v in by.items()} == {
        "F1": "sales_in", "F2": "fee_out", "F3": "withdraw_out", "F4": "deposit_out", "F5": "other_in"}
    assert by["F1"].sale_outbound_id == o.id and db.get(SalesOutbound, o.id).platform_fee == Decimal("16.60"), \
        "对上出库单、出库没填服务费的，按售价 - 到账回填"

    api.set_bill_flow(by["F5"].id, api.FlowIn(flow="topup_in"), db=db, user=admin)
    asyncio.run(lb.fetch_day(db, row, date.today())); db.commit()
    assert db.get(LedgerBillRow, by["F5"].id).flow == "topup_in", "人改过的不再自动覆盖"
    with pytest.raises(HTTPException):
        api.set_bill_flow(by["F5"].id, api.FlowIn(flow="乱写"), db=db, user=admin)
    det = api.reconcile_detail(row.id, start=date.today().isoformat(), end=date.today().isoformat(), db=db, user=admin)
    assert {b["flow_no"]: b["flow_label"] for b in det["bills"]}["F5"] == "转入充值"


def test_到账是全额或差太多_不回填服务费(ctx, monkeypatch):
    db, _, row = ctx
    _authorize(db, row)
    a = _out(db, "OUT1", "700", worry_free=False)
    db.commit()
    lb._backfill_fee(a, Decimal("700"))
    assert a.platform_fee is None, "全额到账，服务费另起一笔扣，不从这笔算"
    lb._backfill_fee(a, Decimal("500"))
    assert a.platform_fee is None, "差了快 30%，多半是部分退款"
    a.platform_fee = Decimal("9")
    lb._backfill_fee(a, Decimal("680"))
    assert a.platform_fee == Decimal("9"), "人填过的不动"
