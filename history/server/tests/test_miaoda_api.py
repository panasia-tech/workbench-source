"""员工工作台服务端调 ERP 只读计数（/api/miaoda/overview）。

# 这里钉死的

  1. 只认 MIAODA_API_KEY：没配回 503、不对回 401；
  2. 这把 key 不能当员工登录令牌用（ERP 别的接口照常要登录）；
  3. 全公司口径、只算今天、资产录入的占位单不算采购和验货，和管理员仪表盘一致。
"""

from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.deps import get_current_user
from app.enums import InspectionStatus, SkuStatus, StaffRole, StaffStatus
from app.models import Inspection, PurchaseOrder, SalesOutbound, Sku, Staff
from app.routers.miaoda import overview, require_miaoda_key
from app.services.finance import cn_today_start_utc

_TABLES = [Staff.__table__, PurchaseOrder.__table__, Inspection.__table__, Sku.__table__, SalesOutbound.__table__]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=_TABLES)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield session
    session.close()


def _bearer(token):
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def test_没配key回503(monkeypatch):
    monkeypatch.setattr(settings, "miaoda_api_key", "")
    with pytest.raises(HTTPException) as e:
        require_miaoda_key(_bearer("anything"))
    assert e.value.status_code == 503


@pytest.mark.parametrize("given", [None, "wrong", "k-test-extra"])
def test_key不对回401(monkeypatch, given):
    monkeypatch.setattr(settings, "miaoda_api_key", "k-test")
    with pytest.raises(HTTPException) as e:
        require_miaoda_key(_bearer(given) if given else None)
    assert e.value.status_code == 401


def test_key对了放行(monkeypatch):
    monkeypatch.setattr(settings, "miaoda_api_key", "k-test")
    assert require_miaoda_key(_bearer("k-test")) is None


def test_key不能当员工登录令牌(db, monkeypatch):
    monkeypatch.setattr(settings, "miaoda_api_key", "k-test")
    with pytest.raises(HTTPException) as e:
        get_current_user(_bearer("k-test"), db)
    assert e.value.status_code == 401


def test_计数是全公司今天的且不算资产录入(db):
    today = cn_today_start_utc() + timedelta(seconds=1)
    yesterday = cn_today_start_utc() - timedelta(hours=1)
    staff = Staff(staff_no="S1", username="u1", password_hash="x", role=StaffRole.PURCHASER,
                  status=StaffStatus.ACTIVE)
    db.add(staff)
    db.flush()

    def po(no, at):
        p = PurchaseOrder(order_no=no, status="PENDING_INSPECT", product_name="手机", unit_price=Decimal("100"),
                          created_by_id=staff.id, created_at=at)
        db.add(p)
        db.flush()
        return p

    def inspection(no, p, status, inspected_at=None):
        i = Inspection(inspect_no=no, purchase_order_id=p.id, status=status, inspected_at=inspected_at)
        db.add(i)
        db.flush()
        return i

    def sku(code, p, i, status, inbound_at):
        s = Sku(sku_code=code, purchase_order_id=p.id, inspection_id=i.id, product_name="手机",
                cost_price=Decimal("100"), status=status, inbound_at=inbound_at)
        db.add(s)
        db.flush()
        return s

    po_today = po("PO001", today)
    po_asset = po("POAST001", today)  # 资产录入的占位单：不算采购
    po_old = po("PO000", yesterday)
    i_pending = inspection("IN001", po_today, InspectionStatus.PENDING)
    i_done = inspection("IN000", po_old, InspectionStatus.DONE, today)
    i_asset = inspection("INAST001", po_asset, InspectionStatus.DONE, today)  # 不算验货
    s1 = sku("SKU1", po_today, i_pending, SkuStatus.IN_STOCK, today)
    sku("SKU2", po_old, i_done, SkuStatus.IN_STOCK, yesterday)
    s3 = sku("SKU3", po_asset, i_asset, SkuStatus.RESERVED, today)  # 资产录入的货照算入库
    for no, s, at in (("OUT1", s1, today), ("OUT0", s3, yesterday)):
        db.add(SalesOutbound(outbound_no=no, sku_id=s.id, outbound_type="SALE", sale_price=Decimal("200"),
                             cost_price=Decimal("100"), operator_id=staff.id, created_at=at))
    db.commit()

    res = overview(db)
    assert (res.today_purchase, res.pending_inspect, res.today_inspected) == (1, 1, 1)
    assert (res.today_inbound, res.today_outbound) == (2, 1)
    assert (res.in_stock, res.reserved) == (2, 1)
    assert res.generated_at
