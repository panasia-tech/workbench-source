"""库存缺口总览。

口径与自动上架流水线同一份（backfill.outcome），这里只验：分对种类、系统在等的标「不用管」、
在卖/上架中/锁定的不算缺口、销售看不到成本、管理员能开关种类、缩略图绝不用封面。
"""

from decimal import Decimal

import pytest

from app.enums import AutoListingStage, ShopListingStatus, SkuStatus, StaffRole
from app.models import SaleShop, Sku, SkuAutoListing, SkuShopListing, Staff
from app.routers import stock_gaps as api
from app.services import stock_gaps as sg
from app.services.auto_listing.pipeline import HELD_READY, HELD_READY_CRAWLED, WAIT_CRAWLER


def _sku(db, code, **kw):
    base = dict(
        sku_code=code, purchase_order_id="p", inspection_id="i", product_name=f"货{code}",
        cost_price=Decimal("900"), status=SkuStatus.IN_STOCK, images=[f"https://oss/{code}.jpg"],
        cover_url="https://oss/封面订单截图.jpg",
    )
    sku = Sku(**{**base, **kw})
    db.add(sku)
    db.flush()
    return sku


def _gap(db, code, stage, err=None, **kw):
    sku = _sku(db, code, **kw)
    db.add(SkuAutoListing(sku_id=sku.id, stage=stage, last_error=err, hold_publish=True, market_price=Decimal("1000")))
    db.flush()
    return sku


@pytest.fixture()
def db(db_session):
    _gap(db_session, "A-UNRES", AutoListingStage.NEEDS_HUMAN, "解析不出所属 SPU（品牌/型号不在对照表里）")
    _gap(db_session, "B-PRICE", AutoListingStage.COLLECTING, "还没有行情价")
    _gap(db_session, "C-PHOTO", AutoListingStage.NEEDS_HUMAN, "缺图：没有实拍图，爬虫没搜到这个型号的图（行情价 1000）", images=[])
    _gap(db_session, "D-SEARCH", AutoListingStage.COLLECTING, WAIT_CRAWLER, images=[])
    _gap(db_session, "E-COST", AutoListingStage.NEEDS_HUMAN, "不自动定价：market_below_cost（行情 800 / 成本 900）")
    _gap(db_session, "F-READY", AutoListingStage.READY, HELD_READY)
    _gap(db_session, "G-CRAWL", AutoListingStage.READY, HELD_READY_CRAWLED)
    _gap(db_session, "H-NOCOST", AutoListingStage.NEEDS_HUMAN, "不自动定价：no_cost_price（行情 1000 / 成本 None）")
    db_session.commit()
    return db_session


def _staff(role):
    return Staff(id=f"u-{role}", role=role, username="u", name="u")


def _list(db, role=StaffRole.ADMIN, **kw):
    params = dict(kind=None, q=None, page=1, size=50)
    params.update(kw)
    return api.list_gaps(db=db, user=_staff(role), **params)


def _kinds(res):
    return {k["key"]: (k["total"], k["todo"]) for k in res["kinds"]}


def test_分对种类_系统在等的标不用管(db):
    res = _list(db)
    assert _kinds(res) == {
        "unresolved": (1, 1),
        "no_price": (1, 0),
        "no_image": (2, 1),
        "below_cost": (1, 1),
        "unlisted": (2, 2),
    }, "其他默认不算缺口"
    by = {x["sku_code"]: x for x in res["items"]}
    assert by["D-SEARCH"]["waiting"] and by["B-PRICE"]["waiting"]
    assert by["C-PHOTO"]["note"].startswith("没有实拍图") and by["C-PHOTO"]["action_url"].endswith("code=C-PHOTO")
    assert "edit" in by["C-PHOTO"]["action_url"] and "spu-match" in by["A-UNRES"]["action_url"]
    assert "publish" in by["F-READY"]["action_url"] and "爬虫" in by["G-CRAWL"]["note"]


def test_按种类筛和搜(db):
    assert [x["sku_code"] for x in _list(db, kind="below_cost")["items"]] == ["E-COST"]
    assert [x["sku_code"] for x in _list(db, q="f-ready")["items"]] == ["F-READY"]


def test_在卖_上架中_锁定的不算缺口(db):
    shop = SaleShop(code="S1", label="店1", xianyu_user_name="n")
    db.add(shop)
    db.flush()
    for code, status in (("F-READY", ShopListingStatus.LISTED), ("G-CRAWL", ShopListingStatus.LISTING)):
        sku = db.query(Sku).filter_by(sku_code=code).one()
        db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, publish_status=status))
    db.query(Sku).filter_by(sku_code="E-COST").one().reserve_source = "SALE"
    db.commit()
    codes = {x["sku_code"] for x in _list(db)["items"]}
    assert not codes & {"F-READY", "G-CRAWL", "E-COST"}


def test_销售看不到成本_也不给它做不了的操作(db):
    items = _list(db, StaffRole.SALES)["items"]
    assert all(x["cost_price"] is None for x in items)
    assert any(x["cost_price"] == "900" for x in _list(db)["items"])
    by = {x["sku_code"]: x for x in items}
    assert by["C-PHOTO"]["action_label"] == "看详情" and by["A-UNRES"]["action_label"] == "看详情"
    assert by["F-READY"]["action_label"] == "去上架"


def test_缩略图只用实拍图_绝不用封面(db):
    for x in _list(db)["items"]:
        assert "封面" not in (x["image"] or "")


def test_管理员开关种类(db):
    admin = _staff(StaffRole.ADMIN)
    api.write_settings(api.KindsIn(kinds=["other", "no_image", "乱写的"]), db=db, user=admin)
    assert sg.enabled_kinds(db) == ["no_image", "other"]
    assert set(_kinds(_list(db))) == {"no_image", "other"}
    assert "H-NOCOST" in {x["sku_code"] for x in _list(db)["items"]}

    api.write_settings(api.KindsIn(kinds=[]), db=db, user=admin)
    assert sg.enabled_kinds(db) == [], "全不勾就是全关，不回落默认"
    assert _list(db)["items"] == []
