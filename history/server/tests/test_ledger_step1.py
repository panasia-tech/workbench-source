"""老板全量台账第一步（11-14）：主体税务和年报、支付宝角色和因公付、店铺结算方式、提醒。密码不存。

红线：
  1. 公司只能查账征收；
  2. 一个主体最多一个主资金号；只有收款号能挂店铺；
  3. 因公付只给采购号，从同一主体的主资金号扣；主资金号还被扣着就不能撤；
  4. 不走支付宝的店铺直接挂主体；
  5. 提醒只提醒：年报没报、本季度卖货额快到 30 万免税线。
"""

from datetime import date, datetime
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import LedgerAlipay, LedgerEntity, LedgerShop, SalesOutbound, SaleShop, Sku, SkuShopListing, Staff
from app.routers import ledger as api
from app.services import ledger as lg


@pytest.fixture()
def ctx(db_session):
    db = db_session
    admin = Staff(id="admin", staff_no="admin", username="admin", password_hash="x", name="管理员",
                  role=StaffRole.ADMIN, status=StaffStatus.ACTIVE)
    db.add(admin)
    db.commit()
    lp = api.create_row("legal_person", api.RowIn(name="林一"), db=db, user=admin)
    ent = api.create_row("entity", api.RowIn(legal_person_id=lp["id"], name="林一五金店"), db=db, user=admin)
    return db, admin, lp["id"], ent["id"]


def _row(db, admin, level, **kw):
    return api.create_row(level, api.RowIn(**kw), db=db, user=admin)["id"]


def _edit(db, admin, level, rid, **kw):
    return api.update_row(level, rid, api.RowIn(**kw), db=db, user=admin)


def _bad(fn, *a, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    assert e.value.status_code == 400
    return e.value.detail


def test_公司只能查账征收(ctx):
    db, admin, lp, ent = ctx
    _edit(db, admin, "entity", ent, tax_levy="assessed")  # 个体户可以核定
    assert "查账" in _bad(_edit, db, admin, "entity", ent, entity_type="company")
    db.rollback()
    co = _row(db, admin, "entity", legal_person_id=lp, name="林一科技", entity_type="company", tax_payer="general")
    assert db.get(LedgerEntity, co).tax_levy == "audit"


def test_一个主体只有一个主资金号_只有收款号能挂店铺(ctx):
    db, admin, lp, ent = ctx
    master = _row(db, admin, "alipay", entity_id=ent, account="m@x", role="master")
    assert "已经有主资金号" in _bad(_row, db, admin, "alipay", entity_id=ent, account="m2@x", role="master")
    other = _row(db, admin, "entity", legal_person_id=lp, name="林一二店")
    _row(db, admin, "alipay", entity_id=other, account="m3@x", role="master")  # 别的主体可以有自己的

    buy = _row(db, admin, "alipay", entity_id=ent, account="b@x", role="purchase")
    for aid in (master, buy):
        assert "收款号" in _bad(_row, db, admin, "shop", alipay_id=aid, name="店")
    sales = _row(db, admin, "alipay", entity_id=ent, account="s@x")
    shop = _row(db, admin, "shop", alipay_id=sales, name="林一的闲鱼")
    assert db.get(LedgerShop, shop).entity_id == ent, "店铺跟着收款号归到主体"
    assert "对不上" in _bad(_edit, db, admin, "alipay", sales, role="purchase")


def test_因公付只给采购号_从同主体主资金号扣(ctx):
    db, admin, lp, ent = ctx
    buy = _row(db, admin, "alipay", entity_id=ent, account="b@x", role="purchase")
    assert "还没有主资金号" in _bad(_edit, db, admin, "alipay", buy, corporate_pay=True)
    db.rollback()
    sales = _row(db, admin, "alipay", entity_id=ent, account="s@x")
    assert "只有采购号" in _bad(_edit, db, admin, "alipay", sales, corporate_pay=True)
    db.rollback()
    master = _row(db, admin, "alipay", entity_id=ent, account="m@x", role="master")
    _edit(db, admin, "alipay", buy, corporate_pay=True)
    assert "因公付" in _bad(_edit, db, admin, "alipay", master, role="sales")
    db.rollback()
    assert "因公付" in _bad(_edit, db, admin, "alipay", master, status="closed")
    db.rollback()
    with pytest.raises(HTTPException):
        api.delete_row("alipay", master, db=db, user=admin)
    db.rollback()
    other = _row(db, admin, "entity", legal_person_id=lp, name="林一二店")
    assert "因公付" in _bad(_edit, db, admin, "alipay", master, entity_id=other), "主资金号挪去别的主体也不行"


def test_不走支付宝的店铺挂主体(ctx):
    db, admin, lp, ent = ctx
    assert "选收款的支付宝" in _bad(_row, db, admin, "shop", entity_id=ent, name="小店")
    db.rollback()
    shop = _row(db, admin, "shop", entity_id=ent, name="林一微信小店", platform="wechat_shop", channel="wechat",
                merchant_no="1600000001", fee_rate="2", deposit="5000", deposit_from="林一五金店对公户")
    tree = api.read_legal_person(lp, db=db, user=admin)
    e = tree["entities"][0]
    assert [s["name"] for s in e["shops"]] == ["林一微信小店"] and e["shops"][0]["channel_label"] == "微信支付商户号"
    assert e["shops"][0]["fee_rate"] == "2.00" and e["shops"][0]["deposit"] == "5000.00"
    assert db.get(LedgerShop, shop).alipay_id is None
    assert api.list_legal_persons(q="1600000001", needs_check=None, page=1, size=30, db=db, _=admin)["total"] == 1, "按商户号也搜得到"
    with pytest.raises(HTTPException):
        api.delete_row("entity", ent, db=db, user=admin)
    assert _bad(_edit, db, admin, "shop", shop, fee_rate="120")


def test_支付宝换主体_店铺跟着走(ctx):
    db, admin, lp, ent = ctx
    sales = _row(db, admin, "alipay", entity_id=ent, account="s@x")
    shop = _row(db, admin, "shop", alipay_id=sales, name="林一的闲鱼")
    other = _row(db, admin, "entity", legal_person_id=lp, name="林一二店")
    _edit(db, admin, "alipay", sales, entity_id=other)
    db.commit()
    assert db.get(LedgerShop, shop).entity_id == other


def test_年报提醒(ctx):
    db, admin, lp, ent = ctx
    e = db.get(LedgerEntity, ent)
    assert lg.entity_alerts(e, None, date(2026, 3, 1)) == [{"level": "warn", "text": "2025 年的年报还没报，6 月 30 日截止"}]
    assert lg.entity_alerts(e, None, date(2026, 11, 14))[0]["level"] == "danger"
    _edit(db, admin, "entity", ent, report_year=2025, report_filed_on="2026-05-20")
    assert lg.entity_alerts(e, None, date(2026, 11, 14)) == []
    _edit(db, admin, "entity", ent, report_year=None, registered_on="2026-04-01")
    assert lg.entity_alerts(e, None, date(2026, 11, 14)) == [], "今年成立的不用报去年的"
    assert _bad(_edit, db, admin, "entity", ent, report_filed_on="去年")


def test_本季度卖货额快到30万提醒_一般纳税人不提醒(ctx):
    db, admin, lp, ent = ctx
    _edit(db, admin, "entity", ent, report_year=2025)
    db.add(SaleShop(id="ss1", code="S1", label="海胆", xianyu_user_name="haidan"))
    sales = _row(db, admin, "alipay", entity_id=ent, account="s@x")
    _row(db, admin, "shop", alipay_id=sales, name="林一的闲鱼", sale_shop_id="ss1")
    for i, price in enumerate(("150000", "100000")):
        sku = Sku(sku_code=f"K{i}", product_name="货", purchase_order_id="po", inspection_id="i", cost_price=Decimal("1"), status="SHIPPED")
        db.add(sku); db.flush()
        db.add(SkuShopListing(sku_id=sku.id, sale_shop_id="ss1", publish_status="SOLD"))
        db.add(SalesOutbound(outbound_no=f"OB{i}", sku_id=sku.id, outbound_type="MANUAL", sale_price=Decimal(price),
                             cost_price=Decimal("1"), operator_id="admin", created_at=datetime.utcnow()))
    db.commit()
    tree = api.read_legal_person(lp, db=db, user=admin)
    e = tree["entities"][0]
    assert e["quarter_sales"] == "250000.00"
    assert e["alipays"][0]["shops"][0]["alerts"][0]["text"] == "本月卖了 ¥250,000，到了单店 8 万，该把流量切到别家店"
    # 都是这个月卖的，所以个体户月 10 万也过了（11-15 补的）
    assert e["alerts"] == [{"level": "warn", "text": "本季度卖了 ¥250,000，快到 30 万免税线（83%）"},
                           {"level": "danger", "text": "本月卖了 ¥250,000，过了个体户月 10 万免税线"}]
    assert api.list_legal_persons(q=None, needs_check=None, page=1, size=30, db=db, _=admin)["items"][0]["alerts"] == 3  # 还有店上的「过了单店 8 万」
    _edit(db, admin, "entity", ent, tax_payer="general")
    db.commit()
    assert api.read_legal_person(lp, db=db, user=admin)["entities"][0]["alerts"] == []
