"""锁货 / 出库 / 报损后联动下架（E05-16）。

红线：开关关着绝不碰群控（只记「本来会下架哪些」）；下架失败不回滚锁货 / 出库，
记 last_error、通知管理员。gc client 全 monkeypatch，不连真群控。
"""
from decimal import Decimal

import pytest

from app.config import settings
from app.enums import AdjustType, ReserveSource, ShopListingStatus, SkuStatus, StaffRole, StaffStatus
from app.models import (
    EventLog,
    InventoryAdjustment,
    PurchaseOrder,
    SaleShop,
    Sku,
    SkuShopListing,
    Staff,
    StockEvent,
    SwitchOrder,
)
from app.services import stock_lock_delist as D
from app.services.app_settings import set_setting
from app.services.gc_bridge import client as gc


@pytest.fixture()
def db(db_session):
    bind = db_session.get_bind()
    for model in (SwitchOrder, InventoryAdjustment, PurchaseOrder):
        model.__table__.create(bind, checkfirst=True)
    return db_session


def _seed(db, *, listed=2, in_delist=0, status=SkuStatus.IN_STOCK):
    admin = Staff(staff_no="A", username="admin", name="管理员", role=StaffRole.ADMIN,
                  status=StaffStatus.ACTIVE, password_hash="x")
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1"), status=status)
    db.add_all([admin, sku])
    db.flush()
    rows = []
    for i in range(listed + in_delist):
        shop = SaleShop(code=f"s{i}", label=f"号{i}", xianyu_user_name=f"号{i}",
                        gc_account_id=f"acc-{i}", enabled=True, sort_order=i)
        db.add(shop)
        db.flush()
        row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_account_id=f"acc-{i}",
                             publish_status=ShopListingStatus.LISTED,
                             gc_job_id="job-old" if i >= listed else None)
        db.add(row)
        rows.append(row)
    db.commit()
    return admin, sku, rows


def _mock_gc(monkeypatch, *, fail=None):
    calls = []

    async def create_delist_job(sku, source="ERP", account_ids=None):
        calls.append((sku, account_ids))
        if fail:
            raise fail
        return {"id": "job-del-1"}

    monkeypatch.setattr(gc, "create_delist_job", create_delist_job)
    monkeypatch.setattr(settings, "gc_publish_enabled", True)
    return calls


def _events(db):
    return [e.payload for e in db.query(EventLog).filter(EventLog.event_type == D.EVENT_TYPE)]


def _sync_submit(db):
    """把「交给线程」换成当场跑，测试里看得到结果。"""
    def submit(sku_id, reason, operator_id):
        D.delist_now(db, db.get(Sku, sku_id), reason=reason, operator_id=operator_id)
    return submit


# ---------------------------------------------------------------- 开关关着

def test_开关关着只记本来会下架哪些不碰群控(db, monkeypatch):
    admin, sku, _ = _seed(db)
    calls = _mock_gc(monkeypatch)
    submitted = []

    D.after_stock_left(db, sku, reason="手动出库", operator_id=admin.id,
                       submit=lambda *a: submitted.append(a))

    assert calls == [] and submitted == []
    ev = _events(db)
    assert len(ev) == 1 and ev[0]["mode"] == "DRY_RUN" and ev[0]["reason"] == "手动出库"
    assert ev[0]["shops"] == ["号0", "号1"]


def test_没有在架的号什么都不做(db, monkeypatch):
    admin, sku, _ = _seed(db, listed=0, in_delist=1)   # 唯一一条已经在下架途中
    set_setting(db, D.ENABLED_KEY, "1", None)
    submitted = []
    D.after_stock_left(db, sku, reason="手动出库", submit=lambda *a: submitted.append(a))
    assert submitted == [] and _events(db) == []


# ---------------------------------------------------------------- 开关开着

def test_开着就全网下架和售出同一口径(db, monkeypatch):
    admin, sku, rows = _seed(db)
    calls = _mock_gc(monkeypatch)
    set_setting(db, D.ENABLED_KEY, "1", None)

    D.after_stock_left(db, sku, reason="换机锁货", operator_id=admin.id, submit=_sync_submit(db))

    assert calls == [("SK1", None)]          # 不带账号 = 群控把所有号上的都下掉
    assert all(r.gc_job_id == "job-del-1" for r in rows)
    assert all(r.publish_status == ShopListingStatus.LISTED for r in rows)  # 等回写确认才转 DELISTED
    ev = _events(db)
    assert ev[-1]["mode"] == "SENT" and ev[-1]["job_id"] == "job-del-1"


def test_下架失败记原因通知管理员(db, monkeypatch):
    admin, sku, rows = _seed(db)
    _mock_gc(monkeypatch, fail=RuntimeError("群控连不上"))
    set_setting(db, D.ENABLED_KEY, "1", None)
    sent = []

    out = D.delist_now(db, sku, reason="手动出库", notifier=lambda staff, title, body: sent.append((staff.id, title, body)))

    assert out == []
    for r in rows:
        assert "手动出库后自动下架没成" in r.last_error and "群控连不上" in r.last_error
        assert r.gc_job_id is None
    assert len(sent) == 1 and sent[0][0] == admin.id and "号0" in sent[0][2]
    assert _events(db)[-1]["mode"] == "FAILED"


def test_群控上架没开也算失败要人去下(db, monkeypatch):
    admin, sku, rows = _seed(db)
    calls = _mock_gc(monkeypatch)
    monkeypatch.setattr(settings, "gc_publish_enabled", False)
    D.delist_now(db, sku, reason="报损", notifier=lambda *a: None)
    assert calls == []
    assert all("GC_PUBLISH_ENABLED" in r.last_error for r in rows)


def test_排队出错也不往外抛(db, monkeypatch):
    admin, sku, _ = _seed(db)
    set_setting(db, D.ENABLED_KEY, "1", None)

    def boom(*a):
        raise RuntimeError("线程池炸了")

    D.after_stock_left(db, sku, reason="手动出库", submit=boom)   # 不抛就算过


# ---------------------------------------------------------------- 入口接上了

def test_换机锁货后联动下架(db, monkeypatch):
    from app.routers import switch_order
    from app.schemas.switch_order import SwitchOrderCreate

    admin, sku, rows = _seed(db)
    calls = _mock_gc(monkeypatch)
    set_setting(db, D.ENABLED_KEY, "1", None)
    monkeypatch.setattr(D, "_submit", _sync_submit(db))

    switch_order.create_order(
        SwitchOrderCreate(sku_code="SK1", unit_price=Decimal("100"), evidence_urls=["https://x/1.jpg"]),
        db=db, user=admin,
    )

    assert sku.status == SkuStatus.RESERVED and sku.reserve_source == ReserveSource.SWITCH
    assert calls == [("SK1", None)]
    assert _events(db)[-1]["reason"] == "换机锁货"


def test_报损失败不回滚报损(db, monkeypatch):
    from app.routers import inventory
    from app.schemas.inventory import AdjustRequest

    admin, sku, rows = _seed(db)
    _mock_gc(monkeypatch, fail=RuntimeError("群控 502"))
    set_setting(db, D.ENABLED_KEY, "1", None)
    monkeypatch.setattr(D, "_submit", _sync_submit(db))
    from app.services import staff_notify
    monkeypatch.setattr(staff_notify, "send", lambda *a, **k: ("SENT", ""))

    inventory.adjust(AdjustRequest(sku_code="SK1", adjust_type=AdjustType.LOSS, reason="摔了"), db=db, user=admin)

    db.expire_all()
    assert db.get(Sku, sku.id).status == SkuStatus.LOSS           # 报损照样算数
    assert db.query(StockEvent).count() == 1
    assert all("报损后自动下架没成" in r.last_error for r in db.query(SkuShopListing))


def test_报溢不触发(db, monkeypatch):
    from app.routers import inventory
    from app.schemas.inventory import AdjustRequest

    admin, sku, _ = _seed(db)
    inventory.adjust(AdjustRequest(sku_code="SK1", adjust_type=AdjustType.OVERFLOW), db=db, user=admin)
    assert _events(db) == []


def test_线程入口自己开会话(db, monkeypatch):
    """_run_in_thread 用 SessionLocal；这里换成测试库，确认真走到 delist_now。"""
    import app.database as database

    admin, sku, rows = _seed(db)
    calls = _mock_gc(monkeypatch)

    class _Ctx:
        def __enter__(self):
            return db

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(database, "SessionLocal", lambda: _Ctx())
    D._run_in_thread(sku.id, "手动出库", admin.id)
    assert calls == [("SK1", None)]
