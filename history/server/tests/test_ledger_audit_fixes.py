"""审计报告第一部分补的三条（11-15）+ 第一次建台账。

红线：
  1. 一张执照（个体户、公司）最多挂 3 家闲鱼店，采购号不算；没执照的个人闲鱼号挂「个人」主体，不算数；
  2. 只提醒：个体户单店月 8 万、个体户月 10 万、小规模连续 12 个月 450 万 / 500 万；
  3. 每日账单一个户一天一份，不同的户同一天可以各传一份；
  4. 台账空着时管理员先建第一条，四层一次建完，哪层不对就都不建。
"""

from datetime import date, datetime
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import DailyBill, LedgerAlipay, LedgerEntity, LedgerLegalPerson, LedgerShop, Staff
from app.routers import finance as fin
from app.routers import ledger as api
from app.schemas.finance import DailyBillCreate
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


def _bad(fn, *a, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    assert e.value.status_code == 400
    return e.value.detail


def test_一张执照最多3家闲鱼店_采购号和个人主体不算(ctx):
    db, admin, lp, ent = ctx
    sales = _row(db, admin, "alipay", entity_id=ent, account="s@x")
    for i in range(3):
        _row(db, admin, "shop", alipay_id=sales, name=f"店{i}")
    assert "最多 3 家" in _bad(_row, db, admin, "shop", alipay_id=sales, name="店4")
    db.rollback()
    _row(db, admin, "shop", alipay_id=sales, name="店4", platform="xhs")  # 别的平台不算
    master = _row(db, admin, "alipay", entity_id=ent, account="m@x", role="master")
    buy = _row(db, admin, "alipay", entity_id=ent, account="b@x", role="purchase", corporate_pay=True)
    assert master
    _row(db, admin, "shop", alipay_id=buy, name="采购闲鱼", platform="xianyu", role="purchase", channel="corporate_pay")
    # 注销一家就能再挂
    first = db.query(LedgerShop).filter(LedgerShop.name == "店0").one()
    api.update_row("shop", first.id, api.RowIn(status="closed"), db=db, user=admin)
    _row(db, admin, "shop", alipay_id=sales, name="店5")
    # 个人主体随便挂
    me = _row(db, admin, "entity", legal_person_id=lp, name="林一本人", entity_type="person")
    ali = _row(db, admin, "alipay", entity_id=me, account="p@x")
    for i in range(4):
        _row(db, admin, "shop", alipay_id=ali, name=f"个人店{i}")
    # 个人主体改成个体户，下面 4 家超了，改不了
    assert "最多 3 家" in _bad(api.update_row, "entity", me, api.RowIn(entity_type="individual"), db=db, user=admin)


def test_业务员填报绕过上限时主体上标红(ctx):
    db, admin, lp, ent = ctx
    sales = _row(db, admin, "alipay", entity_id=ent, account="s@x")
    for i in range(3):
        _row(db, admin, "shop", alipay_id=sales, name=f"店{i}")
    lg.submit(db, admin, {"legal_person_name": "林一", "entity_name": "林一五金店", "alipay_account": "s@x", "shop_name": "店3"})
    db.commit()
    # 填报新建的法人（只有姓名）是另一个人；直接往原主体塞一家，模拟管理员合并后
    db.add(LedgerShop(entity_id=ent, alipay_id=sales, platform="xianyu", name="合并来的", role="sales", channel="alipay",
                      status="active", created_by_id="admin"))
    db.commit()
    e = api.read_legal_person(lp, db=db, user=admin)["entities"][0]
    assert e["xianyu_shops"] == 4
    assert {"level": "danger", "text": "挂了 4 家闲鱼店，一张执照最多 3 家"} in e["alerts"]


def test_个体户月10万_连续12个月450万和500万_只提醒():
    e = LedgerEntity(name="店", entity_type="individual", tax_payer="small", status="active", report_year=2025)
    today = date(2026, 11, 15)
    assert lg.entity_alerts(e, None, today, month=Decimal("70000")) == []
    assert lg.entity_alerts(e, None, today, month=Decimal("85000"))[0]["text"] == "本月卖了 ¥85,000，快到个体户月 10 万免税线（85%）"
    assert lg.entity_alerts(e, None, today, month=Decimal("100000"))[0]["level"] == "danger"
    assert lg.entity_alerts(e, None, today, year=Decimal("4600000"))[0]["level"] == "warn"
    assert "一般纳税人" in lg.entity_alerts(e, None, today, year=Decimal("5000000"))[0]["text"]
    co = LedgerEntity(name="公司", entity_type="company", tax_payer="small", status="active", report_year=2025)
    assert lg.entity_alerts(co, None, today, month=Decimal("200000")) == [], "月 10 万只看个体户"
    assert lg.entity_alerts(co, None, today, year=Decimal("5000000"))[0]["level"] == "danger"
    co.tax_payer = "general"
    assert lg.entity_alerts(co, None, today, year=Decimal("9000000")) == []
    person = LedgerEntity(name="林一", entity_type="person", tax_payer="small", status="active")
    assert lg.entity_alerts(person, Decimal("400000"), today, month=Decimal("200000"), year=Decimal("6000000")) == []
    assert lg.year_start(today) == date(2025, 12, 1)
    assert lg.year_start(date(2026, 1, 3)) == date(2025, 2, 1)


def test_个体户单店月8万提醒():
    ind = LedgerEntity(entity_type="individual")
    s = LedgerShop(role="sales", status="active")
    assert lg.shop_alerts(s, ind, Decimal("60000")) == []
    assert lg.shop_alerts(s, ind, Decimal("70000"))[0]["level"] == "warn"
    assert lg.shop_alerts(s, ind, Decimal("80000"))[0]["level"] == "danger"
    assert lg.shop_alerts(s, LedgerEntity(entity_type="company"), Decimal("900000")) == []
    assert lg.shop_alerts(LedgerShop(role="purchase", status="active"), ind, Decimal("900000")) == []


def test_每日账单一个户一天一份(ctx):
    db, admin, lp, ent = ctx
    a1 = _row(db, admin, "alipay", entity_id=ent, account="s1@x")
    day = date(2026, 11, 14)
    mk = lambda aid="": fin.create_daily_bill(DailyBillCreate(bill_date=day, file_url="u", file_name="f", alipay_id=aid),
                                              user=admin, db=db)
    assert mk().alipay_id == ""
    out = mk(a1)
    assert (out.alipay_id, out.alipay_account) == (a1, "s1@x")
    assert "已上传" in _bad(mk, a1)
    assert "已上传" in _bad(mk)
    assert "没有这个支付宝" in _bad(mk, "nope")
    assert db.query(DailyBill).count() == 2
    assert fin.get_daily_bill(day, alipay_id=a1, _=admin, db=db).alipay_account == "s1@x"
    assert fin.list_daily_bills(date_from=None, date_to=None, alipay_id="", page=1, size=20, _=admin, db=db).total == 1
    # 传过账单的支付宝删不掉
    assert "每日账单" in _bad(api.delete_row, "alipay", a1, db=db, user=admin)


def test_台账空着时先建第一条_一次建完(db_session):
    db = db_session
    admin = Staff(id="admin", staff_no="admin", username="admin", password_hash="x", name="管理员",
                  role=StaffRole.ADMIN, status=StaffStatus.ACTIVE)
    clerk = Staff(id="clerk", staff_no="c", username="c", password_hash="x", name="业务员",
                  role=StaffRole.SALES, status=StaffStatus.ACTIVE)
    db.add_all([admin, clerk])
    db.commit()
    assert api.me(db=db, user=admin)["empty"] is True
    assert api.me(db=db, user=clerk)["empty"] is False, "业务员照常只能填，不走引导"
    # 店铺名没填：整条都不建
    body = api.FirstIn(legal_person={"name": "林一", "phone": "00030902120"}, entity={"name": "林一五金店"},
                       alipay={"account": "s@x"}, shop={"platform": "xianyu", "name": ""})
    with pytest.raises(HTTPException):
        api.create_first(body, db=db, user=admin)
    db.rollback()
    assert db.query(LedgerLegalPerson).count() == 0
    body.shop["name"] = "林一的闲鱼"
    out = api.create_first(body, db=db, user=admin)
    shop = db.get(LedgerShop, out["shop_id"])
    assert (shop.alipay_id, shop.entity_id, shop.channel) == (out["alipay_id"], out["entity_id"], "alipay")
    assert db.get(LedgerAlipay, out["alipay_id"]).role == "sales"
    assert api.me(db=db, user=admin)["empty"] is False
    # 不走支付宝的：店铺直接挂主体
    out2 = api.create_first(api.FirstIn(legal_person={"name": "王二", "phone": "00026013516"}, entity={"name": "王二小店"},
                                        shop={"platform": "wechat_shop", "name": "王二微信店", "channel": "wechat"}),
                            db=db, user=admin)
    s2 = db.get(LedgerShop, out2["shop_id"])
    assert (s2.alipay_id, s2.entity_id, s2.channel, out2["alipay_id"]) == (None, out2["entity_id"], "wechat", None)
