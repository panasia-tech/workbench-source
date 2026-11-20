"""SKU → 仓库 SPU 的解析：三条命中路径与「宁可漏不可错」的边界。

自动上架靠这个解析结果去搜行情、采图片，挂错款比解析不出来危险得多——
解析不出只是转人工，挂错款会按别的货定价并发布出去。
"""

import pytest

from app.enums import SkuStatus
from app.models import Sku, WarehouseSpu
from app.services.spu_resolve import (
    MATCH_BARCODE,
    MATCH_BRAND_MODEL,
    MATCH_MODEL,
    MATCH_NONE,
    resolve_spu,
)


@pytest.fixture()
def db(db_session):
    rows = [
        WarehouseSpu(spu_code="90000638", brand="小米", model="空气净化器4PRO"),
        WarehouseSpu(spu_code="6940017323126", brand="HKC", model="G24H3D"),
        WarehouseSpu(spu_code="90000430", brand="盛色", model="G7"),
        # 同名多 SPU：清单里「盛色 N50PRO6」真有 3 个编码
        WarehouseSpu(spu_code="6974772491776", brand="盛色", model="N50PRO6"),
        WarehouseSpu(spu_code="6974772491585", brand="盛色", model="N50PRO6"),
        WarehouseSpu(spu_code="6974772491592", brand="盛色", model="N50PRO6"),
        # 停用的不该参与自动化
        WarehouseSpu(spu_code="90000287", brand="雷神", model="DQ27F240L", enabled=False),
        # 不同品牌撞同一个型号名
        WarehouseSpu(spu_code="90000744", brand="AOC", model="X100"),
        WarehouseSpu(spu_code="90000751", brand="KTC", model="X100"),
    ]
    db_session.add_all(rows)
    db_session.commit()
    return db_session


def _sku(**kw):
    base = dict(
        sku_code="M20260907-001", purchase_order_id="p", inspection_id="i",
        product_name="x", cost_price=100, status=SkuStatus.IN_STOCK,
    )
    return Sku(**{**base, **kw})


def test_69码命中SPU编码(db):
    got = resolve_spu(db, _sku(barcode="6940017323126", brand="乱写的", model="也乱写"))
    assert got.how == MATCH_BARCODE
    assert got.spu.spu_code == "6940017323126"
    assert got.query == "HKC G24H3D"


def test_69码优先于型号(db):
    """69码是一物一码，比人工敲的型号可靠，必须优先。"""
    got = resolve_spu(db, _sku(barcode="90000638", brand="盛色", model="G7"))
    assert got.spu.spu_code == "90000638"  # 走了 barcode，不是 盛色 G7


def test_品牌加型号命中(db):
    got = resolve_spu(db, _sku(brand="小米", model="空气净化器4PRO"))
    assert got.how == MATCH_BRAND_MODEL
    assert got.spu.spu_code == "90000638"


def test_品牌不同的同名型号不会串款(db):
    """AOC X100 和 KTC X100 是两款货，带品牌时必须分开。"""
    assert resolve_spu(db, _sku(brand="AOC", model="X100")).spu.spu_code == "90000744"
    assert resolve_spu(db, _sku(brand="KTC", model="X100")).spu.spu_code == "90000751"


def test_品牌写法不一致时回退到型号(db):
    """验货有时把「盛色」敲成「SANC」，型号相对稳定。"""
    got = resolve_spu(db, _sku(brand="SANC", model="G7"))
    assert got.how == MATCH_MODEL
    assert got.spu.spu_code == "90000430"


def test_大小写不敏感(db):
    assert resolve_spu(db, _sku(brand="hkc", model="g24h3d")).matched
    assert resolve_spu(db, _sku(barcode="6940017323126")).matched


def test_同名多SPU取定且稳定(db):
    """3 个编码品牌型号完全相同，对搜行情/采图等价，但每次必须解析到同一个。"""
    a = resolve_spu(db, _sku(brand="盛色", model="N50PRO6"))
    b = resolve_spu(db, _sku(brand="盛色", model="N50PRO6"))
    assert a.spu.spu_code == b.spu.spu_code == "6974772491585"  # 按 spu_code 排序取首
    assert a.ambiguous == 3


def test_停用的SPU不参与(db):
    got = resolve_spu(db, _sku(brand="雷神", model="DQ27F240L"))
    assert got.how == MATCH_NONE and got.spu is None


def test_解析不出返回none而不是猜(db):
    for sku in (_sku(brand="没见过", model="没见过"), _sku(), _sku(model="   ")):
        got = resolve_spu(db, sku)
        assert got.how == MATCH_NONE and got.spu is None and got.query is None


def test_只有型号没品牌也能解(db):
    got = resolve_spu(db, _sku(model="空气净化器4PRO"))
    assert got.how == MATCH_MODEL and got.spu.spu_code == "90000638"


def test_69码查不到时回退型号(db):
    """69码是别的码（没进对照表），不能因此放弃，还有型号可用。"""
    got = resolve_spu(db, _sku(barcode="1234567890123", brand="HKC", model="G24H3D"))
    assert got.how == MATCH_BRAND_MODEL and got.spu.spu_code == "6940017323126"


def test_一批一起解析和逐件一样(db):
    """库存商品卡片墙按批解析（resolve_many），结果必须和逐件 resolve_spu 一模一样。"""
    from app.services.spu_resolve import resolve_many

    skus = [
        _sku(sku_code="A", barcode="6940017323126", model="乱写"),
        _sku(sku_code="B", barcode="90000638", brand="盛色", model="G7"),
        _sku(sku_code="C", brand="盛色", model="g7"),
        _sku(sku_code="D", brand="SANC", model="N50PRO6"),
        _sku(sku_code="E", brand="雷神", model="DQ27F240L"),
        _sku(sku_code="F", brand="KTC", model="X100"),
        _sku(sku_code="G", model="X100"),
        _sku(sku_code="H"),
    ]
    db.add_all(skus)
    db.flush()
    many = resolve_many(db, skus)
    for s in skus:
        one = resolve_spu(db, s).spu
        assert (many[s.id].spu_code if many[s.id] else None) == (one.spu_code if one else None), s.sku_code
