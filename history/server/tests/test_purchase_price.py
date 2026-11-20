"""采购工作台 W06：内部采购价格表（禅道 #53 的验收用例）。"""
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import OrderStatus, StaffRole, StaffStatus
from app.models import PurchaseOrder, PurchasePriceRule, Staff
from app.routers import purchase_price as api
from app.services import purchase_price as price


@pytest.fixture()
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Staff.__table__, PurchasePriceRule.__table__, PurchaseOrder.__table__])
    db = sessionmaker(bind=engine, autoflush=True)()
    adm = Staff(id="adm", staff_no="a", username="a", name="管理员", role=StaffRole.ADMIN, status=StaffStatus.ACTIVE, password_hash="x")
    buyer = Staff(id="p1", staff_no="p1", username="p1", name="小吕", role=StaffRole.PURCHASER, status=StaffStatus.ACTIVE, password_hash="x")
    db.add_all([adm, buyer])
    db.commit()
    yield db, adm, buyer
    db.close()


def _save(db, adm, **kw):
    out = api.save(api.RuleIn(**{"brand": "苹果", "model": "iPhone 13", **kw}), db=db, user=adm)
    return out


def test_三栏分开_空着是待定_顺序不对拦下(ctx):
    db, adm, _ = ctx
    r = _save(db, adm, spec="128G", first_offer="1500")
    assert r["pending"] == ["目标", "最高"] and r["first_offer"] == "1500.00"
    q = price.quote(db, brand="苹果", model="iphone13", spec="128g")
    assert q["status"] == "pending" and "目标、最高还没定" in q["reason"], "大小写和空格不影响对上"
    with pytest.raises(HTTPException, match="首报不能比目标高"):
        _save(db, adm, spec="256G", first_offer="2000", target="1800")
    with pytest.raises(HTTPException, match="大于 0"):
        _save(db, adm, spec="256G", ceiling="0")


def test_单机和全套不混价_规格配件不明确就待核(ctx):
    db, adm, _ = ctx
    _save(db, adm, spec="128G", accessory="unit", first_offer="1500", target="1700", ceiling="1800")
    _save(db, adm, spec="128G", accessory="full", first_offer="1650", target="1850", ceiling="1950")
    _save(db, adm, spec="256G", accessory="unit", first_offer="1800", target="2000", ceiling="2100")
    assert price.quote(db, brand="苹果", model="iPhone 13")["status"] == "review", "规格没填、有两种规格"
    q = price.quote(db, brand="苹果", model="iPhone 13", spec="128G")
    assert q["status"] == "review" and "单机和全套" in q["reason"]
    q = price.quote(db, brand="苹果", model="iPhone 13", spec="128G", accessory="full")
    assert q["status"] == "ok" and q["rule"]["ceiling"] == "1950.00"
    assert price.quote(db, brand="苹果", model="iPhone 13", spec="512G")["status"] == "none"
    assert price.quote(db, brand="华为", model="Mate 60")["status"] == "none"
    q = price.quote(db, brand="苹果", model="iPhone 13", spec="256G", declared_model="iPhone 12")
    assert q["status"] == "review" and "对不上" in q["reason"], "卖家写的型号和填的对不上不给价"


def test_改价加新版旧版留着_采购单锁下单时那一版(ctx):
    db, adm, buyer = ctx
    v1 = _save(db, adm, spec="128G", first_offer="1500", target="1700", ceiling="1800")
    po = PurchaseOrder(order_no="PO1", status=OrderStatus.PENDING_INSPECT, product_name="苹果 iPhone 13", brand="苹果",
                       model="iPhone 13", spec="128G", unit_price=Decimal("1650"), created_by_id="p1")
    db.add(po)
    db.flush()
    price.lock_for_order(db, po, None)
    db.commit()
    assert po.price_rule_id == v1["id"]
    with pytest.raises(HTTPException, match="没变"):
        _save(db, adm, spec="128G", first_offer="1500", target="1700", ceiling="1800")
    v2 = _save(db, adm, spec="128G", first_offer="1400", target="1600", ceiling="1700", source="11-16 行情下跌")
    assert v2["version"] == 2
    got = api.for_order(po.id, db=db, user=buyer)
    assert got["locked"]["ceiling"] == "1800.00" and got["current"]["ceiling"] == "1700.00" and got["changed"]
    assert [h["version"] for h in api.history(v2["id"], db=db, _=buyer)["items"]] == [2, 1]
    # 锁的时候指定了已经被替掉的版本：不让锁
    po2 = PurchaseOrder(order_no="PO2", status=OrderStatus.PENDING_INSPECT, product_name="x", unit_price=Decimal("1"), created_by_id="p1")
    db.add(po2)
    db.flush()
    with pytest.raises(HTTPException, match="不是现在生效"):
        price.lock_for_order(db, po2, v1["id"])
    # 停用：查不到，历史还在
    api.retire(v2["id"], db=db, _=adm)
    assert price.quote(db, brand="苹果", model="iPhone 13", spec="128G")["status"] == "none"
    assert api.for_order(po.id, db=db, user=buyer)["locked"]["version"] == 1
