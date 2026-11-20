"""MARKET_BOT（行情工作台设备账号）的权限边界。

# 它为什么存在

桌面端自己登录的是设备账号，可「把闲鱼上查到的正确品名回写进库存」这件事，服务端
原先只放行 ADMIN/仓管。于是做法变成：让操作员把**管理员密码填进桌面端**，端上换一把
管理员令牌去回写。那把钥匙开的是仓管全量编辑接口——改货号、改 69 码、改规格库位成色，
而它实际只想改一个商品名；审计上还全部记成「管理员干的」，查不出是哪台工位。

MARKET_BOT 把这件事收回正轨：一个身份干一件事，权限就按那一件事给。

# 这里钉死的边界

  1. 它能读（与 CRAWLER 同权），并且比只读爬虫多看一个成本价——调价台拿它算成本底价；
  2. 它**够不到**仓管的全量编辑接口 —— 这条是整件事的重点，破了就等于白改；
  3. 它够不到上架接口（那条能改标题/售价/图片，是另一个量级的权限）；
  4. 窄接口只接受三个字段，多送一个当场报错，不静默丢弃；
  5. 每次回写落 EventLog，记得下前后值和是谁改的。
"""

import inspect
from datetime import datetime
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.deps import require_roles
from app.enums import SkuStatus, StaffRole
from app.models import EventLog, Sku, Staff
from app.routers import inventory as inv
from app.schemas.inventory import SkuMarketInfoIn


class _FakeQuery:
    def __init__(self):
        self.filtered = False

    def filter(self, *_a, **_k):
        self.filtered = True
        return self


def _staff(role, sid="staff-bot"):
    return Staff(id=sid, staff_no="D001", name="行情工作台",
                 username="bot", password_hash="x", role=role)


def _check(gate, role):
    """直接跑 require_roles 生成的校验函数：过返回 user，不过抛 403。"""
    return gate(_staff(role))


# --- 1. 读：与 CRAWLER 同权，外加一个成本价 -----------------------------------
def test_读库存与爬虫同权():
    query = _FakeQuery()
    assert inv._inspector_filter(query, _staff(StaffRole.MARKET_BOT)) is query
    assert not query.filtered, "设备账号要按在库型号采集行情，看不到全部就没法工作"


def test_看得到成本价():
    assert inv._hide_cost(_staff(StaffRole.MARKET_BOT)) is False, \
        "调价台要拿成本价算成本底价；看不到成本就出不了候选价，只能永远停在需复核"


def test_只读爬虫仍然看不到成本价():
    assert inv._hide_cost(_staff(StaffRole.CRAWLER)) is True, \
        "放行的是工作台这一个角色，纯采集端没有用成本的地方，不跟着一起放"


# --- 2. 够不到仓管的全量编辑接口（本次改造的重点）----------------------------
def test_够不到全量编辑接口():
    full_edit = require_roles(StaffRole.WAREHOUSE, StaffRole.ADMIN)
    with pytest.raises(HTTPException) as exc:
        _check(full_edit, StaffRole.MARKET_BOT)
    assert exc.value.status_code == 403, \
        "全量编辑能改货号和 69 码；设备账号一旦够得到，这次改造就白做了"


# --- 3. 也够不到上架接口（标题/售价/图片是另一个量级）------------------------
def test_够不到上架接口():
    listing_save = require_roles(StaffRole.WAREHOUSE, StaffRole.SALES, StaffRole.ADMIN)
    with pytest.raises(HTTPException) as exc:
        _check(listing_save, StaffRole.MARKET_BOT)
    assert exc.value.status_code == 403


def _endpoint_gate(fn):
    """取出这个端点**真正挂着**的角色闸。

    这里曾经是 `require_roles(...)` 现搭一个一模一样的闸来断言——那测的是
    require_roles 自己,不是端点。于是 2026-09-16 给窄接口加采购时,这条断言
    一声不响地继续绿着。改成从函数签名里把真的那个依赖抠出来。
    """
    dep = inspect.signature(fn).parameters["user"].default
    return dep.dependency


def test_窄接口放行谁():
    gate = _endpoint_gate(inv.update_sku_market_info)
    # 采购 2026-09-16 加入:它要在工作台上把闲鱼查到的正确品名回写进库存
    for role in (StaffRole.MARKET_BOT, StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.ADMIN):
        assert _check(gate, role).role == role
    for role in (StaffRole.SALES, StaffRole.CRAWLER, StaffRole.FINANCE):
        with pytest.raises(HTTPException):
            _check(gate, role)


def test_看得到成本价不等于能改东西():
    """成本价对销售放开了(_hide_cost),但销售仍然够不到这条窄写接口。

    读和写是两把锁,放开一把不该顺带开另一把——这条就是钉这件事。
    """
    assert inv._hide_cost(_staff(StaffRole.SALES)) is False
    with pytest.raises(HTTPException) as exc:
        _check(_endpoint_gate(inv.update_sku_market_info), StaffRole.SALES)
    assert exc.value.status_code == 403


# --- 4. 字段边界就是 schema 本身 ---------------------------------------------
@pytest.mark.parametrize("payload", [
    {"sku_code": "SK-HACK"},          # 改货号
    {"barcode": "6901234567892"},     # 改 69 码
    {"sale_price": "9.9"},            # 改价
    {"spu_code": "SPU-X"},            # 改 SPU 关联
    {"status": "SHIPPED"},            # 改状态
])
def test_多送字段一律拒绝(payload):
    with pytest.raises(Exception):
        SkuMarketInfoIn(product_name="正确品名", **payload)


def test_只认那三个字段():
    body = SkuMarketInfoIn(product_name="AOC 24G10", brand="AOC", model="24G10")
    assert set(body.model_dump(exclude_unset=True)) == {"product_name", "brand", "model"}


# --- 5. 回写本身：只动三个字段，且必须留痕 -----------------------------------
def _seed(db, monkeypatch):
    sku = Sku(sku_code="SK-1", purchase_order_id="p", inspection_id="i",
              product_name="旧名", brand="旧牌", model="旧号",
              cost_price=Decimal("900"), status=SkuStatus.IN_STOCK,
              created_at=datetime.utcnow())
    db.add(sku)
    db.add(_staff(StaffRole.MARKET_BOT))
    db.commit()
    # sku_detail 要拼一整套关联视图，这里只关心写入效果，替成回读原始行
    monkeypatch.setattr(inv, "sku_detail", lambda code, session, user: session.query(Sku)
                        .filter(Sku.sku_code == code).first())
    return sku


def test_回写只动三个字段并留痕(db_session, monkeypatch):
    _seed(db_session, monkeypatch)
    inv.update_sku_market_info(
        "SK-1", SkuMarketInfoIn(product_name="AOC 24G10 显示器", brand="AOC"),
        db=db_session, user=_staff(StaffRole.MARKET_BOT),
    )
    db_session.expire_all()
    sku = db_session.query(Sku).filter(Sku.sku_code == "SK-1").first()
    assert sku.product_name == "AOC 24G10 显示器"
    assert sku.brand == "AOC"
    assert sku.model == "旧号", "没送的字段不许被顺手清空"
    assert sku.sku_code == "SK-1"

    log = db_session.query(EventLog).filter(EventLog.event_type == "sku_market_info_writeback").first()
    assert log is not None, "回写必须留痕，否则查不出是哪台工位改的"
    assert log.entity_id == "SK-1"
    assert log.operator_id == "staff-bot", "操作者要记设备账号本人，不能再记成管理员"
    assert log.payload["before"]["product_name"] == "旧名"
    assert log.payload["after"]["product_name"] == "AOC 24G10 显示器"
    assert log.payload["role"] == StaffRole.MARKET_BOT


def test_商品名不能被改空(db_session, monkeypatch):
    _seed(db_session, monkeypatch)
    with pytest.raises(HTTPException) as exc:
        inv.update_sku_market_info(
            "SK-1", SkuMarketInfoIn(product_name="   "),
            db=db_session, user=_staff(StaffRole.MARKET_BOT),
        )
    assert exc.value.status_code == 400


def test_没变化就不写日志(db_session, monkeypatch):
    _seed(db_session, monkeypatch)
    inv.update_sku_market_info(
        "SK-1", SkuMarketInfoIn(product_name="旧名"),
        db=db_session, user=_staff(StaffRole.MARKET_BOT),
    )
    assert db_session.query(EventLog).count() == 0, "值没变就不该产生一条审计噪音"


def test_不在库的货不许回写(db_session, monkeypatch):
    _seed(db_session, monkeypatch)
    sku = db_session.query(Sku).filter(Sku.sku_code == "SK-1").first()
    sku.status = SkuStatus.SHIPPED
    db_session.commit()
    with pytest.raises(HTTPException) as exc:
        inv.update_sku_market_info(
            "SK-1", SkuMarketInfoIn(product_name="新名"),
            db=db_session, user=_staff(StaffRole.MARKET_BOT),
        )
    assert exc.value.status_code == 400
