"""自动上架的定价规则。纯函数，可独立回归。

**售价即行情价**（老板 2026-09-08 拍板）——不乘系数、不加价。
档位以后按「成本 vs 实际成交价」的关系回头再定，现在不猜。

例外是行情倒挂：行情价低于成本价时**不自动发**，转人工。
全自动 + 按行情价，遇到倒挂就是自动亏本挂货；这跟「解析不出转人工」
是同一个原则——判断不了就停下，别猜。没有成本也一样判断不了，转人工
（2026-11-03 起，原先是放行）。

行情价靠不住也停（E04-10，2026-11-10）：巡航台的「清洗后平均挂牌价」是几条挂牌的均价，
有效挂牌太少、或者挂牌之间价差太大（多半是混进了别的配置 / 配件 / 坏机），均价就不可信。
见 check_samples；拿不到样本明细的旧数据、OCR 成交价不判，照旧放行。
"""

from __future__ import annotations

from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal

# 转人工的原因码，进 last_error，便于后台看板归类
REASON_NO_MARKET_PRICE = "no_market_price"
REASON_BELOW_COST = "market_below_cost"
REASON_NO_COST = "no_cost_price"
REASON_INVALID = "invalid_price"
REASON_FEW_SAMPLES = "market_few_samples"
REASON_WIDE_SPREAD = "market_wide_spread"


def _money(v) -> Decimal | None:
    if v is None:
        return None
    try:
        return Decimal(str(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (ArithmeticError, TypeError, ValueError):
        return None


def resolve_price(market_price, cost_price, min_cost_ratio=Decimal("1")) -> tuple[Decimal | None, str | None]:
    """返回 (售价, 转人工原因)。原因为 None 表示可以自动发。

    群控侧的价格是整数元（assembler._to_int_yuan 会取整），这里保留两位小数
    落库留痕，取整交给 assembler，避免两处各取整一次对不上。
    """
    market = _money(market_price)
    cost = _money(cost_price)

    if market is None or market <= 0:
        return None, REASON_NO_MARKET_PRICE
    if cost is None or cost <= 0:
        # 不知道成本就不知道亏不亏
        return None, REASON_NO_COST
    # 跟成本线比的是群控实际挂出去的整数元，不然 1299.45 对 1299.40 成本会挂成 1299。
    # 成本线 = 成本 × 管理端定的比例（默认 1，即不亏），见 listing_approval.min_cost_ratio
    if to_int_yuan(market) < floor_price(cost, min_cost_ratio):
        # 行情倒挂：按行情价发就是亏本卖，停下让人看
        return None, REASON_BELOW_COST
    return market, None


def floor_price(cost, ratio) -> int | None:
    """最低能发的整数元，往上取整：成本 999.5 × 1.30 = 1299.35 → 1300。没成本返回 None。"""
    c = _money(cost)
    if c is None or c <= 0:
        return None
    return int((c * Decimal(str(ratio))).quantize(Decimal("1"), rounding=ROUND_CEILING))


def to_int_yuan(v) -> int | None:
    """群控只收整数元。四舍五入（.5 进位），assembler 也用这个，两边取整口径一致。"""
    m = _money(v)
    if m is None:
        return None
    return int(m.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _sample_prices(raw) -> tuple[int | None, list[float]]:
    """从巡航台上报的 raw 里取 (有效挂牌条数, 有效挂牌价)。没有明细返回 (None, [])。

    巡航台 v0.2+ 上报 raw.priceBreakdown：validCount = 去掉 <100 元诱饵价、>10 万占位价后的条数，
    validPrices = 这些价（最多 60 个）。别的来源（OCR 成交价、旧爬虫最低价）没有这两项。
    """
    if not isinstance(raw, dict) or raw.get("source") != "cleaned_average":
        return None, []
    pb = raw.get("priceBreakdown")
    if not isinstance(pb, dict):
        return None, []
    prices = []
    for v in pb.get("validPrices") or []:
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f > 0:
            prices.append(f)
    count = pb.get("validCount")
    if isinstance(count, bool) or not isinstance(count, (int, float)):
        count = len(prices) if prices else None
    return (int(count) if count is not None else None), sorted(prices)


def sample_range(prices: list[float]) -> tuple[float, float] | None:
    """价差看的区间：去掉两头各一成（至少一个）后的 (最便宜, 最贵)。少于 5 条不去头尾。

    去头尾是为了一两条离谱挂牌不至于把整件货打回人工；中间八成还差一倍以上，均价就没法用了。
    """
    if len(prices) < 2:
        return None
    s = sorted(prices)
    if len(s) >= 5:
        cut = max(1, len(s) // 10)
        s = s[cut:-cut]
    return (s[0], s[-1]) if s[0] > 0 else None


def check_samples(raw, *, min_count: int, max_spread: float) -> tuple[str | None, str | None]:
    """返回 (原因码, 人话说明)；(None, None) = 样本没问题或判断不了（旧数据不误伤）。

    min_count / max_spread 填 0 = 不查这一项。
    """
    count, prices = _sample_prices(raw)
    if count is None:
        return None, None
    if min_count > 0 and count < min_count:
        return REASON_FEW_SAMPLES, f"行情样本太少：只搜到 {count} 条有效挂牌（要 {min_count} 条以上）"
    rng = sample_range(prices)
    if max_spread > 0 and rng is not None:
        low, high = rng
        if high / low > max_spread:
            return REASON_WIDE_SPREAD, (
                f"行情样本价差太大：挂牌从 {low:g} 到 {high:g} 元，差 {high / low:.1f} 倍（超过 {max_spread:g} 倍）"
            )
    return None, None
