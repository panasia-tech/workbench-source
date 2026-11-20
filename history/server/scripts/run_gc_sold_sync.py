"""gc 售出同步入口，由 systemd timer 周期调用（每 5 分钟）。

用法: python3 -m scripts.run_gc_sold_sync

真机 chat_scan 检出「已售」(gc Listing SOLD)→ 本脚本轮询收敛:
ERP 店铺行标 SOLD、SKU 锁占用(待发货)、同一 SKU 其它账号在架链接全账号真机下架。
前后各一步:先把换过的货号推给 gc 账本,最后通知该下没下掉的链接(见 sold_sync 模块说明)。
进程级 GET_LOCK 互斥，拿不到锁说明上一轮还在跑，本次跳过。
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text

from app.config import settings
from app.database import SessionLocal
from app.services.gc_bridge.sold_sync import heal_recoded_listings, sync_gc_sold, warn_stuck_listings

_LOCK_NAME = "gc_sold_sync"
logger = logging.getLogger("gc_sold_sync")


async def _run(db) -> None:
    # 先换货号:账本对不上新货号,下面的售出同步和下架全找不到这些链接
    try:
        await heal_recoded_listings(db)
    except Exception:
        db.rollback()
        logger.exception("gc 账本换货号失败(不影响售出同步)")
    stats = await sync_gc_sold(db)
    logger.info("售出同步完成: %s", stats)
    try:
        warned = await warn_stuck_listings(db)
        if any(warned.values()):
            logger.info("没下掉的链接已通知: %s", warned)
    except Exception:
        db.rollback()
        logger.exception("检查没下掉的链接失败")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")

    if not settings.gc_publish_enabled:
        logger.info("gc 发布未启用，跳过售出同步")
        return

    db = SessionLocal()
    try:
        # 进程级互斥:拿不到锁说明上一轮还没跑完,直接跳过本次
        got = db.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": _LOCK_NAME}).scalar()
        if got != 1:
            logger.info("未获取到售出同步锁,疑似上一轮仍在运行,跳过本次")
            return
        try:
            asyncio.run(_run(db))
        finally:
            db.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": _LOCK_NAME})
            db.commit()
    except Exception:
        logger.exception("售出同步失败")
    finally:
        db.close()


if __name__ == "__main__":
    main()
