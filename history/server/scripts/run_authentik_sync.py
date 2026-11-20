"""统一登录同步入口：ERP 员工 → Authentik，由 systemd timer 每 5 分钟跑一次（erp-authentik-sync.timer）。

用法: python3 -m scripts.run_authentik_sync [--dry-run]

建号、改名、停用、组成员都从 ERP 推过去，只碰 ERP 同步来的号和组，见 app/services/authentik_sync.py。
同一轮接着按「分组 → 系统」在统一登录的应用上加减绑定（能进哪些系统，app/services/authentik_access.py），
它另有开关 AUTHENTIK_ACCESS_SYNC_ENABLED，没开时真跑跳过这一段。
--dry-run  只读 Authentik、打印这一轮会改什么，什么都不写；开关没开也能跑（两段都算），上线前先看一眼。
开关 AUTHENTIK_SYNC_ENABLED 没开时不带 --dry-run 只记一行「未开启」就退出。
进程级 GET_LOCK 互斥（和后台「立即同步」同一把锁）：拿不到说明上一轮还在跑，本次跳过。
有步骤失败（哪一段都算）时退出码 1，systemctl --failed 里看得到。
"""
from __future__ import annotations

import argparse
import logging
import sys

from app.database import SessionLocal
from app.services import authentik_sync

logger = logging.getLogger("authentik_sync")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    # httpx 每个请求记一行 INFO，每 5 分钟一轮会把日志刷满；出错时同步自己会记
    logging.getLogger("httpx").setLevel(logging.WARNING)
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    why = authentik_sync.why_not(dry_run=args.dry_run)
    if why:
        logger.info("%s，跳过", why)
        return 0

    db = SessionLocal()
    try:
        with authentik_sync.sync_lock(db) as got:
            if not got:
                logger.info("未获取到同步锁，疑似上一轮仍在运行，跳过本次")
                return 0
            api = authentik_sync.make_api()
            try:
                report = authentik_sync.run_sync(db, api, dry_run=args.dry_run)
            finally:
                api.close()
        for line in report.lines():
            logger.info("%s", line)
        return 1 if report.has_errors() else 0
    except Exception:
        logger.exception("统一登录同步失败")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
