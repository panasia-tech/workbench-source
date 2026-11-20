"""销售工作台「库存商品」：一屏看清所有在库的货，哪些现在要动手、哪些在等、哪些正常（11-13 对齐销售工作台交付包）。

每件货把它身上的问题都列出来，卡片颜色取最严重的那条：红 = 现在动手，黄 = 注意 / 今天做，绿 = 不用管。
颜色只表达这一件事，不拿来表示在架、在库这些状态。规矩不另写，都调现成的口径：
- 上架审批：listing_approval.list_tasks 的待清洗 / 待审批 / 在架待整改（开关开着才算）；
- 库存缺口：stock_gaps.collect 里「要人补」的（系统自己在等的不算）；
- 库龄：stock_age（该清仓黄、滞销红，三条线在管理端改）；
- 卖出没发：和「今天」同一个 17:00 发货时限（sales_workbench._ship_level）；
- 行情涨跌（11-14，交付包 I9）：这款最近两次抓到的行情价比，涨跌超 10% 要销售核价（黄），超 20% 红；
  最近一次超过 7 天的不报（采集停了，旧数不催人），卡片上照样标着；
- 同款图池（交付包 I10）：这款的搜图状态（product_image 的 SpuImageSearch），页头按款数汇总。
图只用实拍，绝不用封面（Sku.cover_url 里有过买家订单截图）。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.enums import ReserveSource, ShopListingStatus, SkuStatus, StaffRole
from app.models import SaleShop, Sku, SkuShopListing, Staff
from app.services import listing_approval as la
from app.services import stock_age as sa
from app.services import stock_gaps as sg
from app.services.oss_media import sign_oss_thumb_url

LEVEL_ORDER = {"red": 0, "yellow": 1, "green": 2}
# 链接焕新满 7 天没卖删掉重发，库龄按这个周期数（卡片上「第 2 周期 · 13 天」）
CYCLE_DAYS = 7
LEVEL_LABEL = {"red": "要处理", "yellow": "注意", "green": "正常"}
DETAIL_URL = "/pages/warehouse/detail/index?code={code}"
ITEM_URL = "/pages/sales-goods/item/index?code={code}"
PUBLISH_URL = "/pages/listing/publish/index?code={code}"
APPROVAL_URL = "/pages/listing/approvals/detail/index?code={code}"
SHOP_OFF_URL = "/pages/warehouse/shop-off/index?code={code}"
MANUAL_SALE_URL = "/pages/sales/manual-sale/index?code={code}"


def _approval_tags(db: Session, user: Staff, keyword: str | None = None) -> dict[str, dict]:
    """sku_code → {todo, review, fix, approved, shops}，照上架审批任务列表算（开关关着不算）。"""
    if not la.approval_required(db):
        return {}
    from app.routers import listing_approval as R

    res = R.list_tasks(state="all", keyword=keyword, page=1, size=100000, db=db, user=user)
    out = {}
    for it in res["items"]:
        cells = list(it["cells"].values())
        out[it["sku_code"]] = {
            "todo": sum(c["state"] in ("NONE", "DRAFT", "REJECTED", "STALE") for c in cells),
            "review": sum(c["state"] == "SUBMITTED" for c in cells),
            "fix": sum(bool(c["needs_fix"]) for c in cells),
            "approved": sum(c["state"] == "APPROVED" for c in cells),
            "shops": len(cells),
        }
    return out


TREND_ALERT_PCT = 10
TREND_RED_PCT = 20
TREND_FRESH_DAYS = 7
POOL_LABEL = {"READY": "可用", "REVIEWING": "等审核", "SEARCHING": "搜图中", "FAILED": "没搜到", "REJECTED": "审核没过"}


def _market_and_pool(db: Session, skus: list[Sku], today: date) -> tuple[dict, dict, dict]:
    """(sku_id → 行情涨跌, sku_id → 图池状态, 页头图池汇总)。整批一次查完，不逐件解析。"""
    from app.models import CrawlPrice, CrawlProduct, SpuImageSearch
    from app.services.spu_resolve import resolve_many

    spu_of = resolve_many(db, skus)
    # 行情：和商品详情「价格历史」一样，先拿 SPU 的「品牌 型号」、再拿货上的型号去对监控清单
    names_of = {s.id: [n.strip() for n in ((spu_of[s.id].brand_model if spu_of[s.id] else None), s.model) if n and n.strip()]
                for s in skus}
    names = {n for ns in names_of.values() for n in ns}
    prod_by_name: dict[str, str] = {}
    if names:
        for p in db.query(CrawlProduct.id, CrawlProduct.name, CrawlProduct.keyword).filter(
            CrawlProduct.name.in_(names) | CrawlProduct.keyword.in_(names)
        ):
            for k in (p.name, p.keyword):
                if k:
                    prod_by_name.setdefault(k.strip(), p.id)
    pids = set(prod_by_name.values())
    last2: dict[str, list] = {}
    if pids:
        for r in db.query(CrawlPrice.product_id, CrawlPrice.crawl_date, CrawlPrice.price).filter(
            CrawlPrice.product_id.in_(pids)
        ).order_by(CrawlPrice.crawl_date.desc()):
            if len(last2.setdefault(r.product_id, [])) < 2:
                last2[r.product_id].append(r)
    trend = {}
    for s in skus:
        pid = next((prod_by_name[n] for n in names_of[s.id] if n in prod_by_name), None)
        pts = last2.get(pid) or []
        if len(pts) < 2 or not pts[1].price:
            continue
        pct = round((float(pts[0].price) - float(pts[1].price)) / float(pts[1].price) * 100)
        fresh = (today - pts[0].crawl_date).days <= TREND_FRESH_DAYS
        lv = "red" if abs(pct) >= TREND_RED_PCT else "yellow" if abs(pct) >= TREND_ALERT_PCT else None
        trend[s.id] = {"pct": pct, "date": f"{pts[0].crawl_date:%m-%d}", "level": lv, "fresh": fresh}

    # 图池：这款搜过图没有、到哪一步了
    spu_ids = {sp.id for sp in spu_of.values() if sp}
    st_of = dict(db.query(SpuImageSearch.spu_id, SpuImageSearch.status).filter(SpuImageSearch.spu_id.in_(spu_ids))) \
        if spu_ids else {}
    pool, models = {}, {}
    for s in skus:
        sp = spu_of[s.id]
        key = (st_of.get(sp.id) or "NONE") if sp else "NOSPU"
        pool[s.id] = key
        models.setdefault(key, set()).add(sp.id if sp else s.model or s.id)
    summary = {k: len(v) for k, v in models.items()}
    return trend, pool, summary


def _issue(level: str, text: str, url: str) -> dict:
    return {"level": level, "text": text, "url": url}


def build(db: Session, user: Staff, *, level: str | None = None, q: str | None = None,
          now: datetime | None = None, code: str | None = None) -> dict:
    from app.services.sales_workbench import _ship_level

    now = now or datetime.utcnow()
    query = db.query(Sku).filter(Sku.status.in_((SkuStatus.IN_STOCK, SkuStatus.RESERVED)))
    if code:
        query = query.filter(Sku.sku_code == code)
    elif q and q.strip():
        like = f"%{q.strip()}%"
        query = query.filter(Sku.sku_code.like(like) | Sku.product_name.like(like) | Sku.brand.like(like))
    skus = query.all()
    ids = [s.id for s in skus]

    shop_total = db.query(SaleShop).filter(SaleShop.enabled.is_(True), SaleShop.gc_account_id.isnot(None)).count()
    by_status: dict[str, dict[str, int]] = {}
    idle_listed: dict[str, int] = {}
    sold_at: dict[str, datetime] = {}
    if ids:
        for sku_id, st, n in (
            db.query(SkuShopListing.sku_id, SkuShopListing.publish_status, func.count(SkuShopListing.id))
            .filter(SkuShopListing.sku_id.in_(ids))
            .group_by(SkuShopListing.sku_id, SkuShopListing.publish_status)
        ):
            by_status.setdefault(sku_id, {})[st] = n
        # 在架、又没在下架途中的（下架作业排着时行上带作业号；设备离线能排 12 小时）
        idle_listed = dict(
            db.query(SkuShopListing.sku_id, func.count(SkuShopListing.id))
            .filter(SkuShopListing.sku_id.in_(ids), SkuShopListing.publish_status == ShopListingStatus.LISTED,
                    SkuShopListing.gc_job_id.is_(None))
            .group_by(SkuShopListing.sku_id)
        )
        sold_at = dict(
            db.query(SkuShopListing.sku_id, func.max(SkuShopListing.sold_at))
            .filter(SkuShopListing.sku_id.in_(ids), SkuShopListing.sold_at.isnot(None))
            .group_by(SkuShopListing.sku_id)
        )
    approvals = _approval_tags(db, user, keyword=code)
    from app.models import PurchaseOrder
    from app.services.asset_intake import PO_PREFIX

    po_ids = {s.purchase_order_id for s in skus}
    asset_pos = {
        pid for (pid,) in db.query(PurchaseOrder.id).filter(PurchaseOrder.id.in_(po_ids),
                                                             PurchaseOrder.order_no.like(f"{PO_PREFIX}%"))
    } if po_ids else set()
    gaps = {g["sku_code"]: g for g in sg.collect(db, role=str(user.role)) if not g["waiting"]}
    thresholds = sa.get_thresholds(db)
    trend, pool, pool_summary = _market_and_pool(db, skus, (now + timedelta(hours=8)).date())

    cards, counts = [], {"red": 0, "yellow": 0, "green": 0}
    for sku in skus:
        code = sku.sku_code
        st = by_status.get(sku.id, {})
        listed = st.get(ShopListingStatus.LISTED, 0)
        issues: list[dict] = []
        if sku.status == SkuStatus.RESERVED and sku.reserve_source == ReserveSource.PLATFORM_SOLD:
            lv, sub = _ship_level(sold_at.get(sku.id), now)
            issues.append(_issue(lv, f"卖出了还没发：{sub}", MANUAL_SALE_URL.format(code=code)))
        # 售出同步已经给它们建了下架、还在排队的不算，不然催销售手工重复下架
        if sku.status == SkuStatus.RESERVED and idle_listed.get(sku.id):
            issues.append(_issue("red", f"已锁单，还有 {idle_listed[sku.id]} 个号挂着，要联动下架", SHOP_OFF_URL.format(code=code)))
        if not sku.images:
            issues.append(_issue("red", "没有实拍图，不能上架", DETAIL_URL.format(code=code)))
        tags = approvals.get(code) or {}
        if tags.get("fix"):
            issues.append(_issue("red", f"{tags['fix']} 个号在架但没批过价和图，要整改", APPROVAL_URL.format(code=code)))
        if tags.get("review"):
            issues.append(_issue("yellow", f"{tags['review']} 个号等审批", APPROVAL_URL.format(code=code)))
        if tags.get("todo"):
            issues.append(_issue("yellow", f"{tags['todo']} 个号还没清洗（填价、选图）", APPROVAL_URL.format(code=code)))
        gap = gaps.get(code)
        if gap:
            issues.append(_issue("yellow", f"{gap['kind_label']}：{gap['note']}", gap["action_url"]))
        tr = trend.get(sku.id)
        if tr and tr["level"] and tr["fresh"] and sku.status == SkuStatus.IN_STOCK:
            word = "涨" if tr["pct"] > 0 else "跌"
            issues.append(_issue(tr["level"], f"行情{word}了 {abs(tr['pct'])}%（{tr['date']}），核对一下价格",
                                 PRICE_CLEAN_URL.format(code=code)))
        age = sa.stock_age(sku, thresholds, now)
        if sku.status == SkuStatus.IN_STOCK and age["stage"] == "stale":
            issues.append(_issue("red", f"滞销：在库 {age['days']} 天", DETAIL_URL.format(code=code)))
        elif sku.status == SkuStatus.IN_STOCK and age["stage"] == "clearance":
            issues.append(_issue("yellow", f"该清仓：在库 {age['days']} 天", DETAIL_URL.format(code=code)))
        issues.sort(key=lambda i: LEVEL_ORDER[i["level"]])
        lv = issues[0]["level"] if issues else "green"
        counts[lv] += 1
        if level and level != lv:
            continue
        cards.append({
            "sku_code": code,
            "product_name": sku.product_name,
            "product_type": sku.product_type or "未分类",
            "location_code": sku.location_code,
            "level": lv,
            "level_label": LEVEL_LABEL[lv],
            # 实拍图第一张；绝不用封面
            "thumb": sign_oss_thumb_url(sku.images[0], size="medium") if sku.images else None,
            "photo_count": len(sku.images or []),
            "listed": listed,
            "shop_total": shop_total,
            "locked": sku.status == SkuStatus.RESERVED,
            "age_days": age["days"],
            # 第几个焕新周期；滞销写「满 N 周期」
            "cycle": age["days"] // CYCLE_DAYS + (0 if age["stage"] == "stale" else 1),
            "age_stage": age["stage"],
            "location_count": len(sku.location_images or []),
            "source": "资产录入" if sku.purchase_order_id in asset_pos else "采购",
            "cost_price": None if sku.cost_price is None else str(sku.cost_price),
            "issues": issues,
            "approval": tags or None,
            "trend": tr,
            "pool": POOL_LABEL.get(pool[sku.id]),
            "url": ITEM_URL.format(code=code),
        })
    cards.sort(key=lambda c: (LEVEL_ORDER[c["level"]], -c["age_days"], c["sku_code"]))
    # 页头图池条：按款数，没对上型号目录的、还没搜过的也说出来
    pool_bar = [{"key": k, "label": lb, "n": pool_summary.get(k, 0)} for k, lb in (
        ("READY", "可用"), ("REVIEWING", "等审核"), ("SEARCHING", "搜图中"), ("FAILED", "没搜到"),
        ("REJECTED", "审核没过"), ("NONE", "还没搜"), ("NOSPU", "没对上型号"),
    ) if pool_summary.get(k)]
    return {"counts": counts, "total": sum(counts.values()), "items": cards, "pool": pool_bar}


# ---------------------------------------------------------------- 一件货：问题 + 五步
STEPS = ("补齐信息", "定价选图", "审批", "发布上架", "发货出库")
LISTING_FORM_URL = "/pages/listing/form/index?code={code}"
PRICE_CLEAN_URL = "/pages/price-clean/index?code={code}"


def _clean_price(db: Session, sku: Sku) -> dict | None:
    from app.services import price_clean as pc

    v = pc.version_out(pc.current(db, sku.id))
    return v if v and v["usable"] else None


def item(db: Session, user: Staff, code: str, now: datetime | None = None) -> dict | None:
    """一件货的首屏：问题箱、成本 / 最低价 / 建议价 / 行情价、五步走到哪了。具体操作都跳到现成页面。"""
    from app.models import SkuListingInfo
    from app.services.auto_listing.pricing import floor_price

    now = now or datetime.utcnow()
    sku = db.query(Sku).filter(Sku.sku_code == code).first()
    if sku is None:
        return None
    found = build(db, user, code=code, now=now)["items"]
    card = found[0] if found else {
        "sku_code": sku.sku_code, "product_name": sku.product_name, "level": "green", "level_label": "正常",
        "issues": [], "approval": None, "listed": 0, "locked": False, "photo_count": len(sku.images or []),
        "thumb": sign_oss_thumb_url(sku.images[0], size="medium") if sku.images else None,
        "location_code": sku.location_code, "age_days": None,
    }
    market = la.market_of(db, sku)
    ratio = la.min_cost_ratio(db)
    facts = {
        "cost_price": None if sku.cost_price is None else str(sku.cost_price),
        "floor_price": floor_price(sku.cost_price, ratio),
        "min_cost_ratio": str(ratio),
        "suggest_price": None if sku.suggest_price is None else str(sku.suggest_price),
        "market_price": None if market["price"] is None else str(market["price"]),
        "market_basis": market["basis"],
        "condition_grade": sku.condition_grade,
        "brand": sku.brand,
        "model": sku.model,
        # 清洗过、管理员生效的价（过期的不算），没有给 None
        "clean_price": _clean_price(db, sku),
        "clean_url": PRICE_CLEAN_URL.format(code=code),
    }

    shipped = sku.status == SkuStatus.SHIPPED
    sold = sku.status == SkuStatus.RESERVED and sku.reserve_source == ReserveSource.PLATFORM_SOLD
    sold_rows = db.query(func.count(SkuShopListing.id)).filter(
        SkuShopListing.sku_id == sku.id, SkuShopListing.publish_status == ShopListingStatus.SOLD,
    ).scalar() or 0
    tags = card.get("approval")
    gate_on = la.approval_required(db)

    missing = [name for name, ok in (("成本", bool(sku.cost_price)), ("实拍图", bool(sku.images)),
                                      ("型号", bool(sku.model))) if not ok]
    steps = []

    def add(done: bool, note: str, url: str | None, button: str | None, skipped: bool = False):
        steps.append({"no": len(steps) + 1, "title": STEPS[len(steps)], "done": done, "skipped": skipped,
                      "note": note, "url": url, "button": button})

    add(not missing, "信息齐了" if not missing else f"还缺：{'、'.join(missing)}",
        DETAIL_URL.format(code=code), "去补齐")
    if gate_on and tags:
        add(tags["todo"] == 0, f"{tags['shops'] - tags['todo']}/{tags['shops']} 个号填了价、选了图",
            APPROVAL_URL.format(code=code), "去定价选图")
        add(tags["approved"] > 0 and tags["review"] == 0 and tags["todo"] == 0,
            f"批了 {tags['approved']}/{tags['shops']} 个号" + (f"，{tags['review']} 个号等审批" if tags["review"] else ""),
            APPROVAL_URL.format(code=code), "去审批")
    else:
        info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
        add(bool(info and info.status != "DRAFT"), "上架信息填好了" if info and info.status != "DRAFT" else "还没填上架信息",
            LISTING_FORM_URL.format(code=code), "去填")
        add(True, "上架审批没打开，这一步跳过", None, None, skipped=True)
    listed = card.get("listed") or 0
    add(listed > 0 or sold or shipped or sold_rows > 0,
        f"在架 {listed} 个号" if listed else ("已经卖出" if sold or shipped or sold_rows else "还没上架"),
        PUBLISH_URL.format(code=code), "去上架")
    if shipped:
        add(True, "已出库", None, None)
    elif sold:
        lv_note = next((i["text"] for i in card["issues"] if i["text"].startswith("卖出了还没发")), "卖出了，去发货")
        add(False, lv_note, MANUAL_SALE_URL.format(code=code), "去发货")
    else:
        add(False, "卖出后在这里发货", None, None)

    # 现在走到第几步：卖出了就是发货；否则是第一步没做完的（发货那步要等卖出）
    current = 5 if sold else next((s["no"] for s in steps[:4] if not s["done"]), 0 if shipped else 5)
    for s in steps:
        if s["done"]:
            s["state"] = "done"
        elif s["no"] == current:
            s["state"] = "current"
        elif (sold or shipped) and s["no"] < 5:
            # 已经卖出：前面没做完的不用再补
            s["state"], s["note"] = "skip", "已经卖出，这一步不用再做"
        else:
            s["state"] = "locked"
            s["lock"] = "卖出后才能发货" if s["no"] == 5 else f"先做完第 {current} 步「{STEPS[current - 1]}」"
    return {"card": card, "facts": facts, "steps": steps, "current": current,
            "photos": [sign_oss_thumb_url(u, size="medium") or u for u in (sku.images or [])[:12]],
            "shops": _shop_rows(db, user, sku, facts["floor_price"]) if gate_on else None,
            "can_review_low_price": user.role == StaffRole.ADMIN,
            # 闲鱼卖出还没发：买家取消了能放回在库（不然只能做一笔假出库来消红）
            "sold_pending": sold}


def _shop_rows(db: Session, user: Staff, sku: Sku, floor: int | None) -> list[dict]:
    """各号这一份价和图走到哪了（和上架审批页同一套数据），五步里第 2～4 步在本页直接看、直接批。"""
    from app.routers import listing_approval as R
    from app.services.staff_lookup import map_staff_names

    current = la.current_by_shop(db, sku.id)
    listed = R._listed_shop_ids(db, [sku.id])
    names = map_staff_names(db, {x for r in current.values() for x in (r.submitted_by, r.reviewed_by) if x})
    rows = []
    for shop in R._shops(db):
        cell = R._cell(db, sku, current.get(shop.id), (sku.id, shop.id) in listed)
        ap = R._approval_out(current.get(shop.id), names, user, sku, floor)
        rows.append({
            "id": shop.id,
            "label": shop.label,
            "state": cell["state"],
            "state_label": "在架待整改" if cell["needs_fix"] else cell["label"],
            "needs_fix": cell["needs_fix"],
            "listed": cell["listed"],
            "problem": cell["problem"],
            "price": ap["price"] if ap else None,
            "thumbs": [i["thumb"] for i in (ap["images"] if ap else [])[:4]],
            "image_count": len(ap["images"]) if ap else 0,
            "note": ap["note"] if ap else None,
            "review_note": ap["review_note"] if ap else None,
            "submitted_by_name": ap["submitted_by_name"] if ap else None,
            "submitted_by_me": bool(ap and ap["submitted_by_me"]),
            "below_floor": bool(ap and ap["below_floor"]),
            "high": bool(ap and ap["high"]),
        })
    return rows
