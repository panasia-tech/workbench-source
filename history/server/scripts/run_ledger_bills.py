"""大台账对账：每天拉企业支付宝账单，由 systemd timer 跑（erp-ledger-bills.timer）。

用法: python3 -m scripts.run_ledger_bills [--date 2026-11-09]

对每个已授权的支付宝：快过期的授权先续期，拉指定那天（默认昨天）的账务明细，前 7 天里拉失败的再补一次，
拉下来就和那几家店的 ERP 销售单对一遍。逻辑见 app/services/ledger_bill.py。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
from datetime import date

from sqlalchemy import text

from app.database import SessionLocal
from app.services.ledger_bill import run_daily

_LOCK = "erp:ledger:bills"
logger = logging.getLogger("ledger.bills")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None)
    args = ap.parse_args()
    db = SessionLocal()
    try:
        if db.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": _LOCK}).scalar() != 1:
            logger.info("上一轮还在跑，跳过")
            return
        r = asyncio.run(run_daily(db, bill_date=date.fromisoformat(args.date) if args.date else None))
        logger.info("拉账单：成功 %d、当天没流水 %d、出错 %d", r.get("ok", 0), r.get("empty", 0), r.get("error", 0))
    finally:
        db.close()


if __name__ == "__main__":
    main()
