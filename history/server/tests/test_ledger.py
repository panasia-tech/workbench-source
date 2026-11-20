"""大台账。

红线：
  1. 业务员只能填，不能列、不能查；填报回什么都一样，不泄露台账里有没有这个人；
  2. 临时开放：只有被开放的人能打开，第一次打开后 READ_MINUTES 分钟内能看，过了、收回了、过期了都打不开；
  3. 下面还挂着东西的删不了；
  4. 看、改、开放、打开都留记录。
"""

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import LedgerAccessLog, LedgerAlipay, LedgerEntity, LedgerGrant, LedgerLegalPerson, LedgerShop, SaleShop, Staff
from app.routers import ledger as api
from app.services import ledger as lg


def _staff(db, sid, role):
    s = Staff(id=sid, staff_no=sid, username=sid, password_hash="x", name=sid, role=role, status=StaffStatus.ACTIVE)
    db.add(s)
    db.flush()
    return s


@pytest.fixture()
def ctx(db_session):
    admin = _staff(db_session, "admin", StaffRole.ADMIN)
    sales = _staff(db_session, "sales", StaffRole.SALES)
    other = _staff(db_session, "other", StaffRole.WAREHOUSE)
    db_session.commit()
    return db_session, admin, sales, other


FULL = dict(
    legal_person_name="张三", legal_person_phone="00030902120", entity_name="张三五金店", entity_type="individual",
    credit_code="92330100MA0000000X", alipay_account="zs@example.com", shop_platform="xianyu", shop_name="张三的闲鱼",
)


def _submit(db, staff, **kw):
    return api.submit(api.SubmitIn(**{**FULL, **kw}), db=db, user=staff)


def test_业务员填一整条_都标要核对(ctx):
    db, _, sales, _ = ctx
    assert _submit(db, sales) == {"ok": True}
    lp = db.query(LedgerLegalPerson).one()
    ent = db.query(LedgerEntity).one()
    ali = db.query(LedgerAlipay).one()
    shop = db.query(LedgerShop).one()
    assert (ent.legal_person_id, ali.entity_id, shop.alipay_id) == (lp.id, ent.id, ali.id)
    assert all(x.needs_check for x in (lp, ent, ali, shop))
    assert db.query(LedgerAccessLog).filter_by(action="submit", staff_id="sales").count() == 1


def test_同一法人再填一家店_挂到已有的上面(ctx):
    db, _, sales, _ = ctx
    _submit(db, sales)
    _submit(db, sales, shop_name="张三的第二家店")
    assert db.query(LedgerLegalPerson).count() == 1 and db.query(LedgerAlipay).count() == 1
    assert db.query(LedgerShop).count() == 2


def test_只有姓名对不上手机号_新建一个等管理员合并(ctx):
    db, admin, sales, _ = ctx
    _submit(db, sales)
    _submit(db, sales, legal_person_phone=None, shop_name="另一家")
    assert db.query(LedgerLegalPerson).count() == 2
    a, b = db.query(LedgerLegalPerson).order_by(LedgerLegalPerson.created_at, LedgerLegalPerson.phone.desc()).all()
    keep, dup = (a, b) if a.phone else (b, a)
    api.merge(dup.id, api.MergeIn(into_id=keep.id), db=db, user=admin)
    assert db.query(LedgerLegalPerson).count() == 1
    assert db.query(LedgerEntity).filter_by(legal_person_id=keep.id).count() == 2


def test_填了店铺不填支付宝不行(ctx):
    db, _, sales, _ = ctx
    with pytest.raises(HTTPException):
        _submit(db, sales, alipay_account=None)


def test_业务员过不了管理员的门(ctx):
    db, _, sales, _ = ctx
    with pytest.raises(HTTPException) as e:
        api._admin(user=sales)
    assert e.value.status_code == 403


def test_四层一起搜(ctx):
    db, admin, sales, _ = ctx
    _submit(db, sales)
    for kw in ("张三", "1380000", "五金", "92330100", "zs@example", "闲鱼"):
        res = api.list_legal_persons(q=kw, needs_check=None, page=1, size=30, db=db, _=admin)
        assert res["total"] == 1, kw
    assert api.list_legal_persons(q="李四", needs_check=None, page=1, size=30, db=db, _=admin)["total"] == 0
    item = api.list_legal_persons(q=None, needs_check=True, page=1, size=30, db=db, _=admin)["items"][0]
    assert item["needs_check"] and (item["entities"], item["alipays"], item["shops"]) == (1, 1, 1)


def test_管理员看详情留记录_核对完清标记(ctx):
    db, admin, sales, _ = ctx
    _submit(db, sales)
    lp = db.query(LedgerLegalPerson).one()
    tree = api.read_legal_person(lp.id, db=db, user=admin)
    assert tree["entities"][0]["alipays"][0]["shops"][0]["name"] == "张三的闲鱼"
    assert db.query(LedgerAccessLog).filter_by(action="view", staff_id="admin").count() == 1
    api.checked(lp.id, db=db, user=admin)
    assert api.list_legal_persons(q=None, needs_check=True, page=1, size=30, db=db, _=admin)["total"] == 0


def test_下面还挂着东西的删不了(ctx):
    db, admin, sales, _ = ctx
    _submit(db, sales)
    lp = db.query(LedgerLegalPerson).one()
    with pytest.raises(HTTPException):
        api.delete_row("legal_person", lp.id, db=db, user=admin)
    shop = db.query(LedgerShop).one()
    api.delete_row("shop", shop.id, db=db, user=admin)
    assert db.query(LedgerShop).count() == 0


def test_管理员新建挂到上一层_挂错层级的拦下(ctx):
    db, admin, _, _ = ctx
    lp = api.create_row("legal_person", api.RowIn(name="李四"), db=db, user=admin)
    ent = api.create_row("entity", api.RowIn(legal_person_id=lp["id"], name="李四公司", entity_type="company"), db=db, user=admin)
    with pytest.raises(HTTPException):
        api.create_row("alipay", api.RowIn(entity_id="不存在", account="x"), db=db, user=admin)
    db.add(SaleShop(id="ss1", code="S1", label="海胆", xianyu_user_name="n"))
    ali = api.create_row("alipay", api.RowIn(entity_id=ent["id"], account="166ed60d80@example.invalid"), db=db, user=admin)
    api.create_row("shop", api.RowIn(alipay_id=ali["id"], name="海胆", sale_shop_id="ss1"), db=db, user=admin)
    tree = api.read_legal_person(lp["id"], db=db, user=admin)
    assert tree["entities"][0]["alipays"][0]["shops"][0]["sale_shop_label"] == "海胆"
    assert not tree["needs_check"], "管理员自己建的不用核对"


def _grant(db, admin, staff, lp, **kw):
    return api.create_grant(api.GrantIn(staff_id=staff.id, legal_person_id=lp.id, **kw), db=db, user=admin)


def test_临时开放_打开后看一会儿_过了就看不到(ctx):
    db, admin, sales, _ = ctx
    _submit(db, sales)
    lp = db.query(LedgerLegalPerson).one()
    g = _grant(db, admin, sales, lp, reason="核对张三的店铺")
    mine = api.my_grants(db=db, user=sales)["items"]
    assert [x["reason"] for x in mine] == ["核对张三的店铺"] and "legal_person_name" not in mine[0], "打开前看不到是谁"

    res = api.open_grant(g["id"], db=db, user=sales)
    assert res["legal_person"]["name"] == "张三"
    api.open_grant(g["id"], db=db, user=sales)  # 时间窗里再开一次可以（手机刷新）

    row = db.get(LedgerGrant, g["id"])
    row.read_until = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    with pytest.raises(HTTPException) as e:
        api.open_grant(g["id"], db=db, user=sales)
    assert e.value.status_code == 410
    assert api.my_grants(db=db, user=sales)["items"] == [], "看完就从列表里消失"
    actions = {a for (a,) in db.query(LedgerAccessLog.action).filter_by(staff_id="sales").all()}
    assert {"open", "view"} <= actions


def test_别人打不开_收回和过期的打不开(ctx):
    db, admin, sales, other = ctx
    _submit(db, sales)
    lp = db.query(LedgerLegalPerson).one()
    g = _grant(db, admin, sales, lp)
    with pytest.raises(HTTPException) as e:
        api.open_grant(g["id"], db=db, user=other)
    assert e.value.status_code == 404

    api.revoke_grant(g["id"], db=db, user=admin)
    with pytest.raises(HTTPException) as e:
        api.open_grant(g["id"], db=db, user=sales)
    assert e.value.status_code == 410

    g2 = _grant(db, admin, sales, lp, hours=1)
    db.get(LedgerGrant, g2["id"]).expires_at = datetime.utcnow() - timedelta(minutes=1)
    db.commit()
    with pytest.raises(HTTPException) as e:
        api.open_grant(g2["id"], db=db, user=sales)
    assert e.value.status_code == 410


def test_开放记录给管理员看状态(ctx):
    db, admin, sales, _ = ctx
    _submit(db, sales)
    lp = db.query(LedgerLegalPerson).one()
    g = _grant(db, admin, sales, lp)
    assert g["state"] == "waiting" and g["staff_name"] == "sales" and g["legal_person_name"] == "张三"
    api.open_grant(g["id"], db=db, user=sales)
    items = api.list_grants(legal_person_id=lp.id, db=db, _=admin)["items"]
    assert items[0]["state"] == "reading"
    logs = api.logs(target_id=None, page=1, size=50, db=db, _=admin)
    assert logs["total"] >= 4 and any(x["action"] == "开放" for x in logs["items"])
