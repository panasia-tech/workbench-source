"""存量补价补图入口，由 systemd timer 每天跑一次（erp-stock-backfill.timer）。

用法: python3 -m scripts.run_stock_backfill [--dry-run]

跟后台「自动上架流水线」页的「存量补价补图」按钮是同一件事（app/services/auto_listing/backfill.py）：
新进仓还没上架的存量货登记进来，以前没备好的（等行情价、等爬虫搜图、缺图、认不出型号）重查一遍。
只补价和图，备好停在待人工上架，绝不发布。
--dry-run  只数会处理多少件，不动库。
--adopt-unresolved-inbound  先把「入库时认不出型号、没上架」的自动上架行改成存量行再跑（11-09 一次性用）。
跟自动上架 worker 抢同一把具名锁，拿不到说明它正在推，本次跳过。
"""
from __future__ import annotations

import argparse
import logging

from app.database import SessionLocal
from app.services.auto_listing.backfill import BackfillBusy, adopt_unresolved_inbound, run_backfill

logger = logging.getLogger("auto_listing.stock_backfill")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--adopt-unresolved-inbound", action="store_true")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        if args.adopt_unresolved_inbound:
            adopted = adopt_unresolved_inbound(db, dry_run=args.dry_run)
            logger.info("入库时认不出型号、没上架的%s改成存量行：%d 件", "（预演）将" if args.dry_run else "已", len(adopted))
        r = run_backfill(db, dry_run=args.dry_run)
    except BackfillBusy:
        logger.info("自动上架 worker 正在推，跳过本次")
        return
    finally:
        db.close()
    logger.info(
        "存量补价补图%s：新登记 %d、重查 %d、监控清单新增 %d，结果 %s，出错 %d",
        "（预演）" if args.dry_run else "", r["new"], r["rerun"], r["watch_created"], r["outcomes"], r["failed"],
    )


if __name__ == "__main__":
    main()
