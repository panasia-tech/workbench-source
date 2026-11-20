"""PublishSpec 组装:SkuListingInfo 优先、缺则回退 Sku;只取商品实拍图;运费映射。"""

from decimal import Decimal

import app.services.gc_bridge.assembler as A
from app.models import Sku, SkuListingInfo


def _identity_sign(monkeypatch):
    # 隔离 OSS 签名,只测映射逻辑
    monkeypatch.setattr(A, "sign_oss_publish_image_url", lambda obj, expires=86400: obj)


def test_prefers_listing_info(monkeypatch):
    _identity_sign(monkeypatch)
    sku = Sku(sku_code="SK1", images=["oss/sku/product/a.jpg"], suggest_price=Decimal("120"),
              location_images=["oss/sku/location/x.jpg"])
    info = SkuListingInfo(images=["oss/sku/product/b.jpg"], price=Decimal("199"),
                          express_fee=Decimal("0"), desc="hi")
    spec = A.build_publish_spec(sku, info)
    assert spec["images"] == ["oss/sku/product/b.jpg"]   # 用 info.images
    assert spec["price"] == 199                            # 用 info.price(整数元)
    assert spec["shipping"] == {"mode": "fixed_fee", "fixed_fee": 0, "self_pickup": True}
    assert spec["confirm_publish"] is False


def test_falls_back_to_sku(monkeypatch):
    _identity_sign(monkeypatch)
    sku = Sku(sku_code="SK2", images=["oss/sku/product/c.jpg"], suggest_price=Decimal("88.6"))
    # info 无图/无价 → 回退 sku
    info = SkuListingInfo(images=[], price=None, express_fee=None)
    spec = A.build_publish_spec(sku, info)
    assert spec["images"] == ["oss/sku/product/c.jpg"]
    assert spec["price"] == 89                              # 88.6 四舍五入
    # 没填运费 → 一口价 0(不是包邮)
    assert spec["shipping"] == {"mode": "fixed_fee", "fixed_fee": 0, "self_pickup": True}


def test_no_info_uses_sku(monkeypatch):
    _identity_sign(monkeypatch)
    sku = Sku(sku_code="SK3", images=["oss/sku/product/d.jpg"], suggest_price=Decimal("50"))
    spec = A.build_publish_spec(sku, None)
    assert spec["images"] == ["oss/sku/product/d.jpg"]
    assert spec["price"] == 50
    assert spec["shipping"]["mode"] == "fixed_fee"
    assert spec["shipping"]["fixed_fee"] == 0


def test_never_uses_location_images(monkeypatch):
    _identity_sign(monkeypatch)
    # info 无图、sku 也无 images,只有 location_images → 图应为空(绝不拿库位图),交 gc 侧 400
    sku = Sku(sku_code="SK4", images=[], location_images=["oss/sku/location/z.jpg"],
              suggest_price=Decimal("10"))
    spec = A.build_publish_spec(sku, SkuListingInfo(images=[]))
    assert spec["images"] == []


def test_fixed_fee_shipping(monkeypatch):
    _identity_sign(monkeypatch)
    sku = Sku(sku_code="SK5", images=["oss/sku/product/e.jpg"], suggest_price=Decimal("300"))
    info = SkuListingInfo(images=["oss/sku/product/e.jpg"], price=Decimal("300"), express_fee=Decimal("12"))
    spec = A.build_publish_spec(sku, info)
    assert spec["shipping"] == {"mode": "fixed_fee", "fixed_fee": 12, "self_pickup": True}


def test_confirm_publish_flag(monkeypatch):
    _identity_sign(monkeypatch)
    sku = Sku(sku_code="SK6", images=["oss/sku/product/f.jpg"], suggest_price=Decimal("10"))
    spec = A.build_publish_spec(sku, None, confirm_publish=True)
    assert spec["confirm_publish"] is True
