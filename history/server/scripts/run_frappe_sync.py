"""Frappe 同步入口：ERP 员工 → Frappe（hr.panasia.fun），由 systemd timer 每 5 分钟跑一次（erp-frappe-sync.timer）。

用法: python3 -m scripts.run_frappe_sync [--dry-run]

按平台分组开号、给角色、停用，只碰同步自己建的号、只撤同步自己加的角色，见 app/services/frappe_sync.py。
同一轮读一遍员工档案和部门、存进 ERP（部门 → 分组，app/services/frappe_departments.py），读不到就照上一轮的算。
--dry-run  只读 Frappe、打印这一轮会改什么，什么都不写；开关没开也能跑，上线前先看一眼。
开关 FRAPPE_SYNC_ENABLED 没开时不带 --dry-run 只记一行「未开启」就退出。
进程级 GET_LOCK 互斥（和后台 Frappe 那张卡的「立即同步」同一把锁，和统一登录同步不是同一把）。
有步骤失败、读不到 Frappe（含读不到员工档案、部门）、配置不对（比如 key 是 Administrator 的）时退出码 1，
systemctl --failed 里看得到。
"""
from __future__ import annotations

import argparse
import logging
import sys

from app.database import SessionLocal
from app.services import frappe_sync

logger = logging.getLogger("frappe_sync")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    # httpx 每个请求记一行 INFO，每 5 分钟一轮会把日志刷满；出错时同步自己会记
    logging.getLogger("httpx").setLevel(logging.WARNING)
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    why = frappe_sync.why_not(dry_run=args.dry_run)
    if why:
        logger.info("%s，跳过", why)
        return 0

    db = SessionLocal()
    try:
        with frappe_sync.sync_lock(db) as got:
            if not got:
                logger.info("未获取到同步锁，疑似上一轮仍在运行，跳过本次")
                return 0
            api = frappe_sync.make_api()
            try:
                report = frappe_sync.run_sync(db, api, dry_run=args.dry_run)
            finally:
                api.close()
        for line in report.lines():
            logger.info("%s", line)
        return 1 if report.has_errors() else 0
    except Exception:
        logger.exception("Frappe 同步失败")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
