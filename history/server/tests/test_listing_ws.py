"""上下架状态 WS 推送(/ws/sku-shops/{sku_code})+ 共用快照 build_shops_payload。

TestClient 跑真实 WS 握手;SessionLocal monkeypatch 成内存 SQLite(与 db_session 同 engine)。
"""
import asyncio
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app.routers.listing_ws as W
from app.deps import create_access_token
from app.enums import ShopListingStatus, SkuStatus, StaffRole, StaffStatus
from app.main import app
from app.models import SaleShop, Sku, SkuShopListing, Staff
from app.services.listing_shops import build_shops_payload


def _seed(db, *, with_pending_job=False):
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1"), status=SkuStatus.IN_STOCK, images=[], suggest_price=None)
    shop = SaleShop(code="s1", label="店1", xianyu_user_name="闲鱼A", enabled=True, sort_order=0)
    off = SaleShop(code="s2", label="停用店", xianyu_user_name="闲鱼B", enabled=False, sort_order=1)
    db.add_all([sku, shop, off])
    db.flush()
    if with_pending_job:
        db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id,
                              publish_status=ShopListingStatus.LISTING,
                              gc_job_id="job-1", gc_account_id="acc-a"))
    db.commit()
    return sku, shop


def _seed_staff(db, *, status=StaffStatus.ACTIVE):
    staff = Staff(staff_no="001", username="admin", password_hash="x", name="管理员",
                  role=StaffRole.ADMIN, status=status)
    db.add(staff)
    db.commit()
    return staff


def test_build_shops_payload_marks_gc_pending(db_session):
    sku, shop = _seed(db_session, with_pending_job=True)
    rows = asyncio.run(build_shops_payload(db_session, sku))
    assert len(rows) == 1  # 停用店铺不出现
    r = rows[0]
    assert r.shop_code == "s1"
    assert r.publish_status == ShopListingStatus.LISTING
    assert r.gc_pending is True


def test_build_shops_payload_default_pending(db_session):
    sku, _ = _seed(db_session)
    rows = asyncio.run(build_shops_payload(db_session, sku))
    assert rows[0].publish_status == ShopListingStatus.PENDING
    assert rows[0].gc_pending is False


def test_staff_ok(db_session, monkeypatch):
    monkeypatch.setattr(W, "SessionLocal", lambda: db_session)
    staff = _seed_staff(db_session)
    token = create_access_token(staff.id, staff.role)
    assert W._staff_ok(token) is True
    assert W._staff_ok("bad-token") is False
    assert W._staff_ok("") is False


def test_staff_ok_rejects_inactive(db_session, monkeypatch):
    monkeypatch.setattr(W, "SessionLocal", lambda: db_session)
    staff = _seed_staff(db_session, status=StaffStatus.PENDING)
    token = create_access_token(staff.id, staff.role)
    assert W._staff_ok(token) is False


def test_ws_pushes_snapshot_and_settles(db_session, monkeypatch):
    """无在途作业:首帧即 settled,服务端随后正常关闭。"""
    monkeypatch.setattr(W, "SessionLocal", lambda: db_session)
    sku, _ = _seed(db_session)
    staff = _seed_staff(db_session)
    token = create_access_token(staff.id, staff.role)

    client = TestClient(app)
    with client.websocket_connect(f"/ws/sku-shops/SK1?token={token}") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "shops"
        assert msg["settled"] is True
        assert [s["shop_code"] for s in msg["shops"]] == ["s1"]


def test_ws_rejects_bad_token(db_session, monkeypatch):
    monkeypatch.setattr(W, "SessionLocal", lambda: db_session)
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect("/ws/sku-shops/SK1?token=bad"):
            pass
    assert ei.value.code == 4401
