"""老板全量台账第二步：手机卡、代理 IP、设备。密码不存。

红线：
  1. 一证五号：法人名下主卡 + 副卡 + 原有个人卡，同一运营商最多 5 张，满了只能用外部合约卡；
  2. 副卡挂同一法人、同一运营商的主卡；主卡下还有副卡就停不了、删不了；
  3. 外部合约卡要实名人和到期日，快到期提醒换绑；
  4. 同一平台的两个店不能共用一条代理；还有设备在用的代理停不了；
  5. 一张卡只插一台手机；只有销售设备能挂店铺；
  6. 换号把台账里记着旧号的地方都换掉；
  7. 群控同步只空补齐，按闲鱼号把店铺挂到设备上。
"""

import asyncio
from datetime import date

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import LedgerAlipay, LedgerDevice, LedgerEntity, LedgerLegalPerson, LedgerProxy, LedgerShop, LedgerSim, SaleShop, Staff
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
    lp = api.create_row("legal_person", api.RowIn(name="林一"), db=db, user=admin)
    return db, admin, lp["id"]


def _row(db, admin, level, **kw):
    return api.create_row(level, api.RowIn(**kw), db=db, user=admin)["id"]


def _edit(db, admin, level, rid, **kw):
    return api.update_row(level, rid, api.RowIn(**kw), db=db, user=admin)


def _bad(fn, *a, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    assert e.value.status_code == 400
    return e.value.detail


def _shop(db, admin, lp, name="林一的闲鱼", platform="xianyu", **kw):
    ent = db.query(LedgerEntity).filter_by(legal_person_id=lp).first()
    if ent is None:
        ent = db.get(LedgerEntity, _row(db, admin, "entity", legal_person_id=lp, name="林一五金店"))
    ali = db.query(LedgerAlipay).filter_by(entity_id=ent.id, role="sales").first()
    if ali is None:
        ali = db.get(LedgerAlipay, _row(db, admin, "alipay", entity_id=ent.id, account="s@x"))
    return _row(db, admin, "shop", alipay_id=ali.id, name=name, platform=platform, **kw)


def test_一证五号_原有个人卡也算(ctx):
    db, admin, lp = ctx
    _edit(db, admin, "legal_person", lp, personal_cards={"中国联通": 2})
    m = _row(db, admin, "sim", legal_person_id=lp, phone="186 0000 0001", carrier="中国联通")
    assert db.get(LedgerSim, m).phone == "00035460177"  # 去掉空格，反查才对得上
    _row(db, admin, "sim", legal_person_id=lp, phone="00067763153", carrier="中国联通", category="sub", master_id=m)
    _row(db, admin, "sim", legal_person_id=lp, phone="00097891777", carrier="中国联通", category="sub", master_id=m)
    msg = _bad(_row, db, admin, "sim", legal_person_id=lp, phone="00032168323", carrier="中国联通", category="sub", master_id=m)
    assert "一证五号" in msg and "原有个人卡 2 张" in msg
    db.rollback()
    _row(db, admin, "sim", legal_person_id=lp, phone="00068057207", carrier="中国移动")  # 别家运营商不占
    _row(db, admin, "sim", legal_person_id=lp, phone="00032168323", carrier="中国联通", category="external",
         holder="张三", contract_end="2027-06-30")  # 外部卡不占名额
    assert "超过一证五号" in _bad(_edit, db, admin, "legal_person", lp, personal_cards={"中国联通": 3})
    db.rollback()
    assert "已经在台账里" in _bad(_row, db, admin, "sim", legal_person_id=lp, phone="00035460177", carrier="中国移动")


def test_副卡跟主卡走_主卡下有副卡停不了(ctx):
    db, admin, lp = ctx
    other = _row(db, admin, "legal_person", name="王二")
    m = _row(db, admin, "sim", legal_person_id=lp, phone="00035460177", carrier="中国联通")
    m2 = _row(db, admin, "sim", legal_person_id=other, phone="00080753695", carrier="中国联通")
    assert "副卡要选" in _bad(_row, db, admin, "sim", legal_person_id=lp, phone="00067763153", carrier="中国联通", category="sub")
    assert "同一个法人、同一家运营商" in _bad(_row, db, admin, "sim", legal_person_id=lp, phone="00067763153",
                                         carrier="中国联通", category="sub", master_id=m2)
    assert "同一个法人、同一家运营商" in _bad(_row, db, admin, "sim", legal_person_id=lp, phone="00018430701",
                                         carrier="中国移动", category="sub", master_id=m)
    assert "只有副卡" in _bad(_row, db, admin, "sim", legal_person_id=lp, phone="00018430701", carrier="中国移动", billing="shared")
    db.rollback()
    sub = _row(db, admin, "sim", legal_person_id=lp, phone="00067763153", carrier="中国联通", category="sub", master_id=m,
               billing="shared")
    assert "副卡" in _bad(_edit, db, admin, "sim", m, status="closed")
    db.rollback()
    assert "副卡" in _bad(api.delete_row, "sim", m, db=db, user=admin)
    _edit(db, admin, "sim", sub, status="closed")
    _edit(db, admin, "sim", m, status="closed")


def test_外部合约卡_到期和话费提醒(ctx):
    db, admin, lp = ctx
    assert "实名" in _bad(_row, db, admin, "sim", legal_person_id=lp, phone="00021897221", category="external")
    assert "到期日" in _bad(_row, db, admin, "sim", legal_person_id=lp, phone="00021897221", category="external", holder="张三")
    db.rollback()
    _row(db, admin, "sim", legal_person_id=lp, phone="00021897221", category="external", holder="张三", contract_end="2026-12-05")
    _row(db, admin, "sim", legal_person_id=lp, phone="00097054310", category="external", holder="张三", contract_end="2026-11-01")
    low = _row(db, admin, "sim", legal_person_id=lp, phone="00068057207", monthly_rent="39", balance="20", balance_on="2026-11-10")
    db.commit()
    lp_out = api.read_legal_person(lp, db=db, user=admin)
    texts = {c["phone"]: [x["text"] for x in c["alerts"]] for c in lp_out["sims"]}
    assert texts["00021897221"] == ["00021897221 的合约还有 20 天到期，要换绑"]
    assert "到期了" in texts["00097054310"][0]
    assert "话费只剩 ¥20.00" in texts["00068057207"][0]
    assert api.list_legal_persons(q=None, needs_check=None, page=1, size=30, db=db, _=admin)["items"][0]["alerts"] == 3

    api.recharge_sim(low, api.RechargeIn(amount=50), db=db, user=admin)
    c = db.get(LedgerSim, low)
    assert str(c.balance) == "70.00" and c.balance_on == TODAY
    assert api.list_charges(target_id=low, db=db, _=admin)["items"][0]["after"] == "70.00"
    # 按号码也能搜到法人
    assert api.list_legal_persons(q="1380000", needs_check=None, page=1, size=30, db=db, _=admin)["total"] == 1


def test_同一平台不能共用一条代理_在用的停不了(ctx):
    db, admin, lp = ctx
    p = _row(db, admin, "proxy", code="IP-HZ-01", host="127.0.0.1", port=1080, expires_on="2026-11-20")
    e1 = _row(db, admin, "device", kind="env", name="环境 1", proxy_id=p)
    e2 = _row(db, admin, "device", kind="env", name="环境 2", proxy_id=p)
    _shop(db, admin, lp, name="闲鱼一店", device_id=e1)
    _shop(db, admin, lp, name="小红书一店", platform="xhs", device_id=e2)  # 不同平台可以
    msg = _bad(_shop, db, admin, lp, name="闲鱼二店", device_id=e2)
    assert "IP-HZ-01" in msg and "闲鱼一店" in msg
    db.rollback()
    s2 = _shop(db, admin, lp, name="闲鱼二店")
    e3 = _row(db, admin, "device", kind="env", name="环境 3")
    _edit(db, admin, "shop", s2, device_id=e3)
    assert "闲鱼一店" in _bad(_edit, db, admin, "device", e3, proxy_id=p)  # 换代理也拦
    db.rollback()

    assert "直连" in _bad(_edit, db, admin, "proxy", p, status="closed")
    db.rollback()
    assert "直连" in _bad(api.delete_row, "proxy", p, db=db, user=admin)
    assert "编号" in _bad(_row, db, admin, "proxy", code="IP-HZ-01")
    db.rollback()

    out = api.list_proxies(db=db, user=admin)["items"][0]
    assert out["alerts"][0]["text"] == "还有 5 天到期"
    assert {s["name"] for s in out["shops"]} == {"闲鱼一店", "小红书一店"}
    api.renew_proxy(p, api.RenewIn(months=1, amount=10), db=db, user=admin)
    assert db.get(LedgerProxy, p).expires_on == date(2026, 12, 20)  # 没过期从到期日往后续


def test_一张卡只插一台手机_只有销售设备挂店铺(ctx):
    db, admin, lp = ctx
    c = _row(db, admin, "sim", legal_person_id=lp, phone="00068057207")
    ph = _row(db, admin, "device", kind="phone", name="工作机 1", sim1_id=c)
    assert "插在 工作机 1" in _bad(_row, db, admin, "device", kind="phone", name="工作机 2", sim2_id=c)
    assert "同一张卡" in _bad(_row, db, admin, "device", kind="phone", name="工作机 2", sim1_id=c, sim2_id=c)
    db.rollback()
    assert "手机里" in _bad(api.delete_row, "sim", c, db=db, user=admin)
    env = _row(db, admin, "device", kind="env", name="环境", sim1_id=c)  # 环境没有卡槽，填了也不记
    assert db.get(LedgerDevice, env).sim1_id is None

    buy = _row(db, admin, "device", kind="phone", name="采购机", purpose="purchase")
    assert "销售用的设备" in _bad(_shop, db, admin, lp, device_id=buy)
    db.rollback()
    _shop(db, admin, lp, device_id=ph)
    assert "设备用途要和账号一致" in _bad(_edit, db, admin, "device", ph, purpose="purchase")
    db.rollback()
    pc = _row(db, admin, "device", kind="pc", name="DEV-PC-01")
    _edit(db, admin, "device", env, host_id=pc)
    assert "电脑" in _bad(_edit, db, admin, "device", env, host_id=ph)
    db.rollback()
    assert "环境" in _bad(api.delete_row, "device", pc, db=db, user=admin)


def test_换号_台账里的旧号都换掉(ctx):
    db, admin, lp = ctx
    old = _row(db, admin, "sim", legal_person_id=lp, phone="00068057207")
    new = _row(db, admin, "sim", legal_person_id=lp, phone="00018430701")
    _edit(db, admin, "legal_person", lp, phone="138-0000-0001")
    ent = _row(db, admin, "entity", legal_person_id=lp, name="林一五金店", tax_phone="00068057207", liaison_phone="00068057207")
    ali = _row(db, admin, "alipay", entity_id=ent, account="00068057207", phone="00068057207")
    shop = _row(db, admin, "shop", alipay_id=ali, name="店", phone="+8613800000001")
    ph = _row(db, admin, "device", kind="phone", name="工作机", sim1_id=old)
    db.commit()

    uses = api.sim_uses(old, db=db, user=admin)["items"]
    assert len(uses) == 7  # 法人、办税、联络员、支付宝绑定、店铺绑定、支付宝登录名、插在手机里
    out = api.rebind_sim(old, api.RebindIn(to_sim_id=new), db=db, user=admin)
    assert out["moved"] == 5 and out["logins"] == ["00068057207"]
    db.expire_all()
    assert db.get(LedgerLegalPerson, lp).phone == "00018430701"
    e = db.get(LedgerEntity, ent)
    assert e.tax_phone == e.liaison_phone == "00018430701"
    assert db.get(LedgerAlipay, ali).phone == "00018430701" and db.get(LedgerAlipay, ali).account == "00068057207"
    assert db.get(LedgerShop, shop).phone == "00018430701"
    assert db.get(LedgerDevice, ph).sim1_id is None and db.get(LedgerSim, old).status == "closed"


def test_群控同步_只空补齐_店铺按闲鱼号挂上(ctx, monkeypatch):
    db, admin, lp = ctx
    from app.services.gc_bridge import client as gc

    db.add(SaleShop(id="ss1", code="S1", label="蓝鲸", xianyu_user_name="东南亚泡菜味的蓝鲸"))
    db.add(SaleShop(id="ss2", code="S2", label="荆芥", xianyu_user_name="随便", gc_account_id="acc2"))
    db.commit()
    s1 = _shop(db, admin, lp, name="蓝鲸店", sale_shop_id="ss1")
    s2 = _shop(db, admin, lp, name="荆芥店", platform="xianyu", sale_shop_id="ss2")
    sim = _row(db, admin, "sim", legal_person_id=lp, phone="00068057207")
    devices = [
        {"id": "g1", "kind": "browser", "hw_id": "k1hwgbtm", "status": "OFFLINE", "brand": "adspower", "model": "browser",
         "account_id": "acc1", "last_online_at": "2026-11-11T06:01:52"},
        {"id": "g2", "kind": "browser", "hw_id": "k1ho3jr0", "status": "OFFLINE", "account_id": "acc2"},
        {"id": "g3", "kind": "android", "hw_id": "aid", "status": "OFFLINE", "brand": "Xiaomi", "model": "Redmi 12",
         "serial": "SN1", "imei1": "861", "phone_number": "+86 138 0000 0001"},
        {"id": "g4", "kind": "android", "status": "DISABLED"},
    ]
    accounts = [{"id": "acc1", "nick": "东南亚泡菜味的蓝鲸", "device_id": "g1"},
                {"id": "acc2", "nick": "洞穴Q弹的荆芥", "device_id": "g2"}]

    async def _devices():
        return devices

    async def _accounts():
        return accounts

    monkeypatch.setattr(gc, "list_devices", _devices)
    monkeypatch.setattr(gc, "list_accounts", _accounts)

    out = asyncio.run(api.sync_devices(db=db, user=admin))
    assert out == {"created": 3, "updated": 0, "shops_linked": 2, "sims_put": 1}
    env = db.query(LedgerDevice).filter_by(ads_user_id="k1hwgbtm").one()
    assert env.name == "环境 k1hwgbtm" and env.gc_nick == "东南亚泡菜味的蓝鲸" and env.kind == "env"
    assert db.get(LedgerShop, s1).device_id == env.id
    assert db.get(LedgerShop, s2).device_id == db.query(LedgerDevice).filter_by(ads_user_id="k1ho3jr0").one().id
    phone = db.query(LedgerDevice).filter_by(serial="SN1").one()
    assert phone.kind == "phone" and phone.model == "Xiaomi Redmi 12" and phone.sim1_id == sim

    _edit(db, admin, "device", env.id, name="蓝鲸的环境")  # 人改过的名字不被覆盖
    out = asyncio.run(api.sync_devices(db=db, user=admin))
    assert out == {"created": 0, "updated": 3, "shops_linked": 0, "sims_put": 0}
    assert db.get(LedgerDevice, env.id).name == "蓝鲸的环境"
    assert len(api.list_devices(kind="env", db=db, user=admin)["items"]) == 2
