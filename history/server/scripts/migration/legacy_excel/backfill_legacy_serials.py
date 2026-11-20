"""回填老货号迁移 sku 的序列号。**默认 dry-run,不提交。**

背景:方案 A 迁移(migrate_legacy_excel.py)写 sku 时 serial_number=None,
真实序列号只落在 stock_event.payload.barcode / purchase_order.external_order_no,
仓库搜索匹配不到 → 仓库拿着实物序列号查不到货(客户反馈案例)。

回填规则(逐条):
  1. 目标 = tags 含 LEGACY_IMPORT 且 serial_number 为空的 sku;
  2. 序列号取该 sku 的 INBOUND stock_event.payload.barcode,为空回退采购单 external_order_no;
  3. 跳过:取不到值 / 值等于 sku_code(nosrc 占位,barcode 就是货号本身) / 与库内已有序列号重复(打印清单人工审)。

幂等:serial_number 已有值的不再处理,可重复运行。

在生产服务器(/www/wwwroot/py-api)上运行:
  # 预览(只读,自动回滚)
  python -m scripts.migration.legacy_excel.backfill_legacy_serials --dry-run
  # 正式写入(自动先写备份 JSON 到 --backup-dir)
  python -m scripts.migration.legacy_excel.backfill_legacy_serials --commit \
      --backup-dir /www/wwwroot/py-api/backups
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select

from app.database import SessionLocal
from app.models.inventory import Sku, StockEvent
from app.models.purchase import PurchaseOrder


def collect(db) -> tuple[list[dict], list[dict]]:
    """返回 (待回填清单, 跳过清单),均为 dict 便于打印/备份。"""
    skus = db.scalars(
        select(Sku).where(
            func.JSON_CONTAINS(Sku.tags, func.JSON_QUOTE("LEGACY_IMPORT")) == 1,
            Sku.serial_number.is_(None),
        )
    ).all()

    # 已占用的序列号(全表),回填值撞上则跳过人工审
    used = set(db.scalars(select(Sku.serial_number).where(Sku.serial_number.is_not(None))).all())

    plan, skipped = [], []
    for sku in skus:
        evt = db.scalars(
            select(StockEvent)
            .where(StockEvent.sku_id == sku.id, StockEvent.event_type == "INBOUND")
            .order_by(StockEvent.created_at)
        ).first()
        barcode = ((evt.payload or {}).get("barcode") if evt else None) or None
        if not barcode:
            po = db.get(PurchaseOrder, sku.purchase_order_id)
            barcode = (po.external_order_no or None) if po else None
        barcode = (barcode or "").strip()

        row = {"sku_id": sku.id, "sku_code": sku.sku_code, "serial": barcode}
        if not barcode:
            skipped.append({**row, "reason": "无序列号来源"})
        elif barcode == sku.sku_code:
            skipped.append({**row, "reason": "barcode==sku_code(nosrc占位)"})
        elif len(barcode) > 128:
            skipped.append({**row, "reason": "超长(>128)"})
        elif barcode in used:
            skipped.append({**row, "reason": "与库内已有序列号重复"})
        else:
            used.add(barcode)  # 计划内互撞也要挡住
            plan.append(row)
    return plan, skipped


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", default=True)
    g.add_argument("--commit", dest="dry_run", action="store_false")
    ap.add_argument("--backup-dir", default="backups", help="commit 前备份 JSON 的目录")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        plan, skipped = collect(db)
        print(f"待回填 {len(plan)} 条,跳过 {len(skipped)} 条")
        for row in skipped:
            print(f"  [skip] {row['sku_code']}: {row['reason']} ({row['serial'] or '-'})")
        for row in plan[:10]:
            print(f"  [fill] {row['sku_code']} <- {row['serial']}")
        if len(plan) > 10:
            print(f"  ... 共 {len(plan)} 条")

        if args.dry_run:
            print("dry-run:未写入。确认无误后加 --commit 执行。")
            return
        if not plan:
            print("无可回填数据。")
            return

        backup_dir = Path(args.backup_dir)
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = backup_dir / f"serial_backfill_{stamp}.json"
        backup.write_text(
            json.dumps({"plan": plan, "skipped": skipped}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"备份已写 {backup}")

        for row in plan:
            db.get(Sku, row["sku_id"]).serial_number = row["serial"]
        db.commit()
        print(f"已提交:回填 {len(plan)} 条 serial_number。")
    finally:
        db.close()


if __name__ == "__main__":
    main()
