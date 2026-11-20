"""老板全量台账第四步：审计报告另外 12 个模块（其他台账）。

红线：
  1. 密码、PIN、密钥、完整卡号不进来：账号 / 卡号只记后 4 位，字段里没有密码类；
  2. 制单 U 盾和复核 U 盾不在同一个人手里；财务章和法人章分开管；一个主体一个基本户；
  3. 红字发票要有原蓝票、要人批；申报提交人 ≠ 复核人；商户号只结算进同主体的户；
  4. 微信成交 1000 元以上要挂原闲鱼订单和关闭截图；远控完工没撤权关不掉；
  5. 雷达：印章超期、代账月结过了日子、开票额度、上季度申报、法人没背调、离职员工知道的密码、员工实名卡……
"""

from datetime import date, datetime

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import LedgerDevice, LedgerKnows, LedgerRecord, Staff
from app.routers import ledger as api
from app.services import ledger as lg
from app.services import ledger_records as lr

TODAY = date(2026, 11, 15)


@pytest.fixture()
def ctx(db_session, monkeypatch):
    monkeypatch.setattr(lg, "_today", lambda: TODAY)
    db = db_session
    admin = Staff(id="admin", staff_no="admin", username="admin", password_hash="x", name="管理员",
                  role=StaffRole.ADMIN, status=StaffStatus.ACTIVE)
    clerk = Staff(id="clerk", staff_no="E1", username="clerk", password_hash="x", name="秘书",
                  role=StaffRole.ADMIN, status=StaffStatus.ACTIVE)
    db.add_all([admin, clerk])
    db.commit()
    lp = api.create_row("legal_person", api.RowIn(name="林一"), db=db, user=admin)["id"]
    ent = api.create_row("entity", api.RowIn(legal_person_id=lp, name="林一五金店"), db=db, user=admin)["id"]
    return db, admin, lp, ent


def _rec(db, admin, kind, **kw):
    return api.create_record(kind, api.RecordIn(**kw), db=db, user=admin)["id"]


def _edit(db, admin, rid, **kw):
    return api.update_record(rid, api.RecordIn(**kw), db=db, user=admin)


def _ev(db, admin, rid, ev, **kw):
    return api.add_record_event(rid, ev, api.RecordIn(**kw), db=db, user=admin)


def _bad(fn, *a, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    assert e.value.status_code == 400
    return e.value.detail


def _radar(db, admin):
    return api.records_radar(db=db, user=admin)["items"]


def test_十二个模块都在_没有密码类字段(ctx):
    cat = api.records_catalog(_=None)
    assert len(cat["groups"]) == 12
    keys = {f["key"] for k in cat["kinds"].values() for f in k["fields"]}
    for bad in ("password", "secret", "pin", "cvv", "totp", "card_no", "account_no"):
        assert not any(bad == key or key.endswith("_" + bad) for key in keys), bad


def test_对公户_U盾_印章(ctx):
    db, admin, lp, ent = ctx
    assert "后 4 位" in _bad(_rec, db, admin, "bank_account", name="工行基本户", entity_id=ent, acct_type="basic", bank="工行",
                             last4="0009595436286835")
    db.rollback()
    bank = _rec(db, admin, "bank_account", name="工行基本户", entity_id=ent, acct_type="basic", bank="工行", last4="1234",
                reserved_phone="138 0000 0000")
    assert "只能有一个基本户" in _bad(_rec, db, admin, "bank_account", name="建行", entity_id=ent, acct_type="basic",
                                     bank="建行", last4="5678")
    db.rollback()
    _rec(db, admin, "ukey", name="制单盾", parent_id=bank, role="maker", holder_staff="clerk", pin_where="保险箱")
    assert "同一个人" in _bad(_rec, db, admin, "ukey", name="复核盾", parent_id=bank, role="checker", holder_staff="clerk")
    db.rollback()
    row = api.list_records(kind="bank_account", q=None, db=db, user=admin)["items"][0]
    texts = [x["text"] for x in row["alerts"]]
    assert "预留手机号 00030902120 不是台账里的卡，要掌握在公司手里" in texts and "只有制单 U 盾，没有复核 U 盾" in texts
    _rec(db, admin, "ukey", name="复核盾", parent_id=bank, role="checker", holder_staff="admin")
    _rec(db, admin, "ukey", name="桐新查账号", parent_id=bank, role="readonly", holder="桐新代账")

    seal = _rec(db, admin, "seal", name="财务章", entity_id=ent, seal_type="finance", custodian_staff="clerk")
    assert "分开管" in _bad(_rec, db, admin, "seal", name="法人章", entity_id=ent, seal_type="legal", custodian_staff="clerk")
    db.rollback()
    _ev(db, admin, seal, "lend", to="小王", purpose="文化局盖章", due_back="2026-11-10")
    assert "还回来才能再借" in _bad(_ev, db, admin, seal, "lend", to="小李", purpose="x")
    db.rollback()
    hit = [x for x in _radar(db, admin) if x["kind"] == "seal"]
    assert hit[0]["level"] == "danger" and "11 月 10 日该还" in hit[0]["text"]
    _ev(db, admin, seal, "return", scan="网盘 /印章/2026-11")
    assert not [x for x in _radar(db, admin) if x["kind"] == "seal"]
    assert [e["label"] for e in api.record_events(seal, db=db, _=admin)["items"]] == ["归还", "借出"]
    # 主体下还有台账条目，删不掉
    assert "其他台账" in _bad(api.delete_row, "entity", ent, db=db, user=admin)


def test_数电票_代账月结_申报(ctx):
    db, admin, lp, ent = ctx
    api.update_row("entity", ent, api.RowIn(invoice_quota="10000"), db=db, user=admin)
    _rec(db, admin, "invoice", name="0001", entity_id=ent, color="blue", amount="8500", issued_on="2026-11-03")
    assert "冲的是哪张蓝票" in _bad(_rec, db, admin, "invoice", name="0002", entity_id=ent, color="red", amount="100")
    db.rollback()
    red = _rec(db, admin, "invoice", name="0002", entity_id=ent, color="red", amount="100", orig_no="0001")
    radar = _radar(db, admin)
    assert any(x["title"] == "开票额度 · 林一五金店" and "85%" in x["text"] for x in radar)
    assert any(x["record_id"] == red and x["text"] == "红字发票等老板批" for x in radar)
    _ev(db, admin, red, "approve")
    assert "已经批过了" in _bad(_ev, db, admin, red, "approve")
    db.rollback()

    # 代账月结：记过一个月，以后每个月自动有
    old = _rec(db, admin, "close_month", name="桐新", month="2026-10")
    assert "已经有了" in _bad(_rec, db, admin, "close_month", name="桐新", month="2026-10")
    db.rollback()
    texts = [x["text"] for x in _radar(db, admin) if x["kind"] == "close_month"]
    assert "2026-10 的四张表：11 月 10 日该到，还没到" in texts and "2026-10 的完税回执：11 月 15 日要到" in texts
    months = sorted(r["attrs"]["month"] for r in api.list_records(kind="close_month", q=None, db=db, user=admin)["items"])
    assert months == ["2026-10", "2026-11"]
    api.tick_record(old, api.TickIn(item="reports"), db=db, user=admin)
    texts = [x["text"] for x in _radar(db, admin) if x["kind"] == "close_month"]
    assert not any("四张表" in t for t in texts)

    assert "不能是同一个人" in _bad(_rec, db, admin, "tax_filing", name="x", entity_id=ent, tax="vat", period="2026Q2",
                                   submitted_by="clerk", reviewed_by="clerk")
    db.rollback()
    assert "2026Q3" in _bad(_rec, db, admin, "tax_filing", name="x", entity_id=ent, tax="vat", period="2026-09",
                            submitted_by="clerk", reviewed_by="admin")
    db.rollback()
    _rec(db, admin, "tax_filing", name="Q2 增值税", entity_id=ent, tax="vat", period="2026Q2", submitted_by="clerk",
         reviewed_by="admin")
    miss = [x for x in _radar(db, admin) if x["kind"] == "tax_filing"]
    assert miss == [{"level": "danger", "group": "bank", "kind": "tax_filing", "title": "申报 · 林一五金店",
                     "text": "2026Q3 增值税申报没记，10 月 15 日截止，已经过了"}]


def test_商户号_微信成交_预存款_远控(ctx):
    db, admin, lp, ent = ctx
    lp2 = api.create_row("legal_person", api.RowIn(name="王二"), db=db, user=admin)["id"]
    ent2 = api.create_row("entity", api.RowIn(legal_person_id=lp2, name="王二小店"), db=db, user=admin)["id"]
    bank2 = _rec(db, admin, "bank_account", name="王二经营卡", entity_id=ent2, acct_type="owner_card", bank="农行", last4="0001")
    assert "同一个主体" in _bad(_rec, db, admin, "merchant", name="微信", entity_id=ent, provider="wechat", mch_no="1600001",
                              parent_id=bank2)
    db.rollback()
    _rec(db, admin, "merchant", name="微信", entity_id=ent, provider="wechat", mch_no="1600001")
    api.create_row("shop", api.RowIn(entity_id=ent, name="林一微信小店", platform="wechat_shop", channel="wechat",
                                     merchant_no="1699999"), db=db, user=admin)
    shop_warn = [x for x in _radar(db, admin) if x["title"] == "店铺 · 林一微信小店"]
    assert "不在商户号台账里" in shop_warn[0]["text"]

    assert "1000 元以上" in _bad(_rec, db, admin, "offline_deal", name="iPad 卖家", deal_amount="1200", refund_state="pending")
    db.rollback()
    deal = _rec(db, admin, "offline_deal", name="iPad 卖家", deal_amount="850", refund_state="pending")
    assert any(x["record_id"] == deal and "别冲减采购成本" in x["text"] for x in _radar(db, admin))

    sup = _rec(db, admin, "supplier", name="天远背调", skind="bgcheck", balance="120")
    hit = [x for x in _radar(db, admin) if x.get("record_id") == sup]
    assert hit[0]["level"] == "danger" and "低于 ¥150" in hit[0]["text"]
    _ev(db, admin, sup, "recharge", amount="500")
    assert db.get(LedgerRecord, sup).attrs["balance"] == "620.00"
    assert not any(x.get("record_id") == sup for x in _radar(db, admin))

    job = _rec(db, admin, "remote_job", name="张先生", device_code="123 456 789", finished_on="2026-11-14", revoked=True)
    assert any(x.get("record_id") == job and "提醒客户刷新验证码" in x["text"] for x in _radar(db, admin))
    assert "先撤权" in _bad(_edit, db, admin, job, status="closed")
    db.rollback()
    _edit(db, admin, job, refreshed=True, status="closed")


def test_谁知道密码_离职_员工实名卡_换号核验单(ctx):
    db, admin, lp, ent = ctx
    dev = api.create_row("device", api.RowIn(kind="phone", name="销售机 1"), db=db, user=admin)["id"]
    api.add_knows(api.KnowsIn(target_type="device", target_id=dev, what="lock", staff_ids=["clerk"]), db=db, user=admin)
    assert not [x for x in _radar(db, admin) if x["kind"] == "knows"]

    assert "在哪个员工名下" in _bad(api.create_row, "sim", api.RowIn(legal_person_id=lp, phone="00079719760",
                                                                   category="employee"), db=db, user=admin)
    db.rollback()
    emp = api.create_row("sim", api.RowIn(legal_person_id=lp, phone="00079719760", category="employee", staff_id="clerk"),
                         db=db, user=admin)["id"]
    sim = api.read_legal_person(lp, db=db, user=admin)["sims"][0]
    assert sim["staff_name"] == "秘书" and sim["alerts"][0]["level"] == "warn"

    db.get(Staff, "clerk").status = StaffStatus.DISABLED  # 离职
    db.commit()
    radar = _radar(db, admin)
    gone = [x for x in radar if x["kind"] == "knows"]
    assert gone[0]["level"] == "danger" and "设备 销售机 1的锁屏码" in gone[0]["text"]
    assert [x["level"] for x in radar if x["kind"] == "employee_sim"] == ["danger"]
    kid = api.list_knows(db=db, _=admin)["items"][0]["id"]
    api.rotated(kid, db=db, user=admin)
    assert not [x for x in _radar(db, admin) if x["kind"] == "knows"]

    # 删设备，谁知道它的密码一起删
    api.add_knows(api.KnowsIn(target_type="device", target_id=dev, what="cloud", staff_ids=["admin"]), db=db, user=admin)
    api.delete_row("device", dev, db=db, user=admin)
    assert db.query(LedgerKnows).count() == 0

    # 员工卡换成法人卡：台账里改了，外面要改的列成核验单
    api.update_row("alipay", api.create_row("alipay", api.RowIn(entity_id=ent, account="a@x"), db=db, user=admin)["id"],
                   api.RowIn(phone="00079719760"), db=db, user=admin)
    new = api.create_row("sim", api.RowIn(legal_person_id=lp, phone="00036408753"), db=db, user=admin)["id"]
    out = api.rebind_sim(emp, api.RebindIn(to_sim_id=new), db=db, user=admin)
    check = db.get(LedgerRecord, out["checklist_id"])
    labels = [i["label"] for i in check.attrs["items"]]
    assert check.name == "00079719760 → 00036408753" and labels[0] == "去平台把支付宝绑定手机号：a@x改成新号"
    assert any(x.get("record_id") == check.id for x in _radar(db, admin))
    for i in check.attrs["items"]:
        api.tick_record(check.id, api.TickIn(item=i["key"]), db=db, user=admin)
    assert not any(x.get("record_id") == check.id for x in _radar(db, admin))


def test_背调_代开店_风控工单_到期(ctx):
    db, admin, lp, ent = ctx
    assert any(x["title"] == "法人 · 林一" and "还没做过背调" in x["text"] for x in _radar(db, admin))
    old = _rec(db, admin, "bgcheck", name="林一", subject="nominee", legal_person_id=lp, checked_on="2026-06-01",
               result="clean")
    assert any(x.get("record_id") == old and "90 天要复查" in x["text"] for x in _radar(db, admin))
    _rec(db, admin, "bgcheck", name="林一", subject="nominee", legal_person_id=lp, checked_on="2026-11-01", result="clean")
    assert not [x for x in _radar(db, admin) if x["group"] == "bgcheck"]  # 只看最近一次

    a = _rec(db, admin, "client_project", name="客户甲", fee="3000", fee_due_on="2026-10-20", stage="alipay", face_videos=3)
    b = _rec(db, admin, "client_project", name="客户乙")
    assert db.get(LedgerRecord, a).attrs["archive_no"] == "DA-2026-0001"
    assert db.get(LedgerRecord, b).attrs["archive_no"] == "DA-2026-0002"
    texts = [x["text"] for x in _radar(db, admin) if x.get("record_id") == a]
    assert "服务费逾期 26 天没收" in texts and "人脸视频只有 3 段（要 5 段）" in texts
    assert [x["level"] for x in _radar(db, admin) if x.get("record_id") == a][0] == "danger"

    t = _rec(db, admin, "risk_ticket", name="闲鱼刷脸", tkind="face", opened_at="2026-01-01 09:00", sla_hours=2)
    assert any(x.get("record_id") == t and x["text"].startswith("超时") for x in _radar(db, admin))

    srv = _rec(db, admin, "server", name="京东云", disk_total_gb=99, disk_used_gb=76)
    sub = _rec(db, admin, "subscription", name="阿奇索", category="delivery", expires_on="2026-11-18")
    hw = _rec(db, admin, "hardware", name="N100 NAS", hkind="nas", encrypted=True)
    lease = _rec(db, admin, "site", name="富阳总部", use="office", lease_end="2027-01-10")
    got = {x["record_id"]: x for x in _radar(db, admin) if x.get("record_id") in (srv, sub, hw, lease)}
    assert got[srv]["text"] == "磁盘用了 77%，只剩 23G"
    assert got[sub]["level"] == "danger" and "超时赔付" in got[sub]["text"]
    assert "断电重启会锁死" in got[hw]["text"]
    assert "租约还有 56 天到期" in got[lease]["text"]


def test_支付宝转账证书_店铺币种(ctx):
    db, admin, lp, ent = ctx
    ali = api.create_row("alipay", api.RowIn(entity_id=ent, account="a@x", cert_expires_on="2026-12-01",
                                             transfer_scene="二手回收"), db=db, user=admin)["id"]
    api.create_row("shop", api.RowIn(alipay_id=ali, name="东京代购", platform="overseas_buy", currency="JPY"), db=db, user=admin)
    a = api.read_legal_person(lp, db=db, user=admin)["entities"][0]["alipays"][0]
    assert a["alerts"] == [{"level": "warn", "text": "转账证书还有 16 天到期，要换"}]
    assert a["shops"][0]["currency"] == "JPY" and a["shops"][0]["platform_label"] == "海外采购站"
    assert any(x["title"] == "支付宝 · a@x" for x in _radar(db, admin))
    assert "币种不对" in _bad(api.create_row, "shop", api.RowIn(alipay_id=ali, name="x", currency="BTC"), db=db, user=admin)
