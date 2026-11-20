"""商品详情页「价格历史 / 行情价」。

数据只用现有的，没有的渠道不编：
- 行情：闲鱼搜索的每日价（crawl_price，按款一天一个，**不分成色**），按 SPU 的「品牌 型号」对上监控清单；
- 在售：最近一次抓价时记下的闲鱼挂牌（raw.priceBreakdown.includedListings），成色从挂牌标题里认；
- 成交：我们自己同款货的出库价（sales_outbound），成色取那件货的。
京东、转转现在没有数据来源，不出。

by_grade（#108 行情图表用，11-11 加）：按页签（全部/全新/9新/8新/7新及以下）各给一条折线和一组统计，
前端切页签不用再请求。分成色的价是**当天抓到的挂牌里标题写了这个成色的**均价，不是成交价；
「全部」那条就是 crawl_price 的每日行情。统计按最后一天有数据的日子往前算 7 天（采集停了几天也照样有数，
as_of 告诉前端截至哪天）。

sentiment：闲鱼买家投票没有采集，这里按**日价格涨跌天数**算趋势比例（basis=price_trend），
接口和页面都明确了这个口径，不冒充买家投票。

item：从同一款（同一 SPU）的在售记录里挑一条带闲鱼商品 ID/链接的，作为「前往闲鱼」的
唯一入口；商品详情、行情、成交记录、闲鱼链接都以这个货号/SPU 为关联键。
"""
from datetime import date, timedelta
from statistics import mean, quantiles

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import (
    CrawlPrice, CrawlPriceRun, CrawlProduct, SalesOutbound, Sku, SkuListingInfo, Staff, WarehouseSpu,
)
from app.schemas._tz import utc_to_cn_iso
from app.schemas.market import PRICE_BASIS
from app.services.condition_slot import SLOT_LABEL, UNGRADED, grade_of, slot_of
from app.services.oss_media import thumb_url_for_cover
from app.services.spu_resolve import resolve_spu

router = APIRouter(prefix="/api/inventory", tags=["inventory"])

# 员工都能看（和商品详情页同一拨人）；设备账号不给
_staff = require_roles(
    StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.NEGOTIATOR, StaffRole.SALES, StaffRole.FINANCE,
)
MAX_RECORDS = 60
# 页签 → 认哪些成色槽（和商品详情页 PRICE_TABS 一一对应）；None = 全部
GRADE_TABS = {"all": None, "new": {"new"}, "9": {"9"}, "8": {"8"}, "7": {"7", "6"}}
STAT_DAYS = 7


def _money(v) -> float:
    return round(float(v), 2)


def _pct(now: float | None, before: float | None) -> float | None:
    if not now or not before:
        return None
    return round((now - before) / before * 100, 1)


def _market_product(db: Session, spu: WarehouseSpu | None, sku: Sku) -> CrawlProduct | None:
    names = [n for n in ((spu.brand_model if spu else None), sku.model) if n and n.strip()]
    for n in names:
        row = (
            db.query(CrawlProduct)
            .filter(or_(CrawlProduct.name == n.strip(), CrawlProduct.keyword == n.strip()))
            .first()
        )
        if row is not None:
            return row
    return None


def _same_spu_skus(db: Session, spu: WarehouseSpu | None, sku: Sku) -> list[Sku]:
    """同款的货（含已卖掉的）：按 69 码 / 型号凑，历史记录不必逐件跑 SPU 解析。"""
    conds = []
    if spu is not None:
        conds.append(func.lower(Sku.barcode) == spu.spu_code.lower())
        if spu.model:
            conds.append(func.lower(Sku.model) == spu.model.lower())
    else:
        if sku.barcode:
            conds.append(Sku.barcode == sku.barcode)
        if sku.model:
            conds.append(func.lower(Sku.model) == sku.model.lower())
    if not conds:
        return [sku]
    return db.query(Sku).filter(or_(*conds)).limit(2000).all()


def _xianyu_thumb(url) -> str | None:
    """闲鱼挂牌图 → 缩略图：http 换 https（页面是 https，不换会被拦）；阿里图床加 _220x220.jpg
    取小图（原图一两百 KB，缩略图 10KB 上下）。"""
    url = str(url or "").strip()
    if not url:
        return None
    if url.startswith("//"):
        url = "https:" + url
    elif url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    if "alicdn.com/" in url and "_220x220" not in url:
        url += "_220x220.jpg"
    return url


def _listing_prices(row: CrawlPrice) -> list[tuple[float, str]]:
    """这天抓到的挂牌 → [(价格, 成色槽)]，成色从标题认。"""
    out = []
    for it in (((row.raw or {}).get("priceBreakdown") or {}).get("includedListings")) or []:
        try:
            out.append((float(it.get("price")), slot_of(it.get("title"))))
        except (TypeError, ValueError):
            continue
    return out


def _band(prices: list[float]) -> tuple[float, float]:
    """常见价格区间：中间一半（去掉最便宜、最贵各四分之一）；样本太少就取最低到最高。"""
    if len(prices) < 4:
        return min(prices), max(prices)
    q1, _, q3 = quantiles(prices, n=4)
    return q1, q3


def _sentiment(series: list[dict]) -> dict:
    """按日价格涨跌天数算趋势比例；不是闲鱼买家投票，basis 明确写出来。"""
    pts = [p for p in (series or []) if p.get("price") is not None]
    ups = downs = flat = 0
    for prev, cur in zip(pts, pts[1:]):
        diff = float(cur["price"]) - float(prev["price"])
        if diff > 0:
            ups += 1
        elif diff < 0:
            downs += 1
        else:
            flat += 1
    total = ups + downs
    if total == 0:
        return {
            "up": 0, "down": 0, "flat": flat,
            "up_pct": None, "down_pct": None, "basis": "price_trend",
        }
    up_pct = round(ups / total * 100)
    return {
        "up": ups, "down": downs, "flat": flat,
        "up_pct": up_pct, "down_pct": 100 - up_pct, "basis": "price_trend",
    }


def _by_grade(rows: list[CrawlPrice], days: int) -> tuple[dict, str | None]:
    """按页签拆折线和统计。rows 按日期升序。"""
    empty = {k: {"series": [], "summary": None} for k in GRADE_TABS}
    if not rows:
        return empty, None
    as_of = rows[-1].crawl_date
    days_data = []  # (日期, {页签: [价格]}, 当天行情价)
    for r in rows:
        buckets = {k: [] for k in GRADE_TABS}
        for price, slot in _listing_prices(r):
            for k, slots in GRADE_TABS.items():
                if slots is None or slot in slots:
                    buckets[k].append(price)
        days_data.append((r.crawl_date, buckets, float(r.price)))

    def window(start: date, end: date):
        return [(d, b, p) for d, b, p in days_data if start <= d <= end]

    recent = window(as_of - timedelta(days=STAT_DAYS - 1), as_of)
    before = window(as_of - timedelta(days=2 * STAT_DAYS - 1), as_of - timedelta(days=STAT_DAYS))
    out = {}
    for k in GRADE_TABS:
        series = []
        for d, b, day_price in days_data:
            if d < as_of - timedelta(days=days):
                continue
            if k == "all":
                series.append({"date": d.isoformat(), "price": _money(day_price), "count": len(b[k])})
            elif b[k]:
                series.append({"date": d.isoformat(), "price": round(mean(b[k]), 2), "count": len(b[k])})

        def avg_of(part):
            if k == "all":
                vals = [p for _, _, p in part]
            else:
                vals = [x for _, b, _ in part for x in b[k]]
            return mean(vals) if vals else None

        listed = [x for _, b, _ in recent for x in b[k]]
        avg7 = avg_of(recent)
        summary = None
        if avg7 is not None:
            low, high = _band(listed) if listed else (avg7, avg7)
            summary = {
                "avg7": round(avg7, 2),
                "band": {"low": _money(low), "high": _money(high)},
                "change_pct": _pct(avg7, avg_of(before)),
                "listings": len(listed),
                "days": len([1 for _, b, _ in recent if k == "all" or b[k]]),
            }
        out[k] = {"series": series, "summary": summary, "sentiment": _sentiment(series)}
    return out, as_of.isoformat()


@router.get("/skus/{sku_code}/price-history", summary="商品详情：价格历史 / 行情价")
def price_history(
    sku_code: str,
    days: int = Query(180, ge=7, le=730, description="折线图取最近多少天"),
    db: Session = Depends(get_db),
    _: Staff = Depends(_staff),
):
    sku = db.query(Sku).filter(func.lower(Sku.sku_code) == sku_code.strip().lower()).first()
    if sku is None:
        raise HTTPException(status_code=404, detail="货号不存在")
    spu = resolve_spu(db, sku).spu
    product = _market_product(db, spu, sku)
    today = date.today()

    # ---- 行情（不分成色）
    rows: list[CrawlPrice] = []
    if product is not None:
        rows = (
            db.query(CrawlPrice)
            .filter(CrawlPrice.product_id == product.id)
            .order_by(CrawlPrice.crawl_date)
            .all()
        )
    series = [{"date": r.crawl_date.isoformat(), "price": _money(r.price)}
              for r in rows if r.crawl_date >= today - timedelta(days=days)]
    stats = None
    if rows:
        latest = rows[-1]
        month_ago = [r for r in rows if r.crawl_date <= latest.crawl_date - timedelta(days=30)]
        last30 = [float(r.price) for r in rows if r.crawl_date > today - timedelta(days=30)]
        prev30 = [float(r.price) for r in rows if today - timedelta(days=60) < r.crawl_date <= today - timedelta(days=30)]
        high = max(rows, key=lambda r: r.price)
        low = min(rows, key=lambda r: r.price)
        stats = {
            "latest": {"price": _money(latest.price), "date": latest.crawl_date.isoformat(),
                       "change_pct": _pct(float(latest.price), float(month_ago[-1].price) if month_ago else None)},
            "avg30": {"price": round(mean(last30), 2) if last30 else None,
                      "change_pct": _pct(mean(last30) if last30 else None, mean(prev30) if prev30 else None)},
            "high": {"price": _money(high.price), "date": high.crawl_date.isoformat()},
            "low": {"price": _money(low.price), "date": low.crawl_date.isoformat()},
            "points": len(rows),
        }

    records: list[dict] = []
    # ---- 在售：最近一次抓价时的闲鱼挂牌，成色从标题认
    if rows:
        latest = rows[-1]
        listings = (((latest.raw or {}).get("priceBreakdown") or {}).get("includedListings")) or []
        for it in listings:
            try:
                price = float(it.get("price"))
            except (TypeError, ValueError):
                continue
            key = slot_of(it.get("title"))
            records.append({
                "date": latest.crawl_date.isoformat(), "grade_key": key,
                "grade": SLOT_LABEL[key] if key != UNGRADED[0] else "",
                "channel": "闲鱼", "price": round(price, 2), "status": "在售",
                "title": (it.get("title") or "")[:60], "url": it.get("itemUrl") or "",
                # 11-11 起采集端才把挂牌图（picUrl）带上来，之前的数据没有图；list_price = 挂牌价
                "image": _xianyu_thumb(it.get("picUrl")), "list_price": round(price, 2), "sku_code": None,
                "item_id": str(it.get("itemId") or "") or None,
            })

    # ---- 成交：我们自己同款货的出库价
    peers = _same_spu_skus(db, spu, sku)
    by_id = {s.id: s for s in peers}
    infos = {
        i.sku_id: i for i in db.query(SkuListingInfo).filter(SkuListingInfo.sku_id.in_(list(by_id))).all()
    } if by_id else {}
    outs = (
        db.query(SalesOutbound)
        .filter(SalesOutbound.sku_id.in_(list(by_id)), SalesOutbound.sale_price > 0)
        .order_by(SalesOutbound.created_at.desc())
        .limit(MAX_RECORDS)
        .all()
    ) if by_id else []
    for o in outs:
        s = by_id[o.sku_id]
        grade = grade_of(s, infos.get(s.id))
        key = slot_of(grade)
        info = infos.get(s.id)
        records.append({
            "date": o.created_at.date().isoformat(), "grade_key": key, "grade": grade,
            "channel": "我们卖出", "price": _money(o.sale_price), "status": "成交",
            "title": s.product_name or "", "url": "",
            "image": thumb_url_for_cover(s.cover_url) if s.cover_url else None,
            "list_price": _money(info.price) if info is not None and info.price else None,
            "sku_code": s.sku_code, "item_id": None,
        })

    records.sort(key=lambda r: (r["date"], r["status"] == "成交"), reverse=True)
    by_grade, as_of = _by_grade(rows, days)
    # 同一款的一条在售闲鱼链接：商品详情/行情/记录/跳转都用这张卡上的货号+SPU 关联。
    # 有商品 ID 就够了（网页地址能拼出来）；没有 ID 时退而认 http 链接。
    def _openable(r: dict) -> bool:
        return bool(str(r.get("item_id") or "").strip()) or str(r.get("url") or "").startswith("http")

    primary = next((r for r in records if r.get("status") == "在售" and _openable(r)), None)
    item = None
    if primary is not None:
        item = {
            "item_id": primary.get("item_id"),
            "url": primary.get("url"),
            "title": primary.get("title"),
            "image": primary.get("image"),
            "list_price": primary.get("list_price"),
            "grade": primary.get("grade"),
        }
        if str(item["item_id"] or "").isdigit():
            item["web_url"] = f"https://www.goofish.com/item?id={item['item_id']}"
        elif str(item["url"] or "").startswith("http"):
            item["web_url"] = item["url"]
    return {
        "product_id": sku.sku_code,
        "spu": {"name": spu.brand_model} if spu is not None else None,
        "market_name": product.name if product is not None else None,
        "series": series,
        "stats": stats,
        "records": records[:MAX_RECORDS],
        "by_grade": by_grade,
        "as_of": as_of,
        "sentiment": (by_grade.get("all") or {}).get("sentiment"),
        "item": item,
        "sources": [
            "行情：闲鱼搜索的清洗后平均挂牌价，每天一次，按款不分成色",
            "在售：最近一次抓价时记下的闲鱼挂牌，成色按标题里写的认",
            "成交：我们自己同款货的出库价",
            "看涨/看跌：按所选时间段日价格涨跌天数计算，不是闲鱼买家投票",
        ],
    }


@router.get("/skus/{sku_code}/price-history/runs", summary="商品详情：行情逐次记录（同一天跑几次都在）")
def price_history_runs(
    sku_code: str,
    crawl_date: date | None = Query(None, description="只看这一天（中国日界）"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    _: Staff = Depends(_staff),
):
    """crawl_price 一天只留最后一次；这里列每一次上报（crawl_price_run，迁移 107 之后才有），新的在前。

    is_day_latest 标出哪一次是当天行情（= 价格历史折线上那个点）。
    """
    sku = db.query(Sku).filter(func.lower(Sku.sku_code) == sku_code.strip().lower()).first()
    if sku is None:
        raise HTTPException(status_code=404, detail="货号不存在")
    spu = resolve_spu(db, sku).spu
    product = _market_product(db, spu, sku)
    if product is None:
        return {"market_name": None, "items": [], "total": 0, "page": page, "page_size": page_size}

    query = db.query(CrawlPriceRun).filter(CrawlPriceRun.product_id == product.id)
    if crawl_date is not None:
        query = query.filter(CrawlPriceRun.crawl_date == crawl_date)
    total = query.count()
    rows = (
        query.order_by(CrawlPriceRun.crawled_at.desc(), CrawlPriceRun.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    # 每天最后一次就是 crawl_price 那条（_save_price 每次都覆盖当天）
    dates = {r.crawl_date for r in rows}
    day_latest: dict = {}
    if dates:
        for d, latest_at in (
            db.query(CrawlPriceRun.crawl_date, func.max(CrawlPriceRun.crawled_at))
            .filter(CrawlPriceRun.product_id == product.id, CrawlPriceRun.crawl_date.in_(dates))
            .group_by(CrawlPriceRun.crawl_date)
            .all()
        ):
            day_latest[d] = latest_at
    items = [{
        "id": r.id,
        "crawl_date": r.crawl_date.isoformat(),
        "crawled_at": utc_to_cn_iso(r.crawled_at),
        "price": _money(r.price),
        "price_basis": PRICE_BASIS.get(r.source) if r.source else None,
        "sample_count": r.sample_count,
        "trend_delta": _money(r.trend_delta) if r.trend_delta is not None else None,
        "search_heat": r.search_heat,
        "run_id": r.run_id,
        "device_id": r.device_id,
        "is_day_latest": day_latest.get(r.crawl_date) == r.crawled_at,
    } for r in rows]
    return {"market_name": product.name, "items": items, "total": total, "page": page, "page_size": page_size}
