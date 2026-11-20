"""行情样本太少 / 价差太大转人工（E04-10）：读开关和阈值，取这件货当前行情价背后的那次爬取。

判断规则在 pricing.check_samples（纯函数）；这里只管 app_setting 和查库。
开关默认关：打开前自动上架照旧只看有没有行情价、亏不亏。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import CrawlPrice, CrawlProduct
from app.services.app_settings import get_setting
from app.services.auto_listing.pricing import check_samples

ENABLED_KEY = "auto_listing_sample_check"   # "1" = 查
MIN_SAMPLES_KEY = "auto_listing_min_samples"
MAX_SPREAD_KEY = "auto_listing_max_spread"

# 有效挂牌少于 5 条不信均价：巡航台一页通常二三十条，清洗完只剩三四条多半是搜偏了或冷门型号。
DEFAULT_MIN_SAMPLES = 5
# 去掉两头各一成后，最贵超过最便宜 2 倍不信均价：同型号正常成色差价到不了一倍，
# 超过多半混进了别的容量 / 配件 / 坏机，均价会把好货挂低或把差货挂高。
DEFAULT_MAX_SPREAD = 2.0


def enabled(db: Session) -> bool:
    return get_setting(db, ENABLED_KEY, "") == "1"


def thresholds(db: Session) -> tuple[int, float]:
    """(最少样本数, 最大价差倍数)。没填或填坏了用默认；填 0 = 不查这一项。"""
    try:
        min_count = int(get_setting(db, MIN_SAMPLES_KEY, "") or DEFAULT_MIN_SAMPLES)
    except ValueError:
        min_count = DEFAULT_MIN_SAMPLES
    try:
        max_spread = float(get_setting(db, MAX_SPREAD_KEY, "") or DEFAULT_MAX_SPREAD)
    except ValueError:
        max_spread = DEFAULT_MAX_SPREAD
    return max(min_count, 0), max(max_spread, 0.0)


def latest_raw(db: Session, query: str | None) -> dict | None:
    """market_price_for 拿的那个价（CrawlProduct.last_price）是哪天爬的，就取那天那条的 raw。"""
    q = (query or "").strip()
    if not q:
        return None
    product = (
        db.query(CrawlProduct)
        .filter((CrawlProduct.name == q) | (CrawlProduct.keyword == q))
        .first()
    )
    if not product or product.last_price_date is None:
        return None
    rec = (
        db.query(CrawlPrice)
        .filter(CrawlPrice.product_id == product.id, CrawlPrice.crawl_date == product.last_price_date)
        .first()
    )
    return rec.raw if rec else None


def sample_problem(db: Session, query: str | None) -> tuple[str | None, str | None]:
    """(原因码, 人话说明)；没开、没问题、或判断不了都返回 (None, None)。"""
    if not enabled(db):
        return None, None
    min_count, max_spread = thresholds(db)
    return check_samples(latest_raw(db, query), min_count=min_count, max_spread=max_spread)
