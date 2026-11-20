"""OA/台账存量数据一次性补推：把历史 员工 / 出库(销售统计+提成) / 验货提成 / 反馈回复 / KPI
补录进 oa_push_outbox（PENDING），随后由 scripts.run_oa_push（或 systemd timer）限流推送、失败重试。

- 不直接调 OA，只入库；靠 dedup_key 唯一约束防重，可安全重跑。
- 前置：.env 里 OA_PUSH_ENABLED=true（否则 enqueue 被跳过）。建议先 --dry-run 看条数。
- 执行顺序建议：先 staff（同步用户快照）→ 再 sale/finance/reply/kpi。

用法（本地开发库直跑；生产走 SSH 隧道 + DATABASE_URL 覆盖，见 erp-server-deploy 记录）：
    python3 -m scripts.backfill_oa_push --only all --dry-run
    python3 -m scripts.backfill_oa_push --only staff
    python3 -m scripts.backfill_oa_push --only sale --limit 500
    python3 -m scripts.backfill_oa_push --only finance
    python3 -m scripts.backfill_oa_push --only reply
    python3 -m scripts.backfill_oa_push --only kpi --kpi-months 202606,202607,202608
生产：cd /www/wwwroot/py-api && ./venv/bin/python -m scripts.backfill_oa_push --only all --dry-run
"""
from __future__ import annotations

import argparse
import logging
from datetime import datetime

from sqlalchemy import func

from app.config import settings
from app.database import SessionLocal
from app.enums import InspectionStatus
from app.models import AnonymousFeedback, Inspection, PurchaseOrder, SaleOrder, SalesOutbound, Sku, Staff
from app.services import oa_push
from app.services.oa_push import events, mapping, outbox
from app.services.oa_push.outbox import enqueue_push

logger = logging.getLogger("backfill_oa_push")

TOOLS = ("staff", "sale", "finance", "reply", "kpi", "all")


def _finish(db, dry_run: bool):
    db.rollback() if dry_run else db.commit()


def backfill_staff(db, limit: int, dry_run: bool) -> int:
    q = db.query(Staff).order_by(Staff.created_at.asc())
    if limit:
        q = q.limit(limit)
    rows = q.all()
    n = 0
    for i, s in enumerate(rows, 1):
        try:
            if events.on_staff_synced(db, s, dedup_ts=s.updated_at):
                n += 1
        except Exception:  # noqa: BLE001
            logger.exception("staff 入队失败 id=%s", s.id)
        _finish(db, dry_run)
        if i % 200 == 0:
            logger.info("staff %d/%d", i, len(rows))
    logger.info("staff 完成：候选 %d，新入队 %d", len(rows), n)
    return n


def backfill_outbound(db, limit: int, dry_run: bool, *, do_sale: bool, do_finance: bool) -> tuple[int, int]:
    q = db.query(SalesOutbound).order_by(SalesOutbound.created_at.asc())
    if limit:
        q = q.limit(limit)
    rows = q.all()
    sale_n = fin_n = 0
    for i, ob in enumerate(rows, 1):
        try:
            if do_sale:
                sale_order = db.get(SaleOrder, ob.sale_order_id) if ob.sale_order_id else None
                oid = enqueue_push(
                    db, "push_sale_stat", events.build_sale_stat_args(ob, sale_order),
                    dedup_key=f"sale_stat|{ob.id}", source_type="outbound", source_id=ob.id,
                )
                if oid:
                    sale_n += 1
            if do_finance:
                sku = db.get(Sku, ob.sku_id)
                po = db.get(PurchaseOrder, sku.purchase_order_id) if sku else None
                operator = db.get(Staff, ob.operator_id)
                role = operator.role if operator else None
                for args, suffix in events.build_finance_for_outbound(ob, po, role):
                    oid = enqueue_push(
                        db, "push_finance_record", args,
                        dedup_key=f"finance|outbound|{ob.id}|{suffix}",
                        source_type="outbound", source_id=ob.id,
                    )
                    if oid:
                        fin_n += 1
        except Exception:  # noqa: BLE001
            logger.exception("outbound 入队失败 id=%s", ob.id)
        _finish(db, dry_run)
        if i % 200 == 0:
            logger.info("outbound %d/%d", i, len(rows))
    logger.info("outbound 完成：候选 %d，sale 新入队 %d，finance 新入队 %d", len(rows), sale_n, fin_n)
    return sale_n, fin_n


def backfill_inspect(db, limit: int, dry_run: bool) -> int:
    q = (
        db.query(Inspection)
        .filter(
            Inspection.status == InspectionStatus.DONE,
            Inspection.deleted_at.is_(None),
            Inspection.inspector_id.isnot(None),
        )
        .order_by(Inspection.inspected_at.asc())
    )
    if limit:
        q = q.limit(limit)
    rows = q.all()
    n = 0
    for i, insp in enumerate(rows, 1):
        try:
            oid = enqueue_push(
                db, "push_finance_record", events.build_inspect_finance_args(insp),
                dedup_key=f"finance|inspect|{insp.id}", source_type="inspection", source_id=insp.id,
            )
            if oid:
                n += 1
        except Exception:  # noqa: BLE001
            logger.exception("验货提成入队失败 id=%s", insp.id)
        _finish(db, dry_run)
        if i % 200 == 0:
            logger.info("验货提成 %d/%d", i, len(rows))
    logger.info("验货提成完成：候选 %d，新入队 %d", len(rows), n)
    return n


def backfill_reply(db, limit: int, dry_run: bool) -> int:
    q = (
        db.query(AnonymousFeedback)
        .filter(AnonymousFeedback.handled_by_id.isnot(None), AnonymousFeedback.handled_note.isnot(None))
        .order_by(AnonymousFeedback.created_at.asc())
    )
    if limit:
        q = q.limit(limit)
    rows = q.all()
    n = 0
    for fb in rows:
        try:
            oid = enqueue_push(
                db, "push_reply_record", events.build_reply_args(fb),
                dedup_key=f"reply|feedback|{fb.id}", source_type="feedback", source_id=fb.id,
            )
            if oid:
                n += 1
        except Exception:  # noqa: BLE001
            logger.exception("反馈回复入队失败 id=%s", fb.id)
        _finish(db, dry_run)
    logger.info("反馈回复完成：候选 %d，新入队 %d", len(rows), n)
    return n


def _all_months(db) -> list[str]:
    first = db.query(func.min(SalesOutbound.created_at)).scalar()
    if not first:
        return []
    start = mapping.to_cn(first)
    now = mapping.to_cn(datetime.utcnow())
    months, y, m = [], start.year, start.month
    while (y, m) <= (now.year, now.month):
        months.append(f"{y:04d}{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return months


def backfill_kpi(db, months: list[str], dry_run: bool) -> int:
    n = 0
    for mth in months:
        try:
            ids = events.enqueue_kpi_for_month(db, mth)
            n += len(ids)
            logger.info("KPI %s 新入队 %d", mth, len(ids))
        except Exception:  # noqa: BLE001
            logger.exception("KPI 入队失败 month=%s", mth)
        _finish(db, dry_run)
    logger.info("KPI 完成：月份 %d，新入队 %d", len(months), n)
    return n


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="all", choices=TOOLS, help="只补某类；默认 all")
    parser.add_argument("--limit", type=int, default=0, help="每类最多处理多少条源数据，0=不限")
    parser.add_argument("--kpi-months", default="", help="逗号分隔 YYYYMM；仅 kpi 用；留空=最早出库月至当月")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写库")
    args = parser.parse_args()

    if not settings.oa_push_enabled:
        logger.error("OA_PUSH_ENABLED 未开启，enqueue 会被跳过。请先在 .env 设 OA_PUSH_ENABLED=true 再跑。")
        return
    if not oa_push.client.is_configured():
        logger.warning("OA_MCP_URL/OA_MCP_API_KEY 未配置：仍会入库(PENDING)，但需配置后由 run_oa_push 推送。")

    outbox.set_autosubmit(False)  # 只入库，交由 scripts.run_oa_push / systemd timer 推送

    db = SessionLocal()
    try:
        only = args.only
        if only in ("staff", "all"):
            backfill_staff(db, args.limit, args.dry_run)
        if only == "sale":
            backfill_outbound(db, args.limit, args.dry_run, do_sale=True, do_finance=False)
        elif only == "finance":
            backfill_outbound(db, args.limit, args.dry_run, do_sale=False, do_finance=True)
            backfill_inspect(db, args.limit, args.dry_run)
        elif only == "all":
            backfill_outbound(db, args.limit, args.dry_run, do_sale=True, do_finance=True)
            backfill_inspect(db, args.limit, args.dry_run)
        if only in ("reply", "all"):
            backfill_reply(db, args.limit, args.dry_run)
        if only in ("kpi", "all"):
            months = [m.strip() for m in args.kpi_months.split(",") if m.strip()] or _all_months(db)
            backfill_kpi(db, months, args.dry_run)
        logger.info("全部完成%s。接着跑 scripts.run_oa_push 或等 systemd timer 推送。",
                    "（dry-run 未写库）" if args.dry_run else "")
    finally:
        db.close()


if __name__ == "__main__":
    main()
