"""OA KPI 月度结算：结算上月(默认)或指定月的「销售额达成」KPI，入队 oa_push_outbox。

由 systemd timer 每月初调用；入队后由 scripts.run_oa_push（或其 timer）推送。
无月目标(OA_KPI_TARGETS)的员工会被跳过（completionRate 必填，无从计算）。

用法: python3 -m scripts.run_oa_push_kpi [--month 202607]   # 默认上月
生产: cd /www/wwwroot/py-api && ./venv/bin/python -m scripts.run_oa_push_kpi
"""
from __future__ import annotations

import argparse
import logging

from sqlalchemy import text

from app.config import settings
from app.database import SessionLocal
from app.services.finance import china_today
from app.services.oa_push import events, outbox

_LOCK_NAME = "oa_push_kpi"
logger = logging.getLogger("oa_push_kpi")


def _prev_month() -> str:
    t = china_today()
    y, m = t.year, t.month - 1
    if m == 0:
        y, m = y - 1, 12
    return f"{y:04d}{m:02d}"


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--month", default="", help="YYYYMM；默认上月")
    args = parser.parse_args()

    if not settings.oa_push_enabled:
        logger.info("OA_PUSH_ENABLED 未开启，跳过")
        return

    month = args.month.strip() or _prev_month()
    outbox.set_autosubmit(False)  # 只入队，交由 scripts.run_oa_push 推送

    db = SessionLocal()
    try:
        got = db.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": _LOCK_NAME}).scalar()
        if got != 1:
            logger.info("未获取到 KPI 锁，跳过本次")
            return
        try:
            ids = events.enqueue_kpi_for_month(db, month)
            db.commit()
            logger.info("KPI %s 入队 %d 条（无目标员工已跳过）", month, len(ids))
        finally:
            db.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": _LOCK_NAME})
            db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
