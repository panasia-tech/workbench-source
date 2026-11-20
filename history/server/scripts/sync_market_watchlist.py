#!/usr/bin/env python3
"""把行情监控清单同步成「当前在库的 SPU 型号」。

用法:
    python scripts/sync_market_watchlist.py [--disable-stale] [--dry-run]

在库 SKU → resolve_spu → SPU 的「品牌 型号」→ crawl_product。
同款多件只建一条；已存在则保持；被停用过的会重新启用。

--disable-stale  把不在本次在库集合里的监控项**停用**（不删除）。
                 生产现存 7868 条里 7719 条是搜不到行情的冷门 AOC 型号码，
                 要下线它们就靠这个开关。停用可逆，历史行情原样保留。
--dry-run        只统计不落库，先看清会改多少。

与后台/自动上架编排走同一套逻辑（app/services/spu_market_sync.py）。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal
from app.services import spu_market_sync


def main():
    disable_stale = "--disable-stale" in sys.argv
    dry_run = "--dry-run" in sys.argv

    db = SessionLocal()
    try:
        r = spu_market_sync.sync_watchlist(db, disable_stale=disable_stale, dry_run=dry_run)
    finally:
        db.close()

    mode = "预演(不落库)" if dry_run else ("同步 + 停用旧项" if disable_stale else "同步(不停用任何旧项)")
    print(f"模式: {mode}")
    print(f"在库解析出的 SPU 型号: {r['stock_spu_count']} 个")
    print(f"解析不出的在库 SKU:   {r['unresolved_sku_count']} 件")
    print(
        f"新建 {r['created']}、重新启用 {r['reenabled']}、保持 {r['kept']}、停用 {r['disabled']}"
    )
    if r["unresolved_samples"]:
        print("\n解析不出的(需人工补型号或补进 SPU 对照表):")
        for s in r["unresolved_samples"]:
            print(f"  {s['sku_code']:<18} {str(s['brand'] or ''):<12} {s['model'] or ''}")


if __name__ == "__main__":
    main()
