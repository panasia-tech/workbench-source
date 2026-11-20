"""自动上架定价：售价即行情价，倒挂转人工。

老板定的规则就一句「定价就是行情价」——不乘系数不加价。
但全自动 + 按行情价，遇到行情低于成本就是自动亏本挂货，所以加一道倒挂闸门。
"""

from decimal import Decimal

import pytest

from app.services.auto_listing.pricing import (
    REASON_BELOW_COST,
    REASON_NO_COST,
    REASON_NO_MARKET_PRICE,
    resolve_price,
    to_int_yuan,
)


def test_售价就是行情价不乘任何系数():
    price, reason = resolve_price(Decimal("1360.00"), Decimal("900.00"))
    assert price == Decimal("1360.00") and reason is None


def test_行情价高于成本正常放行():
    price, reason = resolve_price("500", "499.99")
    assert price == Decimal("500.00") and reason is None


def test_行情等于成本放行():
    """不亏就行，毛利多少是生意问题不是程序问题。"""
    price, reason = resolve_price("500", "500")
    assert price == Decimal("500.00") and reason is None


def test_行情倒挂转人工而不是亏本挂():
    price, reason = resolve_price("300", "500")
    assert price is None and reason == REASON_BELOW_COST


@pytest.mark.parametrize("bad", [None, 0, "0", "-1", "abc", ""])
def test_没有有效行情价不定价(bad):
    price, reason = resolve_price(bad, "500")
    assert price is None and reason == REASON_NO_MARKET_PRICE


def test_成本缺失转人工():
    """不知道成本就判断不了亏不亏，跟倒挂一样停下让人看（11-03 起）。"""
    for cost in (None, 0, "0"):
        price, reason = resolve_price("500", cost)
        assert price is None and reason == REASON_NO_COST


def test_取整后低于成本也算倒挂():
    """群控挂的是整数元：1299.45 会挂成 1299，低于成本 1299.40。"""
    price, reason = resolve_price("1299.45", "1299.40")
    assert price is None and reason == REASON_BELOW_COST
    assert resolve_price("1299.50", "1299.40")[1] is None


def test_取整是五入不是银行家舍入():
    assert to_int_yuan("1298.5") == 1299
    assert to_int_yuan("1299.49") == 1299
    assert to_int_yuan(None) is None


def test_保留两位小数():
    assert resolve_price("1360.456", "100")[0] == Decimal("1360.46")
    assert resolve_price("1360.444", "100")[0] == Decimal("1360.44")
