"""员工匹配商品：三种现状判断、提交防呆、改挂确认、报找不到、验收退回、验收后 resolve_spu 让位。"""
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.enums import SkuStatus, StaffRole, StaffStatus
from app.models import ListingApproval, SaleShop, Sku, SkuSpuMatch, SkuSpuMatchLog, Staff, WarehouseSpu
from app.routers import spu_match as R
from app.services import spu_match as sm
from app.services.spu_resolve import MATCH_CONFIRMED, resolve_spu


def _staff(db, name, role):
    row = Staff(staff_no=name, username=name, name=name, role=role, status=StaffStatus.ACTIVE, password_hash="x")
    db.add(row)
    db.flush()
    return row


def _sku(db, code, *, brand=None, model=None, barcode=None):
    sku = Sku(sku_code=code, product_name=f"{brand or ''} {model or ''}", purchase_order_id="po", inspection_id="in",
              cost_price=Decimal("100"), status=SkuStatus.IN_STOCK, brand=brand, model=model, barcode=barcode, images=[])
    db.add(sku)
    db.flush()
    return sku


@pytest.fixture(autouse=True)
def _no_oss(monkeypatch):
    # 签名要 OSS 配置；单测不该依赖本机 .env
    monkeypatch.setattr(R, "sign_oss_url", lambda u, expires=86400: u)
    monkeypatch.setattr("app.services.oss_media.sign_oss_url", lambda u, expires=86400: u)


@pytest.fixture()
def w(db_session):
    db = db_session
    spus = {
        "normal": WarehouseSpu(spu_code="6900000000011", brand="小米", model="Redmi K70"),
        "n50a": WarehouseSpu(spu_code="90000001", brand="盛色", model="N50PRO6", spec="6+128G 国行"),
        "n50b": WarehouseSpu(spu_code="90000002", brand="盛色", model="N50PRO6", spec="8+256G 国行"),
        "nospec1": WarehouseSpu(spu_code="90000011", brand="云鲸", model="J4"),
        "nospec2": WarehouseSpu(spu_code="90000012", brand="云鲸", model="J4"),
        "hw": WarehouseSpu(spu_code="90000021", brand="华为", model="MateBook 14"),
    }
    db.add_all(spus.values())
    clerk = _staff(db, "员工", StaffRole.WAREHOUSE)
    boss = _staff(db, "老板", StaffRole.ADMIN)
    db.commit()

    class W:
        pass

    x = W()
    x.db, x.spu, x.clerk, x.boss = db, spus, clerk, boss
    return x


def test_assess_three_states(w):
    db = w.db
    assert sm.assess(db, _sku(db, "A", barcode="6900000000011")).state == sm.NORMAL
    assert sm.assess(db, _sku(db, "B", brand="小米", model="redmi k70")).state == sm.NORMAL
    a = sm.assess(db, _sku(db, "C", brand="盛色", model="N50PRO6"))
    assert a.state == sm.CONFLICT and len(a.candidates) == 2 and {"spu_code", "spec"} <= a.diff_fields
    # 69码和型号指向不同商品
    assert sm.assess(db, _sku(db, "D", brand="小米", model="Redmi K70", barcode="90000021")).state == sm.CONFLICT
    # 品牌对不上
    assert sm.assess(db, _sku(db, "E", brand="Huawei", model="MateBook 14")).title == "型号对上了，品牌对不上"
    none = sm.assess(db, _sku(db, "F", brand="小米", model="Redmi K7O Pro"))
    assert none.state == sm.NONE
    assert sm.assess(db, _sku(db, "G")).title == "缺少匹配依据"


def test_similar_models_are_only_suggestions(w):
    db = w.db
    sku = _sku(db, "S", brand="华为", model="MateBook-14 2024")
    a = sm.assess(db, sku)
    assert a.state == sm.NONE and a.candidates[0].spu.id == w.spu["hw"].id
    with pytest.raises(HTTPException) as e:
        sm.submit(db, sku, w.spu["hw"].id, note=None, media=[], user_id=w.clerk.id)
    assert "不是系统认出来的候选" in e.value.detail
    sm.submit(db, sku, w.spu["hw"].id, note="铭牌写 MateBook 14 2024 款", media=["oss/p.jpg"], user_id=w.clerk.id)


def test_same_name_multi_config_needs_spec_note_and_photo(w):
    db = w.db
    sku = _sku(db, "C", brand="盛色", model="N50PRO6")
    with pytest.raises(HTTPException) as e:
        sm.submit(db, sku, w.spu["n50b"].id, note="看过了", media=[], user_id=w.clerk.id)
    assert "配置" in e.value.detail
    row = sm.submit(db, sku, w.spu["n50b"].id, note="铭牌 8+256G", media=["oss/plate.jpg"], user_id=w.clerk.id)
    assert row.status == SkuSpuMatch.SUBMITTED
    # 目录里没写配置差异的，谁也不让挑
    sku2 = _sku(db, "J", brand="云鲸", model="J4")
    with pytest.raises(HTTPException) as e:
        sm.submit(db, sku2, w.spu["nospec1"].id, note="随便挑一个", media=["oss/x.jpg"], user_id=w.clerk.id)
    assert "补「配置」" in e.value.detail


def test_barcode_hit_settles_multi_config(w):
    db = w.db
    sku = _sku(db, "K", brand="盛色", model="N50PRO6", barcode="90000002")
    assert sm.assess(db, sku).state == sm.NORMAL
    assert sm.submit(db, sku, w.spu["n50b"].id, note=None, media=[], user_id=w.clerk.id).status == SkuSpuMatch.SUBMITTED


def test_review_return_with_attachment_then_resubmit_then_approve(w):
    db = w.db
    sku = _sku(db, "B", brand="小米", model="Redmi K70")
    R.submit("B", R.SubmitIn(spu_id=w.spu["normal"].id), db, w.clerk)
    with pytest.raises(HTTPException):
        sm.review(db, sku, approve=False, reason="", media=[], user_id=w.boss.id)
    with pytest.raises(HTTPException) as e:
        sm.review(db, sku, approve=True, reason=None, media=[], user_id=w.clerk.id)
    assert "别人" in e.value.detail
    out = R.review("B", R.ReviewIn(approve=False, reason="颜色看不清，补拍铭牌", media=["oss/mark.png"]), db, w.boss)
    assert out["match"]["status"] == SkuSpuMatch.RETURNED
    assert out["match"]["return_reason"] == "颜色看不清，补拍铭牌" and [m["raw"] for m in out["match"]["return_media"]] == ["oss/mark.png"]
    R.submit("B", R.SubmitIn(spu_id=w.spu["normal"].id, note="补拍了", media=["oss/plate.jpg"]), db, w.clerk)
    out = R.review("B", R.ReviewIn(approve=True), db, w.boss)
    assert out["match"]["status"] == SkuSpuMatch.CONFIRMED
    assert [lg["action"] for lg in out["logs"]] == ["APPROVE", "SUBMIT", "RETURN", "SUBMIT"]
    m = resolve_spu(db, sku)
    assert m.how == MATCH_CONFIRMED and m.spu.id == w.spu["normal"].id


def test_change_confirmed_match_needs_confirm_and_stales_prices(w):
    db = w.db
    sku = _sku(db, "C", brand="盛色", model="N50PRO6")
    sm.submit(db, sku, w.spu["n50a"].id, note="铭牌 6+128G", media=["oss/p.jpg"], user_id=w.clerk.id)
    sm.review(db, sku, approve=True, reason=None, media=[], user_id=w.boss.id)
    shop = SaleShop(code="s1", label="店1", xianyu_user_name="甲", enabled=True, sort_order=0)
    db.add(shop)
    db.flush()
    db.add(ListingApproval(sku_id=sku.id, sale_shop_id=shop.id, status="APPROVED", images=[]))
    db.commit()
    with pytest.raises(HTTPException) as e:
        sm.submit(db, sku, w.spu["n50b"].id, note="其实是 8+256G", media=["oss/p2.jpg"], user_id=w.clerk.id)
    assert e.value.status_code == 409
    imp = e.value.detail["impact"]
    assert imp["price_approvals"] == 1 and "6+128G" in imp["current_spu"]
    sm.submit(db, sku, w.spu["n50b"].id, note="其实是 8+256G", media=["oss/p2.jpg"], user_id=w.clerk.id, confirm_change=True)
    db.commit()
    assert db.query(ListingApproval).one().status == "STALE"
    log = db.query(SkuSpuMatchLog).filter(SkuSpuMatchLog.action == "CHANGE").one()
    assert log.from_spu_id == w.spu["n50a"].id and log.to_spu_id == w.spu["n50b"].id and log.staff_id == w.clerk.id


def test_report_none_requires_detail(w):
    db = w.db
    sku = _sku(db, "F", brand="小米", model="不存在的型号")
    with pytest.raises(HTTPException):
        sm.report_none(db, sku, note="", media=[], user_id=w.clerk.id)
    row = sm.report_none(db, sku, note="铭牌：小米 XYZ-1 白色", media=["oss/n.jpg"], user_id=w.clerk.id)
    assert row.status == SkuSpuMatch.NO_MATCH and row.spu_id is None
    sm.review(db, sku, approve=True, reason=None, media=[], user_id=w.boss.id)
    assert resolve_spu(db, sku).spu is None


def test_list_tabs(w):
    db = w.db
    _sku(db, "A", barcode="6900000000011")
    b = _sku(db, "B", brand="小米", model="Redmi K70")
    sm.submit(db, b, w.spu["normal"].id, note=None, media=[], user_id=w.clerk.id)
    db.commit()
    todo = R.list_items("todo", "", 1, 20, db, w.clerk)
    assert [i["sku_code"] for i in todo["items"]] == ["A"] and todo["items"][0]["state"] == sm.NORMAL
    waiting = R.list_items("waiting", "", 1, 20, db, w.clerk)
    assert waiting["items"][0]["spu"] == "小米 Redmi K70"


def test_short_model_only_suggests_same_brand(w):
    db = w.db
    db.add(WarehouseSpu(spu_code="90000501", brand="泰坦军团", model="P25M2S"))
    db.commit()
    sku = _sku(db, "T", brand="小米", model="m2")
    assert all(c.spu.brand == "小米" for c in sm.assess(db, sku).candidates)
