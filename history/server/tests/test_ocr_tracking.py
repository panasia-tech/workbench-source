"""快递单号抽取：公司名后缀漏一个，就是整家快递的单号都抓不到。

回归来源：2026-09-18 一张顺丰物流截图里明明有「顺丰速运SF5151612324937」，
却解析出 tracking_no=None，且这行还被当成了商品名——因为后缀清单里只有
「速递/快递/物流」，没有顺丰官方用的「速运」。
"""

import pytest

from app.services.ocr import _extract_product_name, _extract_tracking_no, parse_xianyu_text


@pytest.mark.parametrize("line, expected", [
    ("顺丰速运SF5151612324937", "SF5151612324937"),   # 本次回归
    ("顺丰速递SF5151612324937", "SF5151612324937"),
    ("顺丰快递SF5151612324937", "SF5151612324937"),
    ("顺丰SF5151612324937", "SF5151612324937"),
    ("德邦快运DB1234567890", "DB1234567890"),
    ("百世快运HTKY1234567890", "HTKY1234567890"),
    ("圆通速递YT1234567890", "YT1234567890"),
    ("中通快递ZT1234567890", "ZT1234567890"),
    ("京东物流JD1234567890", "JD1234567890"),
])
def test_courier_suffix_variants(line, expected):
    assert _extract_tracking_no([line]) == expected


def test_labeled_value_still_wins():
    # 带标签的行优先，不走公司名兜底
    assert _extract_tracking_no(["物流单号：SF5151612324937", "顺丰速运SF9999999999"]) == "SF5151612324937"


def test_bare_tracking_no_still_matched():
    assert _extract_tracking_no(["SF5151612324937"]) == "SF5151612324937"


def test_unknown_courier_falls_back_to_suffix():
    # 公司名不在清单里，靠后缀兜底
    assert _extract_tracking_no(["安能快运AN1234567890"]) == "AN1234567890"


def test_tracking_line_is_not_taken_as_product_name():
    # 同一个正则还兼着「这行是单号，别当商品名」的判断，修一处治两处
    assert _extract_product_name(["顺丰速运SF5151612324937"]) is None


def test_parse_xianyu_extracts_shunfeng_tracking():
    blocks = [
        "顺丰速运SF5151612324937",
        "复制丨打电话",
        "[收货地址]浙江省杭州市富阳区银湖街道杭州兴",
        "派送中",
    ]
    parsed = parse_xianyu_text(blocks)
    assert parsed["tracking_no"] == "SF5151612324937"
    assert parsed["product_name"] != "顺丰速运SF5151612324937"
