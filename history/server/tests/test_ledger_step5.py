"""台账第五步（V2 交付包，11-17）：看缺口、开店教程与进度、跨轨两道锁、密码库。

对照交付包 tests/verify_ledger_all.py 新加的三套：
  Case 11 密码库：不是主人看明文一律 403；员工只能领给自己用的动态码；员工交的新密码自己看不到；
  Case 12 两道锁：支付宝没过 C10 做不了闲鱼 S09、没过 D15 做不了 S18，过了自动放行；S18 过了店铺改在用；
          材料填 0 拦下；打回重交是第 2 版、第 1 版的打回意见还在；
  Case 13 缺口与派单：没发布教程的平台派不了；老板发布了才能派；审核人写教程 → 提交 → 老板发布。
"""

import time
from datetime import date
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.config import settings
from app.enums import StaffRole, StaffStatus
from app.models import (LedgerAlipay, LedgerBillRow, LedgerCase, LedgerShop, LedgerTutorial, LedgerVault,
                        LedgerVaultFactor, Staff)
from app.routers import ledger as api
from app.services import ledger_onboard as lo
from app.services import ledger_vault as lv

KEK = "11" * 32


def _staff(db, sid, role=StaffRole.SALES, no=None):
    s = Staff(id=sid, staff_no=no or sid, username=sid, password_hash="x", name=sid, role=role, status=StaffStatus.ACTIVE)
    db.add(s)
    return s


@pytest.fixture()
def ctx(db_session, monkeypatch):
    monkeypatch.setattr(settings, "ledger_vault_kek", KEK)
    monkeypatch.setattr(settings, "ledger_vault_owners", "boss")
    db = db_session
    boss = _staff(db, "boss", StaffRole.ADMIN)
    admin2 = _staff(db, "admin2", StaffRole.ADMIN)
    sup = _staff(db, "sup")
    emp = _staff(db, "emp")
    emp2 = _staff(db, "emp2")
    db.commit()
    lo.set_reviewers(db, boss, [sup.id])
    lp = api.create_row("legal_person", api.RowIn(name="林一"), db=db, user=boss)["id"]
    ent = api.create_row("entity", api.RowIn(legal_person_id=lp, name="林一五金店", entity_type="company"), db=db, user=boss)["id"]
    db.commit()
    return db, dict(boss=boss, admin2=admin2, sup=sup, emp=emp, emp2=emp2), lp, ent


def _bad(fn, *a, code=400, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    assert e.value.status_code == code, e.value.detail
    return e.value.detail


def _walk(db, c: LedgerCase, until: str, by: Staff, reviewer: Staff, amount: str = "0.07"):
    """一步一步交到 until 之前（until 那步不交）。要审核的让 reviewer 过。"""
    done = {s["code"] for s in lo.evaluate(db, c, full=False)["steps"] if s["state"] in ("approved", "skipped")}
    for sp in lo.steps_of(db.get(LedgerTutorial, c.tutorial_id)):
        if sp["code"] == until:
            return
        if sp["code"] in done:
            continue
        mats = {m["key"]: (amount if m["key"] == "unique_test_yuan" else "已做") for m in sp["materials"]}
        if sp.get("vault_lockin"):
            lo.lock_in(db, by, c.id, sp["code"], {"password": "DEMO_ONLY_REDACTED" + sp["code"]})
        r = lo.submit_step(db, by, c.id, sp["code"], mats, True)
        if r.status == "submitted":
            lo.review_step(db, reviewer, c.id, sp["code"], True, None)
        db.commit()


def _state(db, c, code):
    return next(s for s in lo.evaluate(db, c)["steps"] if s["code"] == code)


# ---------------------------------------------------------------- Case 12 两道锁

def _two_tracks(db, p, ent):
    ali_case = lo.dispatch(db, p["sup"], {"kind": "alipay", "entity_id": ent, "assignee_id": p["emp"].id})
    ali = db.get(LedgerAlipay, ali_case.target_id)
    assert ali.status == "building" and ali.account.startswith(lo.PLACEHOLDER)
    shop_case = lo.dispatch(db, p["sup"], {"kind": "shop", "platform": "xianyu", "alipay_id": ali.id,
                                           "assignee_id": p["emp"].id})
    db.commit()
    return ali_case, shop_case


def test_两道锁_C10锁S09_D15锁S18_走完店铺在用(ctx):
    db, p, lp, ent = ctx
    ali_case, shop_case = _two_tracks(db, p, ent)
    assert shop_case.link_case_id == ali_case.id

    _walk(db, shop_case, "S09", p["emp"], p["sup"])
    assert _state(db, shop_case, "S09")["state"] == "gated"
    assert "C10" in _bad(lo.submit_step, db, p["emp"], shop_case.id, "S09", {"ent_store_cert_img": "x"}, True)
    db.rollback()

    _walk(db, ali_case, "D15", p["emp"], p["sup"])  # 支付宝过了 C10、交了 D14
    assert _state(db, shop_case, "S09")["state"] == "active"
    _walk(db, shop_case, "S18", p["emp"], p["sup"])
    assert _state(db, shop_case, "S18")["state"] == "gated"

    # D15：账单里有 0.07 那一笔，审核页看得到
    db.add(LedgerBillRow(alipay_id=ali_case.target_id, bill_date=date(2026, 11, 16), flow_no="F1", income=Decimal("0.07")))
    db.commit()
    d15 = _state(db, ali_case, "D15")
    assert d15["bill_check"]["amount"] == "0.07" and len(d15["bill_check"]["found"]) == 1
    _walk(db, ali_case, "__end__", p["emp"], p["sup"])
    assert db.get(LedgerCase, ali_case.id).status == "done"
    assert db.get(LedgerAlipay, ali_case.target_id).status == "active"

    assert _state(db, shop_case, "S18")["state"] == "active"
    _walk(db, shop_case, "__end__", p["emp"], p["sup"])
    assert db.get(LedgerShop, shop_case.target_id).status == "active"
    assert db.get(LedgerCase, shop_case.id).status == "done"


def test_上线前就在用的支付宝_锁直接放行_没挂支付宝就一直锁(ctx):
    db, p, lp, ent = ctx
    old = api.create_row("alipay", api.RowIn(entity_id=ent, account="old@x"), db=db, user=p["boss"])["id"]
    c = lo.dispatch(db, p["sup"], {"kind": "shop", "platform": "xianyu", "alipay_id": old, "assignee_id": p["emp"].id})
    db.commit()
    _walk(db, c, "S09", p["emp"], p["sup"])
    assert _state(db, c, "S09")["state"] == "active"
    db.get(LedgerShop, c.target_id).alipay_id = None
    db.commit()
    assert _state(db, c, "S09")["state"] == "gated"


def test_材料填0拦下_打回重交第2版_旧意见还在_不能审自己的(ctx):
    db, p, lp, ent = ctx
    ali_case, _ = _two_tracks(db, p, ent)
    _walk(db, ali_case, "A04", p["emp"], p["sup"])
    assert "不能只填 0" in _bad(lo.submit_step, db, p["emp"], ali_case.id, "A04",
                                {"license_photo": "0", "uscc_verified": "x"}, False)
    assert "要填" in _bad(lo.submit_step, db, p["emp"], ali_case.id, "A04", {"license_photo": "x"}, False)
    lo.submit_step(db, p["emp"], ali_case.id, "A04", {"license_photo": "图1", "uscc_verified": "91330000"}, False)
    assert "至少 4 个字" in _bad(lo.review_step, db, p["sup"], ali_case.id, "A04", False, "不行")
    lo.review_step(db, p["sup"], ali_case.id, "A04", False, "信用代码少一位，对着公示网重填")
    db.commit()
    assert _state(db, ali_case, "A04")["state"] == "rejected"
    lo.submit_step(db, p["emp"], ali_case.id, "A04", {"license_photo": "图1", "uscc_verified": "913300001234567890"}, False)
    db.commit()
    hist = _state(db, ali_case, "A04")["history"]
    assert [h["version_no"] for h in hist] == [2, 1]
    assert hist[1]["review_note"] == "信用代码少一位，对着公示网重填"
    # 审核人自己交的不能自己审；后面的步骤还没到，交不了
    assert "还没到" in _bad(lo.submit_step, db, p["emp"], ali_case.id, "B05", {"x": "1"}, False)


def test_审核人不能审自己交的_管理员可以(ctx):
    db, p, lp, ent = ctx
    c = lo.dispatch(db, p["sup"], {"kind": "alipay", "entity_id": ent, "assignee_id": p["sup"].id})
    db.commit()
    _walk(db, c, "A04", p["sup"], p["boss"])
    lo.submit_step(db, p["sup"], c.id, "A04", {"license_photo": "x", "uscc_verified": "y"}, False)
    _bad(lo.review_step, db, p["sup"], c.id, "A04", True, None, code=403)
    lo.review_step(db, p["boss"], c.id, "A04", True, None)


def test_D14测试金额每个支付宝不能一样(ctx):
    db, p, lp, ent = ctx
    a1 = lo.dispatch(db, p["sup"], {"kind": "alipay", "entity_id": ent, "assignee_id": p["emp"].id})
    a2 = lo.dispatch(db, p["sup"], {"kind": "alipay", "entity_id": ent, "assignee_id": p["emp"].id})
    db.commit()
    _walk(db, a1, "D15", p["emp"], p["sup"], amount="0.03")
    _walk(db, a2, "D14", p["emp"], p["sup"])
    assert "已经被" in _bad(lo.submit_step, db, p["emp"], a2.id, "D14", {"unique_test_yuan": "0.03", "test_tx_no": "t"}, False)
    lo.submit_step(db, p["emp"], a2.id, "D14", {"unique_test_yuan": "0.04", "test_tx_no": "t"}, False)


def test_跳步只有老板批_批了算过(ctx):
    db, p, lp, ent = ctx
    c = lo.dispatch(db, p["sup"], {"kind": "alipay", "entity_id": ent, "assignee_id": p["emp"].id})
    db.commit()
    assert "4 个字" in _bad(lo.request_skip, db, p["emp"], c.id, "A01", "不想")
    _bad(lo.request_skip, db, p["emp"], c.id, "A02", "法人不在现场办不了")  # 不是当前这一步
    s = lo.request_skip(db, p["emp"], c.id, "A01", "法人主邮箱已经在台账里登记过了")
    db.commit()
    _bad(lo.decide_skip, db, p["sup"], s.id, True, None, code=403)
    lo.decide_skip(db, p["boss"], s.id, True, "可以")
    db.commit()
    assert _state(db, c, "A01")["state"] == "skipped"
    assert _state(db, c, "A02")["state"] == "active"


# ---------------------------------------------------------------- Case 13 缺口、派单、教程

def test_没有发布教程派不了_老板发布后能派(ctx):
    db, p, lp, ent = ctx
    lo.ensure_seed(db)
    db.commit()
    assert "还没有发布" in _bad(lo.dispatch, db, p["sup"], {"kind": "shop", "platform": "wechat_shop", "entity_id": ent,
                                                            "assignee_id": p["emp"].id})
    db.rollback()
    draft = db.query(LedgerTutorial).filter(LedgerTutorial.code == "WECHAT_SHOP").one()
    assert draft.status == "draft"
    lo.submit_tutorial(db, p["sup"], draft.id)
    _bad(lo.verdict_tutorial, db, p["sup"], draft.id, True, None, code=403)
    assert "4 个字" in _bad(lo.verdict_tutorial, db, p["boss"], draft.id, False, "不行")
    lo.verdict_tutorial(db, p["boss"], draft.id, True, "上线")
    db.commit()
    c = lo.dispatch(db, p["sup"], {"kind": "shop", "platform": "wechat_shop", "entity_id": ent, "assignee_id": p["emp"].id})
    assert db.get(LedgerShop, c.target_id).channel == "other"
    # 同一家店不能有两份没走完的进度
    assert "没走完" in _bad(lo.dispatch, db, p["sup"], {"kind": "shop", "target_id": c.target_id, "assignee_id": p["emp"].id})
    # 员工派不了单
    _bad(lo.dispatch, db, p["emp"], {"kind": "alipay", "entity_id": ent, "assignee_id": p["emp"].id}, code=403)


def test_审核人写新平台教程_改已发布的出新版本_发布后旧版归档(ctx):
    db, p, lp, ent = ctx
    body = [{"title": "入驻", "steps": [{"code": "R01", "title": "扫码入驻", "materials": [{"key": "shot", "label": "截图"}]}]}]
    assert "跨轨锁" in _bad(lo.save_tutorial, db, p["sup"], {"kind": "alipay", "code": "XYZ", "title": "t",
                                                            "body": [{"title": "a", "steps": [{"code": "A01", "title": "t", "gate": "alipay:C10"}]}]}, None)
    t = lo.save_tutorial(db, p["sup"], {"kind": "shop", "platform": "xhs", "title": "小红书开店", "body": body}, None)
    assert t.code == "SHOP_XHS" and t.status == "draft"
    lo.submit_tutorial(db, p["sup"], t.id)
    lo.verdict_tutorial(db, p["boss"], t.id, True, None)
    db.commit()
    t2 = lo.save_tutorial(db, p["sup"], {"title": "小红书开店（改）"}, t.id)
    assert t2.id != t.id and t2.version == 2 and t.status == "published"
    lo.submit_tutorial(db, p["sup"], t2.id)
    lo.verdict_tutorial(db, p["boss"], t2.id, True, None)
    db.commit()
    assert db.get(LedgerTutorial, t.id).status == "archived"
    cov = {x["key"]: x["state"] for x in lo.coverage(db)}
    assert cov["xhs"] == "published" and cov["alipay"] == "published" and cov["douyin"] == "none"


def test_缺口_目标减就绪减开店中_闲鱼目标不能超过执照乘3(ctx):
    db, p, lp, ent = ctx
    assert "最多挂 3 家" in _bad(lo.set_target, db, p["boss"], lp, {"targets": {"licenses": 1, "platform:xianyu": 4}})
    _bad(lo.set_target, db, p["sup"], lp, {"targets": {"licenses": 1}}, code=403)
    lo.set_target(db, p["boss"], lp, {"targets": {"licenses": 2, "alipays": 3, "platform:xianyu": 3}})
    old = api.create_row("alipay", api.RowIn(entity_id=ent, account="old@x"), db=db, user=p["boss"])["id"]
    lo.dispatch(db, p["sup"], {"kind": "alipay", "entity_id": ent, "assignee_id": p["emp"].id})
    lo.dispatch(db, p["sup"], {"kind": "shop", "platform": "xianyu", "alipay_id": old, "assignee_id": p["emp"].id})
    db.commit()
    g = {i["key"]: i for i in lo.gaps(db)[0]["items"]}
    assert (g["licenses"]["ready"], g["licenses"]["gap"]) == (1, 1)
    assert (g["alipays"]["ready"], g["alipays"]["building"], g["alipays"]["gap"]) == (1, 1, 1)
    assert (g["platform:xianyu"]["building"], g["platform:xianyu"]["gap"]) == (1, 2)
    texts = [i["text"] for i in lo.issues(db, p["boss"])]
    assert any("还差" in t for t in texts)
    assert not any("还差" in i["text"] for i in lo.issues(db, p["emp"]))  # 员工看不到缺口


# ---------------------------------------------------------------- Case 11 密码库

def _code(secret):
    return lv.totp_now(secret)[0]


def _bind(db, boss):
    secret = lv.bind_start(db, boss)["secret"]
    lv.bind_confirm(db, boss, _code(secret))
    db.commit()
    return secret


def _unlock(db, boss, secret):
    # 解锁的码不能和绑定时那个同一个 30 秒（防重放），往后拨一个窗口
    step = int(time.time() // 30) + 1
    return lv.unlock(db, boss, lv.totp_at(secret, step), "1.2.3.4")["token"]


def test_密码库_主人解锁看明文_别人403_库里没有明文(ctx):
    db, p, lp, ent = ctx
    _bad(lv.bind_start, db, p["admin2"], code=403)
    secret = _bind(db, p["boss"])
    token = _unlock(db, p["boss"], secret)
    v = lv.save(db, p["boss"], {"category": "alipay", "title": "支付宝 A", "login_name": "a@x", "password": "DEMO_ONLY_REDACTED",
                                "secondary": "135790", "totp": "JBSWY3DPEHPK3PXP", "assignee_id": "emp", "employee_totp": True})
    db.commit()
    assert "S3cret" not in v.secret and "135790" not in v.secret
    assert (v.has_password, v.has_secondary, v.has_totp) == (True, True, True)
    assert lv.reveal(db, p["boss"], v.id, token, "password") == {"value": "S3cret!"}
    # 别的管理员、员工都看不到明文
    _bad(lv.reveal, db, p["admin2"], v.id, token, "password", code=403)
    _bad(lv.reveal, db, p["emp"], v.id, None, "password", code=403)
    # 列表不带密文
    item = api.vault_items(q=None, db=db, _=p["boss"])["items"][0]
    assert "secret" not in item and "password" not in item
    # 密文挪到别的条目上解不开（附加数据绑了条目 id）
    with pytest.raises(Exception):
        lv.unseal("other-id", "alipay", v.secret)
    # 上锁后旧令牌没用了
    lv.lock(db, p["boss"], token)
    db.commit()
    _bad(lv.reveal, db, p["boss"], v.id, token, "password", code=401)


def test_密码库_员工只领自己的动态码_交的密码自己看不到(ctx):
    db, p, lp, ent = ctx
    secret = _bind(db, p["boss"])
    token = _unlock(db, p["boss"], secret)
    v = lv.save(db, p["boss"], {"category": "platform", "title": "淘宝 1", "totp": "JBSWY3DPEHPK3PXP",
                                "assignee_id": "emp", "employee_totp": True})
    db.commit()
    out = lv.code_for(db, p["emp"], v.id)
    assert out["code"] == lv.totp_now("JBSWY3DPEHPK3PXP")[0] and 0 < out["seconds_left"] <= 30
    _bad(lv.code_for, db, p["emp2"], v.id, code=403)
    # 员工在开店步骤交新密码：锁进库、给他用，他自己调不出明文
    c = lo.dispatch(db, p["sup"], {"kind": "alipay", "entity_id": ent, "assignee_id": p["emp"].id})
    db.commit()
    _walk(db, c, "B09", p["emp"], p["sup"])
    assert "交新设的密码" in _bad(lo.submit_step, db, p["emp"], c.id, "B09", {"alipay_uid_recorded": "2088000000000001"}, False)
    _bad(lo.lock_in, db, p["emp"], c.id, "A01", {"password": "DEMO_ONLY_REDACTED"})  # 不是交密码的步骤
    lo.lock_in(db, p["emp"], c.id, "B09", {"login_name": "e1@x", "password": "DEMO_ONLY_REDACTED", "secondary": "246810"})
    lo.submit_step(db, p["emp"], c.id, "B09", {"alipay_uid_recorded": "2088000000000001"}, False)
    db.commit()
    item = db.query(LedgerVault).filter(LedgerVault.target_id == c.target_id).one()
    assert item.assignee_id == "emp" and item.has_password
    _bad(lv.reveal, db, p["emp"], item.id, None, "password", code=403)
    assert lv.reveal(db, p["boss"], item.id, token, "password")["value"] == "NewPw#1"
    assert db.get(LedgerAlipay, c.target_id).alipay_user_id == "2088000000000001"
    # 别的管理员就算挂到自己名下也领不了码：改条目要主人解锁
    _bad(api.vault_update, v.id, api.VaultIn(assignee_id="admin2"), x_vault_token=None, db=db, user=p["admin2"], code=403)


def test_密码库_同一个码不能用两次_连错5次锁住(ctx):
    db, p, lp, ent = ctx
    secret = _bind(db, p["boss"])
    step = int(time.time() // 30) + 1
    lv.unlock(db, p["boss"], lv.totp_at(secret, step), None)
    db.commit()
    _bad(lv.unlock, db, p["boss"], lv.totp_at(secret, step), None)  # 重放
    for _ in range(4):
        _bad(lv.unlock, db, p["boss"], "000000", None)
    assert db.get(LedgerVaultFactor, "boss").locked_until is not None
    _bad(lv.unlock, db, p["boss"], lv.totp_at(secret, step + 1), None, code=429)


def test_密码库没配主密钥_存不了_开店交密码那步不拦(ctx, monkeypatch):
    db, p, lp, ent = ctx
    monkeypatch.setattr(settings, "ledger_vault_kek", "")
    _bad(lv.save, db, p["boss"], {"category": "other", "title": "x", "password": "DEMO_ONLY_REDACTED"}, code=503)
    c = lo.dispatch(db, p["sup"], {"kind": "alipay", "entity_id": ent, "assignee_id": p["emp"].id})
    db.commit()
    for sp in lo.steps_of(db.get(LedgerTutorial, c.tutorial_id)):
        if sp["code"] == "B09":
            break
        r = lo.submit_step(db, p["emp"], c.id, sp["code"], {m["key"]: "已做" for m in sp["materials"]}, True)
        if r.status == "submitted":
            lo.review_step(db, p["sup"], c.id, sp["code"], True, None)
    lo.submit_step(db, p["emp"], c.id, "B09", {"alipay_uid_recorded": "x"}, False)


def test_totp_对得上_rfc6238(ctx):
    # RFC 6238 附录 B 的 SHA1 例子：种子 "12345678901234567890"，T=59 → 94287082（取后 6 位 287082）
    import base64

    secret = base64.b32encode(b"12345678901234567890").decode().rstrip("=")
    assert lv.totp_at(secret, 59 // 30) == "287082"
