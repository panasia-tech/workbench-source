"""采购商品快照 W04：多版本、哈希去重、冻结后不可改。"""
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import OrderStatus, StaffRole, StaffStatus
from app.models import PurchaseItemSnapshot, PurchaseOrder, Staff
from app.services import purchase_snapshot as snap


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Staff.__table__, PurchaseOrder.__table__, PurchaseItemSnapshot.__table__])
    session = sessionmaker(bind=engine, autoflush=True)()
    yield session
    session.close()


@pytest.fixture()
def world(db):
    user = Staff(staff_no="p1", username="p1", name="采购", role=StaffRole.PURCHASER,
                 status=StaffStatus.ACTIVE, password_hash="x")
    db.add(user)
    db.flush()
    order = PurchaseOrder(
        order_no="PO-S1", status=OrderStatus.PENDING_INSPECT, product_name="显示器",
        brand="戴尔", model="U2720Q", unit_price=Decimal("1000"), created_by_id=user.id,
    )
    db.add(order)
    db.commit()
    return type("W", (), {"db": db, "user": user, "order": order})()


def test_versions_hash_dedupe_and_freeze(world):
    db, order, user = world.db, world.order, world.user
    v1 = snap.create_version(
        db, purchase_order_id=order.id, user_id=user.id,
        platform_item_id="item-1", source_url="https://www.goofish.com/item?id=1",
        title="戴尔 U2720Q", listed_price=Decimal("1200"), images=["oss/a.jpg"],
    )
    db.commit()
    assert v1.version == 1 and v1.root_id == v1.id and v1.content_hash

    same = snap.create_version(
        db, purchase_order_id=order.id, user_id=user.id,
        platform_item_id="item-1", source_url="https://www.goofish.com/item?id=1",
        title="戴尔 U2720Q", listed_price=Decimal("1200"), images=["oss/a.jpg"],
    )
    assert same.id == v1.id

    v2 = snap.create_version(
        db, purchase_order_id=order.id, user_id=user.id,
        platform_item_id="item-1", source_url="https://www.goofish.com/item?id=1",
        title="戴尔 U2720Q 降价", listed_price=Decimal("1100"), images=["oss/a.jpg"],
    )
    db.commit()
    assert v2.version == 2 and v2.root_id == v1.id
    assert [r.version for r in snap.list_versions(db, order.id)] == [2, 1]

    snap.freeze_latest(db, order.id)
    db.commit()
    with pytest.raises(HTTPException, match="已冻结"):
        snap.create_version(
            db, purchase_order_id=order.id, user_id=user.id,
            platform_item_id="item-1", title="再改", images=["oss/a.jpg"],
        )
