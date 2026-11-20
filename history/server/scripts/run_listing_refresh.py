"""链接焕新入口，由 systemd timer 每天跑一次（erp-listing-refresh.timer）。

用法: python3 -m scripts.run_listing_refresh [--dry-run] [--limit N]

在架满 7 天没卖掉的链接删掉重发，见 app/services/gc_bridge/listing_refresh.py。
--dry-run  只列出今天会焕新哪些、跳过哪些及原因，不开任何作业；开关没开也能跑，上线前先看一眼。
--limit N  最多开 N 单。第一次真跑先放一两条，看群控任务列表里删和发都成了再放开。
进程级 GET_LOCK 互斥：拿不到锁说明上一轮还在跑，本次跳过。
"""
from __future__ import annotations

import argparse
import asyncio
import logging

from sqlalchemy import text

from app.database import SessionLocal
from app.services.gc_bridge.listing_refresh import run_listing_refresh, why_refresh_off

_LOCK_NAME = "gc_listing_refresh"
logger = logging.getLogger("gc.listing_refresh")


def _why_not(dry_run: bool) -> str | None:
    if dry_run:
        return None
    return why_refresh_off()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    why = _why_not(args.dry_run)
    if why:
        logger.info("%s，跳过", why)
        return

    db = SessionLocal()
    try:
        got = db.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": _LOCK_NAME}).scalar()
        if got != 1:
            logger.info("未获取到焕新锁，疑似上一轮仍在运行，跳过本次")
            return
        try:
            stats = asyncio.run(run_listing_refresh(db, dry_run=args.dry_run, limit=args.limit))
            logger.info("链接焕新%s：候选 %s 条，%s %s 条，跳过 %s 条，买家在聊先不动 %s 条；跳过原因 %s",
                        "预演" if args.dry_run else "完成", stats["candidates"],
                        "会开单" if args.dry_run else "开单", stats["created"], stats["skipped"],
                        stats["held_for_buyers"], stats["reasons"] or "无")
        finally:
            db.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": _LOCK_NAME})
            db.commit()
    except Exception:
        logger.exception("链接焕新失败")
    finally:
        db.close()


if __name__ == "__main__":
    main()
