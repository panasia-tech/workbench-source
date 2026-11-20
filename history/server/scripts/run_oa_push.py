"""OA/台账推送定时兜底：处理 oa_push_outbox 里到期(PENDING/RETRY)的行，同步逐条推送、失败退避重试。

由 systemd timer 周期调用（建议每 1-2 分钟）。GET_LOCK 保证同一时刻只有一个在跑。
实时 worker 已在业务发生时投递大多数行；本脚本兜住「worker 漏投 / 进程重启 / 退避到期」的行，
并且是存量补推(backfill 只入库不推)后真正把队列推出去的执行器。

用法: python3 -m scripts.run_oa_push [--limit 200]
生产: cd /www/wwwroot/py-api && ./venv/bin/python -m scripts.run_oa_push
"""
from __future__ import annotations

import argparse
import logging

from sqlalchemy import text

from app.config import settings
from app.database import SessionLocal
from app.services.oa_push import client, worker

_LOCK_NAME = "oa_push_sweep"
logger = logging.getLogger("oa_push")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=200, help="单轮最多处理条数")
    args = parser.parse_args()

    if not settings.oa_push_enabled:
        logger.info("OA_PUSH_ENABLED 未开启，跳过")
        return
    if not client.is_configured():
        logger.warning("OA_MCP_URL/OA_MCP_API_KEY 未配置，跳过（不推送，避免把队列全标失败）")
        return

    db = SessionLocal()
    try:
        # 进程级互斥：拿不到锁说明上一轮还没跑完，直接跳过
        got = db.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": _LOCK_NAME}).scalar()
        if got != 1:
            logger.info("未获取到推送锁，上一轮仍在运行，跳过本次")
            return
        try:
            n = worker.run_due_batch(db, limit=args.limit)
            logger.info("本轮处理 %d 条", n)
        finally:
            db.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": _LOCK_NAME})
            db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
