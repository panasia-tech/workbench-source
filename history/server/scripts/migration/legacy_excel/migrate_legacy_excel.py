"""方案 A 第 2 步:把迁移计划写入数据库。**默认 dry-run,不提交。**

为每个计划货号生成:占位 purchase_order(IN_STOCK) + 占位 inspection(DONE/PASSED)
+ sku(IN_STOCK) + stock_event(INBOUND, payload 打 LEGACY_EXCEL_IMPORT 标记)。

幂等:已存在同 sku_code / order_no / inspect_no 的一律跳过,可重复运行。

在生产服务器(/www/wwwroot/py-api,DATABASE_URL 指向 erp_xcx)上运行:
  # 预览(只读,自动回滚)
  python -m scripts.migration.legacy_excel.migrate_legacy_excel \
      --plan data/legacy_excel/legacy_migration_plan.jsonl --dry-run
  # 正式写入(先 mysqldump 备份四表,再提交)
  python -m scripts.migration.legacy_excel.migrate_legacy_excel \
      --plan data/legacy_excel/legacy_migration_plan.jsonl --commit \
      --operator-id <staff_id>
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select

from app.database import SessionLocal
from app.enums import InspectionStatus, OrderStatus, SkuStatus, StockEventType
from app.models.inspection import Inspection
from app.models.inventory import Sku, StockEvent
from app.models.purchase import PurchaseOrder
from app.models.staff import new_uuid

# 默认占位操作人:老板审计 / ADMIN(可用 --operator-id 覆盖)
DEFAULT_OPERATOR_ID = "4e9c34b9-3ad8-40f9-ae1f-b634e320f51a"


def _dt(ms):
    if not ms:
        return None
    try:
        return datetime.utcfromtimestamp(int(ms) / 1000)
    except (TypeError, ValueError, OSError):
        return None


def _load_plan(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def run(plan: list[dict], operator_id: str, *, commit: bool) -> dict:
    db = SessionLocal()
    created = {"purchase_order": 0, "inspection": 0, "sku": 0, "stock_event": 0}
    skipped, samples, errors = [], [], []
    try:
        # 预取已存在键,避免逐条查库
        existing_sku = set(db.scalars(select(Sku.sku_code)).all())
        existing_po = set(db.scalars(select(PurchaseOrder.order_no)).all())
        existing_insp = set(db.scalars(select(Inspection.inspect_no)).all())

        for e in plan:
            code = e["sku_code"]
            order_no = f"POLEG{code}"[:32]
            inspect_no = f"INLEG{code}"[:32]
            if code in existing_sku or order_no in existing_po or inspect_no in existing_insp:
                skipped.append(code)
                continue

            po_id, insp_id, sku_id = new_uuid(), new_uuid(), new_uuid()
            inbound = _dt(e.get("inbound_ms"))
            cost = Decimal(str(e.get("cost_price") or 0)).quantize(Decimal("0.01"))
            cover = e.get("cover_url")
            images = [cover] if cover else []

            po = PurchaseOrder(
                id=po_id, order_no=order_no, status=OrderStatus.IN_STOCK,
                product_name=e["product_name"], brand=e.get("brand"), model=e.get("model"),
                unit_price=cost, external_order_no=e.get("barcode"),
                order_time=inbound, paid_at=inbound, seller_name=e.get("supplier"),
                remark=f"LEGACY_EXCEL_IMPORT source={e['source']} legacy_id={e.get('legacy_id')}",
                product_images=images, created_by_id=operator_id,
            )
            insp = Inspection(
                id=insp_id, inspect_no=inspect_no, purchase_order_id=po_id,
                action_type="INBOUND", inspection_result="PASSED",
                listing_images=images, condition_grade=None,
                location_code=e.get("location_code"), status=InspectionStatus.DONE,
                inspector_id=operator_id, inspected_at=inbound,
                remark="历史库存快照迁移(方案A占位验货单)",
            )
            sku = Sku(
                id=sku_id, sku_code=code, serial_number=None,
                purchase_order_id=po_id, inspection_id=insp_id,
                product_name=e["product_name"], brand=e.get("brand"), model=e.get("model"),
                location_code=(e.get("location_code") or "")[:32] or None,
                cost_price=cost, suggest_price=None, status=SkuStatus.IN_STOCK,
                cover_url=cover, images=images, tags=["LEGACY_IMPORT"],
                inbound_at=inbound,
            )
            if inbound:
                sku.created_at = inbound
            evt = StockEvent(
                id=new_uuid(), purchase_order_id=po_id, sku_id=sku_id,
                event_type=StockEventType.INBOUND, ref_no=inspect_no, operator_id=operator_id,
                payload={
                    "source": "LEGACY_EXCEL_IMPORT", "plan_source": e["source"],
                    "legacy_id": e.get("legacy_id"), "legacy_status": e.get("legacy_status"),
                    "barcode": e.get("barcode"), "cost_zero_pending": not bool(e.get("cost_price")),
                },
            )
            db.add_all([po, insp, sku, evt])
            existing_sku.add(code); existing_po.add(order_no); existing_insp.add(inspect_no)
            created["purchase_order"] += 1
            created["inspection"] += 1
            created["sku"] += 1
            created["stock_event"] += 1
            if len(samples) < 5:
                samples.append({"sku_code": code, "order_no": order_no, "product_name": e["product_name"],
                                "cost": str(cost), "status": "IN_STOCK", "inbound": str(inbound)})

        db.flush()  # 触发约束校验,dry-run 也能暴露唯一键/非空错误
        if commit:
            db.commit()
        else:
            db.rollback()
    except Exception as ex:  # noqa: BLE001
        db.rollback()
        errors.append(repr(ex))
        raise
    finally:
        db.close()
    return {"created": created, "skipped": skipped, "samples": samples, "errors": errors}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--operator-id", default=DEFAULT_OPERATOR_ID)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", default=True)
    g.add_argument("--commit", action="store_true")
    args = ap.parse_args()
    commit = bool(args.commit)

    plan = _load_plan(Path(args.plan).resolve())
    print(f"计划行数: {len(plan)}  模式: {'COMMIT(写入)' if commit else 'DRY-RUN(只读,回滚)'}")
    res = run(plan, args.operator_id, commit=commit)
    c = res["created"]
    print("---- 将创建/已创建 ----")
    print(f"  purchase_order : {c['purchase_order']}")
    print(f"  inspection     : {c['inspection']}")
    print(f"  sku            : {c['sku']}")
    print(f"  stock_event    : {c['stock_event']}")
    print(f"  跳过(已存在)   : {len(res['skipped'])}  {res['skipped'][:8]}{'...' if len(res['skipped'])>8 else ''}")
    print("---- 样例(前5) ----")
    for s in res["samples"]:
        print("  ", s)
    print("\n约束校验(flush)已通过。" + ("已提交。" if commit else "未提交,已回滚(dry-run)。"))


if __name__ == "__main__":
    main()
