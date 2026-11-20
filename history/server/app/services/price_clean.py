"""步入式价格清洗（P0，11-13）：原始样本 → 筛选 → 价格类型 → 异常 → 有效价 → 人工确认 → 版本生效 → 复盘。

口径（用户 11-13 定，按我给的默认值）：
- 同条件行情取**中位数**（均价会被高价挂单拉高）；
- 低于 100 元算诱饵价只对 3C 生效，其他品类（票券、书、光碟、配件…）不设；
- 闲鱼「已售」不当成交价，只算「已售挂牌价」；没有成交证据就没有成交价；
- 行情超过 **7 天**算旧，过期的价不能用；
- 只有**管理员**能让价格版本生效。

样本来自行情采集（crawl_price.raw.candidates，一次采集一个型号第一页的真实卡片），按闲鱼商品 ID 去重；
原页快照在执行端电脑上，这里记路径。剔除都写原因，不静默丢样本；系统剔的人可以恢复，人剔的要写原因。
这一版清洗价只给人看（商品页、上架审批参考），不改自动上架和焕新的定价。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from statistics import median

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.enums import StaffRole
from app.models import CrawlPrice, CrawlProduct, PriceCleanTask, PriceSample, PriceVersion, Sku, Staff
from app.services.auto_listing.pricing import floor_price, to_int_yuan

BAIT_MIN = Decimal("100")
FRESH_DAYS = 7
MIN_SAMPLES = 3
OUTLIER_RATIO = 2
HIGH_MULTIPLE = 5
NOTE_MIN = 4
# 这些品类正常就会低于 100 元，诱饵价门槛不适用（其余按 3C 算）
NON_3C_WORDS = ("券", "票", "书", "光碟", "CD", "配件", "服务")
# 标题里有这些字的不是同一件东西（配件、维修、租赁、求购、回收、坏件）
REJECT_WORDS = ("配件", "维修", "出租", "租赁", "求购", "回收", "收购", "故障", "拆机", "空盒", "包装盒", "坏了", "不开机")

PRICE_TYPES = {
    "LISTING": "挂牌价",
    "SOLD_LISTING": "已售挂牌价",
    "NEW": "新品价",
    "RECYCLE": "回收价",
    "AUCTION": "拍卖价",
}
# 算销售有效价只用挂牌类；回收价不能代替销售价
SALE_TYPES = ("LISTING", "SOLD_LISTING")
CONFIDENCE_LABEL = {"high": "高", "mid": "中", "low": "低"}
STATUS_LABEL = {"PENDING": "待生效", "ACTIVE": "生效中", "SUPERSEDED": "已替换", "REJECTED": "已退回", "EXPIRED": "已过期"}
CN = timedelta(hours=8)


def _today() -> date:
    return (datetime.utcnow() + CN).date()


def is_3c(sku: Sku) -> bool:
    pt = sku.product_type or ""
    return not any(w in pt for w in NON_3C_WORDS)


def _market_product(db: Session, sku: Sku) -> tuple[CrawlProduct | None, str | None]:
    from app.services.spu_resolve import resolve_spu

    match = resolve_spu(db, sku)
    query = (match.query or "").strip() if match.matched else ""
    if not query:
        return None, None
    product = db.query(CrawlProduct).filter((CrawlProduct.name == query) | (CrawlProduct.keyword == query)).first()
    return product, query


# ---------------------------------------------------------------- 1~3 入口、样本、筛选

def start(db: Session, sku: Sku, user: Staff) -> PriceCleanTask:
    """开始一次清洗：带上最近一次采集的全部样本，按规则先筛一遍。"""
    missing = [n for n, ok in (("型号", bool(sku.model)), ("成本", bool(sku.cost_price))) if not ok]
    if missing:
        raise HTTPException(status_code=400, detail=f"还缺{'、'.join(missing)}，补齐了才能清洗价格")
    product, query = _market_product(db, sku)
    if product is None:
        raise HTTPException(status_code=400, detail="这个型号还没进行情采集清单，没有样本可洗（先在行情看板加上这个型号）")
    latest = (
        db.query(CrawlPrice).filter(CrawlPrice.product_id == product.id).order_by(CrawlPrice.crawl_date.desc()).first()
    )
    raw = (latest.raw or {}) if latest else {}
    candidates = raw.get("candidates") or []
    if not candidates:
        raise HTTPException(status_code=400, detail="这个型号最近一次采集没有留下样本明细，等下次采集")
    snaps = {e.get("query"): e.get("path") for e in raw.get("snapshotEntries") or [] if isinstance(e, dict)}
    blacklist = [w for w in raw.get("blacklistKeywords") or [] if isinstance(w, str) and w]

    # 重新开始：这件货还没出版本的旧清洗作废（留着能回查），同一时间只有一次在洗
    for old in db.query(PriceCleanTask).filter(PriceCleanTask.sku_id == sku.id, PriceCleanTask.status == "OPEN"):
        old.status = "DROPPED"
    task = PriceCleanTask(sku_id=sku.id, crawl_product_id=product.id, crawl_price_id=latest.id,
                          crawl_date=latest.crawl_date, query=query, started_by=user.id)
    db.add(task)
    db.flush()
    seen: set[str] = set()
    bait = is_3c(sku)
    for c in candidates:
        try:
            price = Decimal(str(c.get("price")))
        except Exception:  # noqa: BLE001
            continue
        item_id = str(c.get("itemId") or "") or None
        if item_id and item_id in seen:
            continue
        if item_id:
            seen.add(item_id)
        title = (c.get("title") or "")[:512]
        s = PriceSample(task_id=task.id, item_id=item_id, title=title, price=price, query=c.get("query"),
                        item_url=(c.get("itemUrl") or "")[:1024] or None, snapshot_path=snaps.get(c.get("query")),
                        price_type="SOLD_LISTING" if "已售" in title else "LISTING")
        word = next((w for w in (*REJECT_WORDS, *blacklist) if w in title), None)
        if bait and price < BAIT_MIN:
            s.kept, s.reject_reason = False, f"低于 {int(BAIT_MIN)} 元诱饵价"
        elif word:
            s.kept, s.reject_reason = False, f"标题有「{word}」，不是同一件东西"
        db.add(s)
    db.flush()
    _mark_outliers(db, task)
    return task


def _mark_outliers(db: Session, task: PriceCleanTask) -> None:
    """离群：偏离中位数一倍以上（高于 2 倍或低于一半）的挂牌价标出来、默认不算；人可以恢复。

    用中位数倍数不用四分位：一个型号常常只有几条样本，四分位一少就失灵（9999 会把上四分位拉上去）。
    """
    rows = db.query(PriceSample).filter(PriceSample.task_id == task.id).all()
    # 参与判离群的：留着的挂牌价 + 之前被系统判成离群的（重判一遍）；人手改过的不动
    pool = [r for r in rows if r.price_type in SALE_TYPES and (r.kept or (r.outlier and r.auto))]
    if len(pool) < 3:
        return
    mid = median(float(r.price) for r in pool)
    for r in pool:
        if not r.auto:
            continue
        far = float(r.price) > mid * OUTLIER_RATIO or float(r.price) < mid / OUTLIER_RATIO
        if far:
            r.outlier, r.kept, r.reject_reason = True, False, "离群价（偏离中位数一倍以上）"
        elif r.outlier:
            r.outlier, r.kept, r.reject_reason = False, True, None


def edit_sample(db: Session, task: PriceCleanTask, sample: PriceSample, user: Staff, *,
                kept: bool | None = None, reason: str | None = None, price_type: str | None = None) -> None:
    """人改样本：剔除要写原因；改类型只能在五种里选。改过的不再被系统重判。"""
    if task.status != "OPEN":
        raise HTTPException(status_code=400, detail="这次清洗已经出了版本，要改请重新开始清洗")
    if price_type is not None:
        if price_type not in PRICE_TYPES:
            raise HTTPException(status_code=400, detail="价格类型不对")
        sample.price_type = price_type
    if kept is not None:
        if not kept and len((reason or "").strip()) < 2:
            raise HTTPException(status_code=400, detail="剔除要写原因")
        sample.kept = kept
        sample.outlier = False
        sample.reject_reason = None if kept else (reason or "").strip()[:128]
    sample.auto = False
    sample.edited_by = user.id
    db.flush()
    _mark_outliers(db, task)


# ---------------------------------------------------------------- 5~6 异常、有效价

def effective(db: Session, task: PriceCleanTask) -> dict:
    rows = db.query(PriceSample).filter(PriceSample.task_id == task.id).all()
    valid = sorted(float(r.price) for r in rows if r.kept and r.price_type in SALE_TYPES)
    n = len(valid)
    conf = "high" if n >= 8 else "mid" if n >= 4 else "low"
    out = {
        "count": n,
        "total": len(rows),
        "rejected": sum(1 for r in rows if not r.kept),
        "median": to_int_yuan(Decimal(str(median(valid)))) if n else None,
        "low": int(valid[0]) if n else None,
        "high": int(valid[-1]) if n else None,
        "confidence": conf if n else None,
        "confidence_label": CONFIDENCE_LABEL.get(conf) if n else None,
        "enough": n >= MIN_SAMPLES,
        "method": "中位数",
        "other_types": {PRICE_TYPES[t]: sum(1 for r in rows if r.kept and r.price_type == t)
                        for t in PRICE_TYPES if t not in SALE_TYPES
                        and any(r.kept and r.price_type == t for r in rows)},
    }
    if not out["enough"]:
        out["blocker"] = f"留下的挂牌样本只有 {n} 条，少于 {MIN_SAMPLES} 条不能出价，等下次采集或恢复误剔的"
    return out


def stale(crawl_date: date | None) -> bool:
    return crawl_date is None or (_today() - crawl_date).days > FRESH_DAYS


# ---------------------------------------------------------------- 7~8 确认、生效

def confirm(db: Session, sku: Sku, task: PriceCleanTask, user: Staff, *, price, note: str | None) -> PriceVersion:
    """人工确认出一个待生效版本。价不等于中位数要写依据；低于成本线也能确认（行情跌破成本的老库存正要记下来），
    要写依据、交管理员生效；高于成本 5 倍只提醒。这件货之前还没生效的版本作废（不然管理员先生效新的再生效旧的，旧价顶掉新价）。"""
    from app.services import listing_approval as la

    if task.status != "OPEN":
        raise HTTPException(status_code=400, detail="这次清洗已经出了版本")
    if stale(task.crawl_date):
        raise HTTPException(status_code=400, detail=f"样本是 {task.crawl_date} 采的，超过 {FRESH_DAYS} 天算旧，等重新采集后再清洗")
    eff = effective(db, task)
    if not eff["enough"]:
        raise HTTPException(status_code=400, detail=eff["blocker"])
    p = to_int_yuan(price)
    if not p or p <= 0:
        raise HTTPException(status_code=400, detail="填一个整数价")
    note = (note or "").strip() or None
    floor = floor_price(sku.cost_price, la.min_cost_ratio(db))
    if floor is not None and p < floor and len(note or "") < NOTE_MIN:
        raise HTTPException(status_code=400, detail=f"低于成本线 {floor} 元，写清依据（至少 {NOTE_MIN} 个字）再交管理员")
    if p != eff["median"] and len(note or "") < NOTE_MIN:
        raise HTTPException(status_code=400, detail=f"确认价和有效价（中位数 {eff['median']}）不一样，要写依据（至少 {NOTE_MIN} 个字）")
    for old in db.query(PriceVersion).filter(PriceVersion.sku_id == sku.id, PriceVersion.status == "PENDING"):
        old.status = "SUPERSEDED"
        old.review_note = old.review_note or "有了更新的确认价"
    last = db.query(PriceVersion).filter(PriceVersion.sku_id == sku.id).order_by(PriceVersion.version.desc()).first()
    v = PriceVersion(
        sku_id=sku.id, task_id=task.id, version=(last.version + 1) if last else 1, status="PENDING",
        price=Decimal(p), median=Decimal(eff["median"]), low=Decimal(eff["low"]), high=Decimal(eff["high"]),
        sample_count=eff["count"], confidence=eff["confidence"], crawl_date=task.crawl_date,
        expires_on=task.crawl_date + timedelta(days=FRESH_DAYS) if task.crawl_date else None,
        note=note, confirmed_by=user.id, confirmed_at=datetime.utcnow(),
    )
    db.add(v)
    task.status = "DONE"
    db.flush()
    return v


def review(db: Session, v: PriceVersion, user: Staff, *, approve: bool, note: str | None) -> PriceVersion:
    """管理员让版本生效（旧的生效版本改为已替换，留着能回查）或退回（写原因）。"""
    if user.role != StaffRole.ADMIN:
        raise HTTPException(status_code=403, detail="价格版本只有管理员能生效")
    if v.status != "PENDING":
        raise HTTPException(status_code=400, detail="只有待生效的版本能处理")
    note = (note or "").strip() or None
    if approve:
        if v.expires_on and v.expires_on < _today():
            raise HTTPException(status_code=400, detail="这个版本的行情已经过期，退回去重新清洗")
        newer = current(db, v.sku_id)
        if newer is not None and newer.version > v.version:
            raise HTTPException(status_code=400, detail=f"已经有更新的 v{newer.version} 在用，这个旧版本退回就行")
        for old in db.query(PriceVersion).filter(PriceVersion.sku_id == v.sku_id, PriceVersion.status == "ACTIVE"):
            old.status = "SUPERSEDED"
        v.status = "ACTIVE"
    else:
        if not note:
            raise HTTPException(status_code=400, detail="退回要写原因")
        v.status = "REJECTED"
    v.activated_by, v.activated_at, v.review_note = user.id, datetime.utcnow(), note
    db.flush()
    return v


def current(db: Session, sku_id: str) -> PriceVersion | None:
    return db.query(PriceVersion).filter(PriceVersion.sku_id == sku_id, PriceVersion.status == "ACTIVE").first()


def version_out(v: PriceVersion | None, names: dict[str, str] | None = None) -> dict | None:
    if v is None:
        return None
    names = names or {}
    expired = bool(v.expires_on and v.expires_on < _today())
    status = "EXPIRED" if expired and v.status in ("ACTIVE", "PENDING") else v.status
    return {
        "id": v.id,
        "version": v.version,
        "status": status,
        "status_label": STATUS_LABEL[status],
        "usable": status == "ACTIVE",
        # 还没处理的（过期了也算）：管理员要能退回，不然待办里一直挂着、按钮却没了
        "pending": v.status == "PENDING",
        "price": int(v.price),
        "median": int(v.median) if v.median is not None else None,
        "low": int(v.low) if v.low is not None else None,
        "high": int(v.high) if v.high is not None else None,
        "sample_count": v.sample_count,
        "confidence_label": CONFIDENCE_LABEL.get(v.confidence or ""),
        "crawl_date": v.crawl_date.isoformat() if v.crawl_date else None,
        "expires_on": v.expires_on.isoformat() if v.expires_on else None,
        "note": v.note,
        "confirmed_by_name": names.get(v.confirmed_by),
        "activated_by_name": names.get(v.activated_by),
        "review_note": v.review_note,
    }


# ---------------------------------------------------------------- 页面数据

def latest_task(db: Session, sku_id: str) -> PriceCleanTask | None:
    """正在洗的那次优先，没有就最近一次（同一秒开的两次靠状态分得开）。"""
    q = db.query(PriceCleanTask).filter(PriceCleanTask.sku_id == sku_id)
    return (q.filter(PriceCleanTask.status == "OPEN").order_by(PriceCleanTask.created_at.desc()).first()
            or q.filter(PriceCleanTask.status != "DROPPED").order_by(PriceCleanTask.created_at.desc()).first())


def page(db: Session, sku: Sku, user: Staff) -> dict:
    from app.services import listing_approval as la
    from app.services.staff_lookup import map_staff_names

    task = latest_task(db, sku.id)
    versions = db.query(PriceVersion).filter(PriceVersion.sku_id == sku.id).order_by(PriceVersion.version.desc()).all()
    names = map_staff_names(db, {x for v in versions for x in (v.confirmed_by, v.activated_by) if x})
    product, query = _market_product(db, sku)
    latest_date = None
    if product is not None:
        row = db.query(CrawlPrice.crawl_date).filter(CrawlPrice.product_id == product.id).order_by(CrawlPrice.crawl_date.desc()).first()
        latest_date = row[0] if row else None
    floor = floor_price(sku.cost_price, la.min_cost_ratio(db))
    missing = [n for n, ok in (("型号", bool(sku.model)), ("成本", bool(sku.cost_price))) if not ok]
    out = {
        "sku": {"sku_code": sku.sku_code, "product_name": sku.product_name, "model": sku.model,
                "cost_price": None if sku.cost_price is None else str(sku.cost_price), "is_3c": is_3c(sku)},
        "floor_price": floor,
        "high_multiple": HIGH_MULTIPLE,
        "fresh_days": FRESH_DAYS,
        "query": query,
        "latest_crawl_date": latest_date.isoformat() if latest_date else None,
        "latest_stale": stale(latest_date),
        "can_start": not missing and product is not None,
        "start_blocker": (f"还缺{'、'.join(missing)}" if missing else
                          None if product is not None else "这个型号还没进行情采集清单"),
        "can_activate": user.role == StaffRole.ADMIN,
        "price_types": [{"key": k, "label": v, "sale": k in SALE_TYPES} for k, v in PRICE_TYPES.items()],
        "task": None,
        "current": version_out(current(db, sku.id), names),
        "versions": [version_out(v, names) for v in versions],
    }
    if task is not None:
        samples = db.query(PriceSample).filter(PriceSample.task_id == task.id).order_by(PriceSample.price).all()
        out["task"] = {
            "id": task.id,
            "status": task.status,
            "crawl_date": task.crawl_date.isoformat() if task.crawl_date else None,
            "stale": stale(task.crawl_date),
            "query": task.query,
            "effective": effective(db, task),
            "samples": [{
                "id": s.id, "price": int(s.price), "title": s.title, "item_id": s.item_id, "item_url": s.item_url,
                "snapshot_path": s.snapshot_path, "price_type": s.price_type, "price_type_label": PRICE_TYPES[s.price_type],
                "kept": s.kept, "reject_reason": s.reject_reason, "outlier": s.outlier, "auto": s.auto,
            } for s in samples],
        }
    return out
