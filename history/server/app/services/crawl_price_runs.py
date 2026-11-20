"""行情逐次记录（crawl_price_run，F01-06）。

每次上报追加一条，不改不删；crawl_price 照旧一天一条当「当天最新」。

这一次属于哪一轮：端上现在的上报里不带轮次号（raw 里没有），所以按这个顺序认——
  1. raw 里写明了 erp_run_id / local_run_id 的，按它对 market_crawl_run（留给以后端上补带）；
  2. 否则看此刻有没有**正好一轮**在跑（24 小时内开始的 RUNNING）。爬虫租约保证同一时刻
     只有一台在跑，所以正好一轮就是它；有两轮以上（多半是哪轮崩了没上报结束）认不准，宁可空着。
设备号跟着认出来的那一轮走，raw 里写明了 device_id 的优先。
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.models import CrawlPriceRun
from app.models.workbench import CrawlRunStatus, MarketCrawlRun

# 认「正在跑的那一轮」只看这么久以内开始的，再老的 RUNNING 多半是端上崩了没报结束
_ACTIVE_RUN_WINDOW = timedelta(hours=24)

# raw 里只抄这几项小字段进 summary；挂牌明细、快照路径、决策表都不复制（见模型注释）
_SUMMARY_KEYS = (
    "source", "keywords", "account", "average", "lowest", "median",
    "cards", "uniqueCards", "deduped", "dropped_bait", "dropped_below_minimum",
)
_BREAKDOWN_KEYS = ("validCount", "allCandidateCount", "rejectedBelow100Count", "rejectedOverMaximumCount")


def _str_or_none(v, limit: int) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s[:limit] or None


def sample_count(raw: dict | None) -> int | None:
    """算这个价用了几条挂牌：清洗后进均价的条数，没有就退到去重后的卡片数。"""
    raw = raw or {}
    breakdown = raw.get("priceBreakdown") or {}
    for v in (breakdown.get("validCount"), raw.get("uniqueCards"), raw.get("cards")):
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            return int(v)
    return None


def summarize(raw: dict | None) -> dict | None:
    if not isinstance(raw, dict):
        return None
    out = {k: raw[k] for k in _SUMMARY_KEYS if raw.get(k) is not None}
    if isinstance(out.get("keywords"), list):
        out["keywords"] = out["keywords"][:10]
    breakdown = raw.get("priceBreakdown")
    if isinstance(breakdown, dict):
        counts = {k: breakdown[k] for k in _BREAKDOWN_KEYS if breakdown.get(k) is not None}
        if counts:
            out["breakdown"] = counts
    parsed = raw.get("parsed")  # OCR 那条识别出来的字段
    if isinstance(parsed, dict):
        out["parsed"] = parsed
    return out or None


def _resolve_run(db: Session, raw: dict, now: datetime) -> MarketCrawlRun | None:
    erp_run_id = _str_or_none(raw.get("erp_run_id"), 36)
    if erp_run_id:
        row = db.get(MarketCrawlRun, erp_run_id)
        if row is not None:
            return row
    local_run_id = _str_or_none(raw.get("local_run_id"), 64)
    if local_run_id:
        row = (
            db.query(MarketCrawlRun)
            .filter(MarketCrawlRun.local_run_id == local_run_id)
            .order_by(MarketCrawlRun.created_at.desc())
            .first()
        )
        if row is not None:
            return row
    running = (
        db.query(MarketCrawlRun)
        .filter(MarketCrawlRun.status == CrawlRunStatus.RUNNING,
                MarketCrawlRun.started_at >= now - _ACTIVE_RUN_WINDOW)
        .limit(2)
        .all()
    )
    return running[0] if len(running) == 1 else None


def build_run(
    db: Session, *, product_id: str, crawl_date, price, trend_delta, search_heat, raw: dict | None,
    uploader_id: str | None, crawl_price_id: str | None, now: datetime | None = None,
) -> CrawlPriceRun:
    """拼一条逐次记录（不 add、不 commit，由调用方和 crawl_price 一起提交）。"""
    now = now or datetime.utcnow()
    raw_d = raw if isinstance(raw, dict) else {}
    run = _resolve_run(db, raw_d, now)
    return CrawlPriceRun(
        product_id=product_id,
        crawl_date=crawl_date,
        crawled_at=now,
        price=price,
        trend_delta=trend_delta,
        search_heat=search_heat,
        source=_str_or_none(raw_d.get("source"), 32),
        sample_count=sample_count(raw_d),
        run_id=run.id if run is not None else None,
        local_run_id=_str_or_none(raw_d.get("local_run_id"), 64) or (run.local_run_id if run is not None else None),
        device_id=_str_or_none(raw_d.get("device_id"), 64) or (run.device_id if run is not None else None),
        uploader_id=uploader_id,
        crawl_price_id=crawl_price_id,
        summary=summarize(raw_d),
    )
