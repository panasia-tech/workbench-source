"""把「真正有库存的 SPU」同步成行情监控清单。

背景：生产的 crawl_product 有 7868 条，其中 7719 条是纯型号码
（160HZ / T2254 / KG251QS / 27GP700 …），来自早年批量导入的冷门 AOC 显示器型号。
这批码绝大多数在闲鱼根本搜不到行情价，
爬它们等于空转，还把真正要盯的在库型号淹没了。

改成按库存驱动：在库 SKU → resolve_spu → SPU 的「品牌 型号」→ 监控清单。
生产实测 351 件在库能解析出 345 件（98%），收敛到百来个真实型号。

只改 enabled 开关，不删任何行——crawl_price 历史挂在 product_id 上，删了就没了。
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.enums import SkuStatus
from app.models import CrawlProduct, Sku, WarehouseSpu
from app.services.spu_resolve import resolve_spu

logger = logging.getLogger(__name__)

# 标记这条监控项由库存同步产生，便于与人工/巡航台登记的区分开
SYNC_NOTE = "按在库 SPU 自动同步"

_MAX_NAME = 128


def stock_spu_queries(db: Session) -> tuple[dict[str, WarehouseSpu], list[Sku]]:
    """在库 SKU 解析出的 SPU 集合。返回 ({搜索词: SPU}, 解析不出的 SKU 列表)。"""
    matched: dict[str, WarehouseSpu] = {}
    unresolved: list[Sku] = []
    skus = db.query(Sku).filter(Sku.status == SkuStatus.IN_STOCK).all()
    for sku in skus:
        m = resolve_spu(db, sku)
        if m.matched and m.query:
            matched.setdefault(m.query[:_MAX_NAME], m.spu)
        else:
            unresolved.append(sku)
    return matched, unresolved


def sync_watchlist(db: Session, *, disable_stale: bool = False, dry_run: bool = False) -> dict:
    """在库 SPU → crawl_product。

    - 清单里没有的搜索词 → 新建（enabled=True）
    - 已有但被停用的 → 重新启用（可能是上一轮没库存被停的）
    - disable_stale=True：把**不在**本次在库 SPU 集合里的监控项停用（不删）。
      停用是可逆的，历史行情原样保留；默认不做，要显式开。

    dry_run 只统计不落库，用来先看清会改多少。
    """
    queries, unresolved = stock_spu_queries(db)

    existing = {(p.name or "").strip().lower(): p for p in db.query(CrawlProduct).all()}
    created = reenabled = kept = disabled = 0

    for query in sorted(queries):
        key = query.lower()
        row = existing.get(key)
        if row is None:
            created += 1
            if not dry_run:
                db.add(CrawlProduct(name=query, keyword=query, enabled=True, note=SYNC_NOTE))
        elif not row.enabled:
            reenabled += 1
            if not dry_run:
                row.enabled = True
        else:
            kept += 1

    if disable_stale:
        wanted = {q.lower() for q in queries}
        for key, row in existing.items():
            if key not in wanted and row.enabled:
                disabled += 1
                if not dry_run:
                    row.enabled = False

    if not dry_run:
        db.commit()
        logger.info(
            "行情监控清单同步：新建 %d、重新启用 %d、保持 %d、停用 %d（在库 SPU %d 个，解析不出 %d 件）",
            created, reenabled, kept, disabled, len(queries), len(unresolved),
        )

    return {
        "stock_spu_count": len(queries),
        "unresolved_sku_count": len(unresolved),
        "unresolved_samples": [
            {"sku_code": s.sku_code, "brand": s.brand, "model": s.model} for s in unresolved[:20]
        ],
        "created": created,
        "reenabled": reenabled,
        "kept": kept,
        "disabled": disabled,
        "dry_run": dry_run,
    }
