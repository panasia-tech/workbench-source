"""保存上架信息(PUT /api/listing/skus/{code}):售价必须 > 0(0/负数打回,防脏 spec 到 gc 才被拒)。"""
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.enums import SkuStatus
from app.models import Sku, SkuListingInfo
from app.routers.listing import save_listing
from app.schemas.listing import ListingInfoUpdate


def _sku(db):
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1"), status=SkuStatus.IN_STOCK,
              images=["oss/sku/product/a.jpg"], suggest_price=Decimal("100"))
    db.add(sku)
    db.commit()
    return sku


_USER = SimpleNamespace(id="u1")


def test_save_listing_rejects_zero_and_negative_price(db_session):
    _sku(db_session)
    for bad in (Decimal("0"), Decimal("0.00"), Decimal("-5")):
        with pytest.raises(HTTPException) as ei:
            save_listing("SK1", ListingInfoUpdate(title="t", price=bad), db=db_session, user=_USER)
        assert ei.value.status_code == 400
        assert "售价必须大于 0" in ei.value.detail
    # 被拒后不应留下 READY 状态的上架信息
    assert db_session.query(SkuListingInfo).count() == 0


def test_save_listing_accepts_positive_price(db_session):
    sku = _sku(db_session)
    out = save_listing("SK1", ListingInfoUpdate(title="t", price=Decimal("99.5")),
                       db=db_session, user=_USER)
    info = db_session.query(SkuListingInfo).filter_by(sku_id=sku.id).one()
    assert info.price == Decimal("99.5") and info.status == "READY"
    assert out.price == Decimal("99.5")
