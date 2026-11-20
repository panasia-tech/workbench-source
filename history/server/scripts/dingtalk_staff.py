"""钉钉 ↔ ERP 账号的手工工具（对照、关联、对账、单人试跑）。

用法: python3 -m scripts.dingtalk_staff <命令>
  match                       列出钉钉成员和 ERP 账号的对照（只读）
  link <工号> <钉钉userid>     把 ERP 账号关联到钉钉的人（离职时才删得到它）
  unlink <工号>                取消关联
  reconcile [--dry-run] [--create-missing]
                              对一次账：已关联的人钉钉里查无此人就删号；ERP 没关联的人只列出，加 --create-missing 才建号
  join <钉钉userid> [--dry-run]   按入职处理一个人（试跑用）
  leave <钉钉userid> [--dry-run]  按离职处理一个人（试跑用）
除 match、link、unlink 和 --dry-run 外，都要开关 DINGTALK_SYNC_ENABLED 开着。
每天的对账由 erp-dingtalk-reconcile.timer 跑 reconcile。
"""
from __future__ import annotations

import argparse
import logging
import sys

from app.database import SessionLocal
from app.models import Staff
from app.services import dingtalk, dingtalk_sync

logger = logging.getLogger("dingtalk_staff")


def _staff(db, staff_no: str) -> Staff:
    staff = db.query(Staff).filter(Staff.staff_no == staff_no, Staff.deleted_at.is_(None)).first()
    if not staff:
        sys.exit(f"没有工号 {staff_no} 的在职账号")
    return staff


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("match")
    p = sub.add_parser("link")
    p.add_argument("staff_no")
    p.add_argument("userid")
    p = sub.add_parser("unlink")
    p.add_argument("staff_no")
    p = sub.add_parser("reconcile")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--create-missing", action="store_true")
    for name in ("join", "leave"):
        p = sub.add_parser(name)
        p.add_argument("userid")
        p.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        if args.cmd == "match":
            rows = dingtalk_sync.match_rows(db, dingtalk.list_users())
            for r in rows:
                staff = "；".join(f"{s.staff_no} {s.name} {s.username} {s.role}/{s.status}" for s in r["staff"]) or "-"
                print(f"{r['status']}\t{r['name']}\t{r['title']}\t{r['mobile']}\t{r['userid']}\t{staff}")
            return 0
        if args.cmd == "link":
            staff = _staff(db, args.staff_no)
            user = dingtalk.get_user(args.userid)  # 先确认钉钉里有这个人
            dingtalk_sync.link(db, staff, args.userid)
            db.commit()
            logger.info("已关联 %s %s ↔ 钉钉 %s（%s）", staff.staff_no, staff.name, user.get("name"), args.userid)
            return 0
        if args.cmd == "unlink":
            staff = _staff(db, args.staff_no)
            dingtalk_sync.link(db, staff, None)
            db.commit()
            logger.info("已取消关联 %s %s", staff.staff_no, staff.name)
            return 0

        dry_run = args.dry_run
        why = dingtalk_sync.why_not(dry_run=dry_run)
        if why:
            logger.info("%s，跳过（预演加 --dry-run）", why)
            return 0
        tag = "[预演] " if dry_run else ""
        if args.cmd == "reconcile":
            report = dingtalk_sync.reconcile(db, dry_run=dry_run, create_missing=args.create_missing)
            for line in report.lines:
                logger.info("%s%s", tag, line)
            for line in report.errors:
                logger.warning("%s%s", tag, line)
            if not report.lines and not report.errors:
                logger.info("%s没有要改的", tag)
            return 1 if report.errors else 0
        handler = dingtalk_sync.on_join if args.cmd == "join" else dingtalk_sync.on_leave
        logger.info("%s%s", tag, handler(db, args.userid, dry_run=dry_run))
        return 0
    except dingtalk.DingtalkError as exc:
        logger.error("钉钉：%s", exc)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
