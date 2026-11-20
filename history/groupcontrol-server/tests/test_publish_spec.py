"""PublishSpec 校验(app/publish_spec）:发布前拦下会出事的 spec。"""

import pytest

from app.publish_spec import validate_publish_spec

OSS = "https://bkt.oss-cn.aliyuncs.com"


def _spec(**over):
    s = {"images": [f"{OSS}/sku/product/abc.jpg?Expires=1&Signature=x"], "price": 460}
    s.update(over)
    return s


def test_valid_spec_passes():
    validate_publish_spec(_spec())  # 不抛即通过


def test_missing_images_rejected():
    with pytest.raises(ValueError, match="缺少商品图"):
        validate_publish_spec(_spec(images=[]))


def test_order_privacy_image_rejected():
    # 买家隐私成交截图(_order_)绝不能上架
    bad = f"{OSS}/asset/2026/po_order_123/shot.jpg?Signature=x"
    with pytest.raises(ValueError, match="隐私图/库位图/议价图"):
        validate_publish_spec(_spec(images=[bad]))


def test_location_image_rejected():
    # 库位图(location)不得混入上架图
    bad = f"{OSS}/sku/location/A3-05.jpg?Signature=x"
    with pytest.raises(ValueError, match="隐私图/库位图/议价图"):
        validate_publish_spec(_spec(images=[_spec()["images"][0], bad]))


def test_negotiation_media_rejected():
    bad = f"{OSS}/sku/negotiation/evidence.jpg?Signature=x"
    with pytest.raises(ValueError, match="隐私图/库位图/议价图"):
        validate_publish_spec(_spec(images=[bad]))


def test_price_zero_or_negative_rejected():
    with pytest.raises(ValueError, match="售价"):
        validate_publish_spec(_spec(price=0))
    with pytest.raises(ValueError, match="售价"):
        validate_publish_spec(_spec(price=-5))


def test_price_missing_rejected():
    s = _spec()
    s.pop("price")
    with pytest.raises(ValueError, match="售价"):
        validate_publish_spec(s)


def test_price_bool_rejected():
    # True 是 int 子类,不能被当 1 放行
    with pytest.raises(ValueError, match="售价"):
        validate_publish_spec(_spec(price=True))


def test_blank_image_url_rejected():
    with pytest.raises(ValueError, match="空项或无效链接"):
        validate_publish_spec(_spec(images=["   "]))
