"""资产录入：所有员工把别的系统里的电脑、显示器录成在库商品，录完进待上架。

这里钉死的口径（用户 2026-10-17 定）：
  1. 所有员工账号都能录，设备账号不能；库位选填。
  2. 录完进待上架：不自动发布，也不进自动上架流水线（流水线会把员工填的售价改成行情价）。
  3. 录入人不拿提成：录入的货不进采购记录、今日采购、财务采购支出、采购提成、验货计件、OA 推送。
  4. 手动入库抽成共用函数后，行为一点没变。
"""

from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.enums import ListingInfoStatus, ReserveSource, ShopListingStatus, SkuStatus, StaffRole, StaffStatus
from app.models import (
    AssetIntake,
    Inspection,
    PurchaseOrder,
    ReturnOrder,
    SalesOutbound,
    Sku,
    SkuAutoListing,
    SkuListingInfo,
    SkuShopListing,
    Staff,
    StockEvent,
)
from app.routers import asset_intake as router
from app.schemas.asset_intake import AssetIntakeIn

_TABLES = [
    m.__table__
    for m in (
        Staff, Sku, SkuListingInfo, SkuShopListing, StockEvent, PurchaseOrder, Inspection,
        AssetIntake, SkuAutoListing, SalesOutbound, ReturnOrder,
    )
]


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=_TABLES)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    # 签名会拿 .env 里的 OSS 密钥算 URL；测试只关心存了什么，原样返回
    monkeypatch.setattr(router, "sign_media_payload", lambda obj, *a, **k: obj)
    try:
        yield session
    finally:
        session.close()


def _staff(db, role, sid):
    s = Staff(id=sid, staff_no=sid[:16], username=sid, password_hash="x", name=f"{sid}名",
              role=role, status=StaffStatus.ACTIVE)
    db.add(s)
    db.commit()
    return s


def _body(**over) -> AssetIntakeIn:
    data = {
        "product_type": "显示器",
        "brand": "戴尔",
        "model": "U2720Q",
        "spec": "27寸 4K",
        "serial_number": "CN-0ABC-123",
        "condition_grade": "9新",
        "price": Decimal("1299"),
        "express_fee": Decimal("15"),
        "images": ["https://img.example.com/a.jpg", "https://img.example.com/b.jpg"],
        "desc": "右下角一处轻微划痕，带原装线",
        "cost_price": Decimal("300"),
        "source_asset_no": "ZC-0001",
        "remark": "三楼会议室退下来的",
    }
    data.update(over)
    return AssetIntakeIn(**data)


def _create(db, user, **over):
    return router.create_intake(_body(**over), db=db, user=user)


def _sku(db, code) -> Sku:
    return db.query(Sku).filter(Sku.sku_code == code).one()


# --- 1. 录入：直接在库、免议价、上架信息已填好 -------------------------------------
def test_录入直接生成在库商品_上架信息已就绪(db, monkeypatch):
    # 自动上架开着也不进流水线：流水线会把员工填的售价改成行情价
    monkeypatch.setattr(settings, "auto_listing_enabled", True)
    user = _staff(db, StaffRole.PURCHASER, "p1")

    res = _create(db, user)

    sku = _sku(db, res.sku_code)
    assert sku.status == SkuStatus.IN_STOCK and sku.negotiated_at is not None
    assert sku.tags == ["ASSET_INTAKE"]
    assert sku.product_name == "戴尔 U2720Q" and sku.product_type == "显示器"
    assert sku.cost_price == Decimal("300") and sku.suggest_price == Decimal("300")
    assert sku.location_code is None, "库位选填：不知道就留空，仓管之后补"
    assert sku.cover_url == "https://img.example.com/a.jpg"
    assert sku.short_code, "进上架流程就分配短编码"

    info = db.query(SkuListingInfo).filter_by(sku_id=sku.id).one()
    assert info.status == ListingInfoStatus.READY
    assert info.price == Decimal("1299") and info.express_fee == Decimal("15")
    assert info.images == sku.images and info.desc.startswith("右下角")

    po = db.get(PurchaseOrder, sku.purchase_order_id)
    assert po.order_no.startswith("POAST") and po.created_by_id == user.id
    assert po.remark == "资产录入：三楼会议室退下来的"
    insp = db.get(Inspection, sku.inspection_id)
    assert insp.inspect_no.startswith("INAST")
    assert insp.inspector_id is None, "录入不是验货，不算任何人的验货计件"

    row = db.query(AssetIntake).one()
    assert (row.sku_id, row.entered_by_id, row.source_asset_no) == (sku.id, user.id, "ZC-0001")
    event = db.query(StockEvent).filter_by(sku_id=sku.id).one()
    assert event.payload == {"source": "ASSET_INTAKE", "source_asset_no": "ZC-0001"}

    assert db.query(SkuAutoListing).count() == 0
    assert db.query(SkuShopListing).count() == 0, "录入本身不发布"
    assert res.can_publish is False


def test_有上架权限的人录完直接给去上架(db):
    for role, sid in ((StaffRole.WAREHOUSE, "w1"), (StaffRole.SALES, "s1"), (StaffRole.ADMIN, "a1")):
        user = _staff(db, role, sid)
        assert _create(db, user, serial_number=f"SN-{sid}", source_asset_no=None).can_publish is True


@pytest.mark.parametrize(
    "over, msg",
    [
        ({"brand": " "}, "品牌和型号"),
        ({"model": ""}, "品牌和型号"),
        ({"product_type": ""}, "商品类型"),
        ({"serial_number": "  "}, "序列号"),
        ({"condition_grade": ""}, "成色"),
        ({"price": Decimal("0")}, "售价必须大于 0"),
        ({"images": []}, "至少传 1 张"),
    ],
)
def test_必填项缺了打回(db, over, msg):
    user = _staff(db, StaffRole.FINANCE, "f1")
    with pytest.raises(HTTPException) as ei:
        _create(db, user, **over)
    assert ei.value.status_code == 400 and msg in ei.value.detail
    assert db.query(Sku).count() == 0


def test_图片最多9张(db):
    user = _staff(db, StaffRole.NEGOTIATOR, "n1")
    urls = [f"https://img.example.com/{i}.jpg" for i in range(12)]
    res = _create(db, user, images=urls)
    assert _sku(db, res.sku_code).images == urls[:9]


# --- 2. 查重：同一台别录两次 -------------------------------------------------------
def test_同序列号还在库就拦下_卖掉后可以再录(db):
    user = _staff(db, StaffRole.PURCHASER, "p1")
    first = _create(db, user)
    with pytest.raises(HTTPException) as ei:
        _create(db, user, source_asset_no="ZC-0002")
    assert ei.value.status_code == 400 and first.sku_code in ei.value.detail

    _sku(db, first.sku_code).status = SkuStatus.SHIPPED
    db.commit()
    assert _create(db, user, source_asset_no="ZC-0002").sku_code != first.sku_code


def test_来源编号录过要确认才放行(db):
    user = _staff(db, StaffRole.PURCHASER, "p1")
    first = _create(db, user)
    with pytest.raises(HTTPException) as ei:
        _create(db, user, serial_number="OTHER-SN")
    assert ei.value.status_code == 409
    assert first.sku_code in ei.value.detail and "p1名" in ei.value.detail

    assert _create(db, user, serial_number="OTHER-SN", allow_duplicate_source=True).sku_code


# --- 3. 权限：员工都能录，设备账号不能；看、改只限自己的 ----------------------------
@pytest.mark.parametrize("role", [StaffRole.CRAWLER, StaffRole.MARKET_BOT, StaffRole.RFID_DEVICE])
def test_设备账号不能录(role):
    with pytest.raises(HTTPException) as ei:
        router._STAFF(Staff(id="d", role=role))
    assert ei.value.status_code == 403


@pytest.mark.parametrize("role", [
    StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.NEGOTIATOR,
    StaffRole.SALES, StaffRole.FINANCE, StaffRole.ADMIN,
])
def test_所有员工岗位都能录(role):
    user = Staff(id="u", role=role)
    assert router._STAFF(user) is user


def test_财务也有工作台_落地页仍是我的():
    """入口在工作台，财务原本没有工作台 tab，等于看不见。"""
    from app.deps import get_landing_page, get_tabs_for_role

    assert "pages/workbench/index" in [t["pagePath"] for t in get_tabs_for_role(StaffRole.FINANCE)]
    assert get_landing_page(StaffRole.FINANCE) == "pages/profile/index"


def test_列表只看自己的_管理员看全部_能按序列号搜(db):
    p1 = _staff(db, StaffRole.PURCHASER, "p1")
    p2 = _staff(db, StaffRole.SALES, "p2")
    admin = _staff(db, StaffRole.ADMIN, "a1")
    _create(db, p1)
    _create(db, p2, serial_number="SN-B", source_asset_no="ZC-B")

    mine = router.list_intakes(q=None, page=1, size=20, db=db, user=p1)
    assert mine.total == 1 and mine.items[0].serial_number == "CN-0ABC-123"
    assert mine.items[0].status == "pending" and mine.items[0].editable is True
    assert router.list_intakes(q=None, page=1, size=20, db=db, user=admin).total == 2
    found = router.list_intakes(q="SN-B", page=1, size=20, db=db, user=admin)
    assert [i.entered_by_name for i in found.items] == ["p2名"]


def test_别人的录入当不存在(db):
    p1 = _staff(db, StaffRole.PURCHASER, "p1")
    p2 = _staff(db, StaffRole.PURCHASER, "p2")
    code = _create(db, p1).sku_code
    for call in (
        lambda: router.get_intake(code, db=db, user=p2),
        lambda: router.update_intake(code, _body(), db=db, user=p2),
    ):
        with pytest.raises(HTTPException) as ei:
            call()
        assert ei.value.status_code == 404


def _shop(db, sku, status):
    db.add(SkuShopListing(sku_id=sku.id, sale_shop_id="shop1", publish_status=status))
    db.commit()


def test_状态跟着货走(db):
    user = _staff(db, StaffRole.PURCHASER, "p1")
    sku = _sku(db, _create(db, user).sku_code)

    def status():
        d = router.get_intake(sku.sku_code, db=db, user=user)
        return d.status, d.status_label, d.editable

    assert status() == ("pending", "待上架", True)
    _shop(db, sku, ShopListingStatus.LISTING)
    assert status() == ("listing", "上架中", False)
    db.query(SkuShopListing).update({"publish_status": ShopListingStatus.LISTED})
    db.commit()
    assert status() == ("on_sale", "在售", False)
    sku.status, sku.reserve_source = SkuStatus.RESERVED, ReserveSource.PLATFORM_SOLD
    db.commit()
    assert status() == ("to_ship", "待发货", False)
    sku.status, sku.reserve_source = SkuStatus.SHIPPED, None
    db.commit()
    assert status() == ("sold", "已售出", False)


# --- 4. 修改：上架前能改，上架后走群控中心 ------------------------------------------
def test_上架前能改_改完库存和上架信息一起变(db):
    user = _staff(db, StaffRole.FINANCE, "f1")
    code = _create(db, user).sku_code

    out = router.update_intake(
        code,
        _body(model="U2723QE", price=Decimal("1499"), cost_price=Decimal("0"), location_code="A-01",
              images=["https://img.example.com/c.jpg"], source_asset_no="ZC-0001", remark=None),
        db=db, user=user,
    )

    assert out.price == Decimal("1499") and out.product_name == "戴尔 U2723QE" and out.location_code == "A-01"
    sku = _sku(db, code)
    assert sku.cost_price == Decimal("0") and sku.cover_url == "https://img.example.com/c.jpg"
    info = db.query(SkuListingInfo).filter_by(sku_id=sku.id).one()
    assert info.price == Decimal("1499") and info.images == ["https://img.example.com/c.jpg"]
    po = db.get(PurchaseOrder, sku.purchase_order_id)
    assert po.product_name == "戴尔 U2723QE" and po.unit_price == Decimal("0") and po.remark == "资产录入"
    assert db.query(AssetIntake).one().remark is None


def test_已经在上架的不能再改(db):
    user = _staff(db, StaffRole.PURCHASER, "p1")
    code = _create(db, user).sku_code
    _shop(db, _sku(db, code), ShopListingStatus.LISTING)
    with pytest.raises(HTTPException) as ei:
        router.update_intake(code, _body(price=Decimal("1")), db=db, user=user)
    assert ei.value.status_code == 400 and "群控中心" in ei.value.detail


def test_改自己时序列号和来源编号不算重复(db):
    user = _staff(db, StaffRole.PURCHASER, "p1")
    code = _create(db, user).sku_code
    assert router.update_intake(code, _body(desc="补一句"), db=db, user=user).desc == "补一句"


# --- 5. 录入人不拿提成，也不算采购 --------------------------------------------------
def _sold(db, sku, operator_id, sale_price):
    ob = SalesOutbound(outbound_no=f"OB-{sku.sku_code}", sku_id=sku.id, outbound_type="ORDER_SHIP",
                       sale_price=Decimal(sale_price), cost_price=sku.cost_price, operator_id=operator_id,
                       created_at=datetime.utcnow() - timedelta(seconds=5))
    sku.status = SkuStatus.SHIPPED
    db.add(ob)
    db.commit()
    return ob


def _normal_purchase(db, user, code="SKU-NORMAL"):
    """一件正常采购来的货（PO 前缀 PO），做对照组。"""
    po = PurchaseOrder(order_no="PO20261017001", status="IN_STOCK", product_name="正常采购",
                       unit_price=Decimal("100"), created_by_id=user.id)
    db.add(po)
    db.flush()
    insp = Inspection(inspect_no="IN20261017001", purchase_order_id=po.id, status="DONE",
                      inspector_id=user.id, inspected_at=datetime.utcnow() - timedelta(seconds=5))
    db.add(insp)
    db.flush()
    sku = Sku(sku_code=code, product_name="正常采购", purchase_order_id=po.id, inspection_id=insp.id,
              cost_price=Decimal("100"), status=SkuStatus.IN_STOCK)
    db.add(sku)
    db.commit()
    return po, sku


@pytest.fixture()
def sold_pair(db):
    """采购员 p1 录了一台资产、也正常采购了一件，两件都按 600 卖掉了。"""
    p1 = _staff(db, StaffRole.PURCHASER, "p1")
    admin = _staff(db, StaffRole.ADMIN, "a1")
    asset_sku = _sku(db, _create(db, p1, cost_price=Decimal("0")).sku_code)
    _po, normal_sku = _normal_purchase(db, p1)
    _sold(db, asset_sku, admin.id, "600")
    _sold(db, normal_sku, admin.id, "600")
    return p1, admin, asset_sku, normal_sku


def test_工资单与提成只算正常采购(db, sold_pair, monkeypatch):
    from app.services import commission

    p1, admin, _asset, _normal = sold_pair
    start, end = datetime.utcnow() - timedelta(days=1), datetime.utcnow() + timedelta(days=1)
    slip = commission.compute_payslip(db, p1, start, end, start.date(), end.date())
    purchase = next(s for s in slip.sections if s.role == "PURCHASER")
    assert [i.product_name for i in purchase.items] == ["正常采购"]
    assert purchase.commission_total == pytest.approx(50.0)  # (600-100)×10%

    monkeypatch.setattr(commission, "_period_start", lambda period: (start, end))
    assert commission.compute_commission(db, p1, "today").purchase_commission == pytest.approx(50.0)

    # 管理员看的是全量：占位验货单不计验货件，资产录入的毛利不进采购提成
    admin_slip = commission.compute_payslip(db, admin, start, end, start.date(), end.date())
    wh = next(s for s in admin_slip.sections if s.role == "WAREHOUSE")
    assert [i.ref_no for i in wh.items if i.kind == "inspect"] == ["IN20261017001"]
    stats = commission.compute_commission(db, admin, "today")
    assert stats.purchase_commission == pytest.approx(50.0)
    assert stats.detail["inspection_count"] == 1


def test_OA推送不给录入人记采购提成(db, sold_pair):
    from app.services.oa_push.events import build_finance_for_outbound

    _p1, _admin, asset_sku, normal_sku = sold_pair
    for sku, expect in ((asset_sku, False), (normal_sku, True)):
        ob = db.query(SalesOutbound).filter_by(sku_id=sku.id).one()
        po = db.get(PurchaseOrder, sku.purchase_order_id)
        suffixes = [suffix for _args, suffix in build_finance_for_outbound(ob, po, StaffRole.ADMIN)]
        assert ("purchase" in suffixes) is expect


def test_采购记录_财务_统计都不算资产录入(db, sold_pair):
    from app.routers.dashboard import summary, workload
    from app.routers.finance import finance_purchase_details, finance_stats
    from app.routers.purchase import _orders_query
    from app.services.finance import china_today

    p1, admin, _asset, _normal = sold_pair
    assert [o.order_no for o in _orders_query(db, p1, None, None, None, None).all()] == ["PO20261017001"]
    assert [o.order_no for o in _orders_query(db, admin, None, None, None, None).all()] == ["PO20261017001"]

    today = china_today()
    stats = finance_stats(date_from=today, date_to=today, _=admin, db=db)
    assert stats.purchase_count == 1 and stats.purchase_amount == pytest.approx(100.0)
    assert stats.inspection_count == 1
    # 员工提成 = 采购 (600-100)×10% + 仓管 验货1×5 + 出库2×5 + 销售 出库2×10
    assert stats.staff_commission == pytest.approx(50 + 5 + 10 + 20)
    details = finance_purchase_details(date_from=today, date_to=today, page=1, size=20, _=admin, db=db)
    assert details.total == 1

    assert workload(db=db, user=p1).today_purchase == 1
    # summary 还要数待验货和在库，在库里资产录入照样算
    assert summary(db=db, user=p1).today_purchase == 1


# --- 6. 手动入库抽成共用函数后行为不变 ----------------------------------------------
def test_手动入库行为不变(db, monkeypatch):
    from app.routers import inventory
    from app.schemas.inventory import ManualInboundIn

    calls = []
    monkeypatch.setattr(inventory, "enqueue_on_inbound", lambda _db, sku: calls.append(("enqueue", sku.sku_code)))
    monkeypatch.setattr(inventory, "enrich_sku_spu", lambda sku: calls.append(("enrich", sku.sku_code)))
    user = _staff(db, StaffRole.WAREHOUSE, "w1")

    res = inventory.manual_inbound(
        ManualInboundIn(
            sku_code="old-001", brand="联想", model="T14", serial_number="PF-1", barcode="6901234567892",
            location_code="B-02", condition_grade="95新", product_type="笔记本", cost_price=Decimal("800"),
            images=["https://img.example.com/v.mp4", "https://img.example.com/p.jpg"],
            location_images=["https://img.example.com/loc.jpg"],
            inbound_at=datetime(2026, 3, 1, 8, 0), remark="旧仓",
        ),
        db=db, user=user,
    )

    assert res.sku_code == "OLD-001" and res.purchase_order_no.startswith("POMAN")
    sku = _sku(db, "OLD-001")
    assert sku.tags == ["MANUAL_INBOUND"] and sku.product_name == "联想 T14"
    assert sku.cover_url == "https://img.example.com/p.jpg", "视频不能做封面"
    assert sku.location_images == ["https://img.example.com/loc.jpg"] and sku.barcode == "6901234567892"
    # 旧系统入库时间按北京时间回填，存 UTC；SKU 也按原始日期排序
    assert sku.inbound_at == sku.negotiated_at == sku.created_at == datetime(2026, 3, 1, 0, 0)
    assert sku.negotiation_remark == "手动入库免议价" and sku.suggest_price == Decimal("800")
    po = db.get(PurchaseOrder, sku.purchase_order_id)
    assert po.remark == "手动入库：旧仓" and po.unit_price == Decimal("800") and po.created_by_id == user.id
    insp = db.get(Inspection, sku.inspection_id)
    assert insp.inspect_no.startswith("INMAN") and insp.inspector_id == user.id
    assert (insp.location_code, insp.condition_grade) == ("B-02", "95新")
    event = db.query(StockEvent).filter_by(sku_id=sku.id).one()
    assert event.payload == {"source": "MANUAL_INBOUND", "old_sku_code": "old-001"}
    assert calls == [("enrich", "OLD-001"), ("enqueue", "OLD-001")]
    assert db.query(AssetIntake).count() == 0
