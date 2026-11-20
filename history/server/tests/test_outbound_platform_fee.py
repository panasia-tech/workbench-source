"""出库记闲鱼实际服务费：填了按实际的算（经营账单、导出、对账），没填才按档估；出库人自己和管理员能补填。

无忧卖按类目和售出时长收 1%～17.5%，固定 2.6% 估不准，所以要记实际的。
"""

from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import SalesOutbound, Sku, Staff
from app.routers import inventory, sales
from app.schemas.sales import OutboundFeeIn
from app.services.commission import platform_fee


def _staff(db, sid, role):
    s = Staff(id=sid, staff_no=sid, username=sid, password_hash="x", name=sid, role=role, status=StaffStatus.ACTIVE)
    db.add(s)
    return s


def _ob(db, no, price, kind="MANUAL", fee=None, worry_free=False, operator="wh1"):
    sku = Sku(sku_code=f"SKU{no}", product_name=f"货{no}", purchase_order_id="po", inspection_id="insp",
              cost_price=Decimal("1"), status="SHIPPED")
    db.add(sku); db.flush()
    o = SalesOutbound(outbound_no=no, sku_id=sku.id, outbound_type=kind, sale_price=Decimal(price), cost_price=Decimal("1"),
                      worry_free=worry_free, platform_fee=fee, operator_id=operator, created_at=datetime.utcnow())
    db.add(o); db.flush()
    return o


def test_有实际服务费就用实际的_没有才按档估(db_session):
    db = db_session
    assert platform_fee(_ob(db, "A", "2010", fee=Decimal("132.66"))) == (Decimal("132.66"), "实际")
    assert platform_fee(_ob(db, "B", "1000")) == (Decimal("16.00"), "估·普通(1.6%)")
    assert platform_fee(_ob(db, "C", "1000", worry_free=None)) == (Decimal("26.00"), "估·无忧(2.6%)")
    assert platform_fee(_ob(db, "D", "500", kind="PICKUP", fee=Decimal("9"))) == (Decimal("0"), "自提(0%)")


def test_出库时填的服务费_自提不记_比售价多拦下():
    req = SimpleNamespace(platform_fee=Decimal("12.5"), sale_price=Decimal("800"))
    assert inventory._checked_fee(req, "MANUAL") == Decimal("12.5")
    assert inventory._checked_fee(req, "PICKUP") is None
    assert inventory._checked_fee(SimpleNamespace(platform_fee=None, sale_price=Decimal("1")), "SWITCH") is None
    with pytest.raises(HTTPException) as e:
        inventory._checked_fee(SimpleNamespace(platform_fee=Decimal("900"), sale_price=Decimal("800")), "MANUAL")
    assert e.value.status_code == 400


def test_补填服务费_出库人和管理员能改_别人和自提不行(db_session):
    db = db_session
    wh1, wh2, admin, seller = (_staff(db, "wh1", StaffRole.WAREHOUSE), _staff(db, "wh2", StaffRole.WAREHOUSE),
                               _staff(db, "adm", StaffRole.ADMIN), _staff(db, "s1", StaffRole.SALES))
    ob = _ob(db, "E", "600")
    pick = _ob(db, "F", "300", kind="PICKUP")
    db.commit()

    out = sales.set_outbound_fee(ob.id, OutboundFeeIn(platform_fee=Decimal("38.4")), db=db, user=wh1)
    assert out.platform_fee == Decimal("38.4") and db.get(SalesOutbound, ob.id).platform_fee == Decimal("38.40")
    for who in (wh2, seller):
        with pytest.raises(HTTPException) as e:
            sales.set_outbound_fee(ob.id, OutboundFeeIn(platform_fee=Decimal("1")), db=db, user=who)
        assert e.value.status_code == 403
    with pytest.raises(HTTPException):
        sales.set_outbound_fee(pick.id, OutboundFeeIn(platform_fee=Decimal("1")), db=db, user=admin)
    with pytest.raises(HTTPException) as e:
        sales.set_outbound_fee(ob.id, OutboundFeeIn(platform_fee=Decimal("601")), db=db, user=admin)
    assert e.value.status_code == 400
    sales.set_outbound_fee(ob.id, OutboundFeeIn(platform_fee=None), db=db, user=admin)
    assert db.get(SalesOutbound, ob.id).platform_fee is None, "清空 = 回到按档估"
    assert sales._fee_editable(wh1, ob) and not sales._fee_editable(wh2, ob) and sales._fee_editable(admin, ob)
