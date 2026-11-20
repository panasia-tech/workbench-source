"""31 条 items 缺口补迁 - 第2步:写库。**默认 dry-run。**

与方案A(legacy 占位)不同:这批有真实数据且采购单已在生产,所以:
  - 按 po_purchase_no(=生产 order_no)关联**已存在的生产 PO**,不新建 PO;
  - 该 PO 已有 inspection 则复用,否则补一个占位 inspection(DONE/PASSED);
  - 成本:item 自带为 0 时回退取生产 PO.unit_price(真实成本);
  - sku 用真实字段(序列号/图片/型号),sku_code 撞库自动加 # 后缀;
  - stock_event(INBOUND, payload.source=ITEMS_TOPUP + cloud_item_id 做幂等键)。

用法(生产服务器):
  python -m scripts.migration.legacy_excel.migrate_items_topup \
      --plan data/legacy_excel/items_topup_plan.jsonl --dry-run
  python -m scripts.migration.legacy_excel.migrate_items_topup \
      --plan data/legacy_excel/items_topup_plan.jsonl --commit
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select

from app.database import SessionLocal
from app.enums import InspectionStatus, SkuStatus, StockEventType
from app.models.inspection import Inspection
from app.models.inventory import Sku, StockEvent
from app.models.purchase import PurchaseOrder
from app.models.staff import new_uuid

DEFAULT_OPERATOR_ID = "4e9c34b9-3ad8-40f9-ae1f-b634e320f51a"


class UniqueGuard:
    """撞键时追加 #2/#3... 后缀(指定 max_len 时截断主体腾出后缀位)。"""

    def __init__(self) -> None:
        self._seen: dict[str, set[str]] = {}

    def ensure(self, scope: str, value: str, max_len: int | None = None) -> str:
        seen = self._seen.setdefault(scope, set())
        candidate = value if max_len is None else value[:max_len]
        if candidate not in seen:
            seen.add(candidate)
            return candidate
        i = 2
        while True:
            suffix = f"#{i}"
            base = value if max_len is None else value[: max(0, max_len - len(suffix))]
            cand = base + suffix
            if cand not in seen:
                seen.add(cand)
                return cand
            i += 1


def _dt(ms):
    if not ms:
        return None
    try:
        return datetime.utcfromtimestamp(int(ms) / 1000)
    except (TypeError, ValueError, OSError):
        return None


def run(plan: list[dict], operator_id: str, *, commit: bool) -> dict:
    db = SessionLocal()
    created = {"inspection": 0, "sku": 0, "stock_event": 0, "reused_inspection": 0}
    skipped, unresolved_po, samples = [], [], []
    try:
        guard = UniqueGuard()
        existing_sku = set(db.scalars(select(Sku.sku_code)).all())
        for c in existing_sku:
            guard.ensure("sku.sku_code", c, max_len=64)  # 预占已存在码,后缀从已存在的避让

        # 已补迁过的 cloud_item_id(幂等键)
        done_items = set()
        for (payload,) in db.execute(select(StockEvent.payload)).all():
            if isinstance(payload, dict) and payload.get("source") == "ITEMS_TOPUP" and payload.get("cloud_item_id"):
                done_items.add(payload["cloud_item_id"])

        # 关联生产 PO:按 order_no(=purchaseNo) / fallback / external_order_no
        order_nos = {e["po_purchase_no"] for e in plan if e.get("po_purchase_no")}
        order_nos |= {e["po_fallback_order_no"] for e in plan if e.get("po_fallback_order_no")}
        po_by_order = {
            po.order_no: po
            for po in db.scalars(select(PurchaseOrder).where(PurchaseOrder.order_no.in_(order_nos))).all()
        }
        ext_nos = {e["po_external_no"] for e in plan if e.get("po_external_no")}
        po_by_ext = {
            po.external_order_no: po
            for po in db.scalars(select(PurchaseOrder).where(PurchaseOrder.external_order_no.in_(ext_nos))).all()
            if po.external_order_no
        }
        # 该 PO 已有的 inspection
        insp_by_po = {
            ins.purchase_order_id: ins
            for ins in db.scalars(select(Inspection)).all()
        }
        new_insp_for_po: dict[str, str] = {}

        for e in plan:
            cid = e["cloud_item_id"]
            if cid in done_items:
                skipped.append(cid)
                continue
            po = (po_by_order.get(e.get("po_purchase_no"))
                  or po_by_order.get(e.get("po_fallback_order_no"))
                  or po_by_ext.get(e.get("po_external_no")))
            if not po:
                unresolved_po.append(cid)
                continue

            # inspection: 复用已有 / 本轮已建 / 新建占位
            insp_id = None
            if po.id in insp_by_po:
                insp_id = insp_by_po[po.id].id
                created["reused_inspection"] += 1
            elif po.id in new_insp_for_po:
                insp_id = new_insp_for_po[po.id]
            else:
                insp_id = new_uuid()
                ins = Inspection(
                    id=insp_id, inspect_no=guard.ensure("inspection.inspect_no", f"IN{po.order_no}", max_len=32),
                    purchase_order_id=po.id, action_type="INBOUND", inspection_result="PASSED",
                    location_code=e.get("location_code"), status=InspectionStatus.DONE,
                    inspector_id=operator_id, inspected_at=_dt(e.get("inbound_ms")),
                    remark="items->sku 补迁(6/9漏迁修复)",
                )
                db.add(ins)
                new_insp_for_po[po.id] = insp_id
                created["inspection"] += 1

            cost = Decimal(str(e.get("cost_price") or 0)).quantize(Decimal("0.01"))
            if cost == 0 and po.unit_price:  # item 无成本 -> 回退取生产 PO 成本
                cost = po.unit_price
            sku_code = guard.ensure("sku.sku_code", e["raw_sku_code"], max_len=64)
            inbound = _dt(e.get("inbound_ms"))
            images = e.get("images") or ([e["cover_url"]] if e.get("cover_url") else [])

            sku_id = new_uuid()
            sku = Sku(
                id=sku_id, sku_code=sku_code, serial_number=e.get("serial_number"),
                purchase_order_id=po.id, inspection_id=insp_id,
                product_name=e["product_name"], model=e.get("model"),
                location_code=(e.get("location_code") or "")[:32] or None,
                cost_price=cost, status=SkuStatus.IN_STOCK,
                cover_url=e.get("cover_url"), images=images, tags=["ITEMS_TOPUP"],
                inbound_at=inbound, outbound_at=_dt(e.get("outbound_ms")),
            )
            if inbound:
                sku.created_at = inbound
            evt = StockEvent(
                id=new_uuid(), purchase_order_id=po.id, sku_id=sku_id,
                event_type=StockEventType.INBOUND, ref_no=po.order_no, operator_id=operator_id,
                payload={"source": "ITEMS_TOPUP", "cloud_item_id": cid,
                         "reason": "2026-06-09 items->sku 漏迁修复",
                         "cost_from_po": bool(not (e.get("cost_price") or 0))},
            )
            db.add_all([sku, evt])
            created["sku"] += 1
            created["stock_event"] += 1
            if len(samples) < 6:
                samples.append({"sku_code": sku_code, "product_name": e["product_name"],
                                "cost": str(cost), "serial": e.get("serial_number"), "po": po.order_no})

        db.flush()
        db.commit() if commit else db.rollback()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return {"created": created, "skipped": skipped, "unresolved_po": unresolved_po, "samples": samples}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--operator-id", default=DEFAULT_OPERATOR_ID)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", default=True)
    g.add_argument("--commit", action="store_true")
    args = ap.parse_args()
    commit = bool(args.commit)

    plan = [json.loads(l) for l in Path(args.plan).read_text(encoding="utf-8").splitlines() if l.strip()]
    print(f"计划 {len(plan)} 条  模式: {'COMMIT(写入)' if commit else 'DRY-RUN(只读,回滚)'}")
    res = run(plan, args.operator_id, commit=commit)
    c = res["created"]
    print("---- 将创建/已创建 ----")
    print(f"  sku            : {c['sku']}")
    print(f"  inspection(新) : {c['inspection']}   inspection(复用已有PO): {c['reused_inspection']}")
    print(f"  stock_event    : {c['stock_event']}")
    print(f"  跳过(已补迁)   : {len(res['skipped'])}")
    print(f"  PO未关联到(异常): {len(res['unresolved_po'])}  {res['unresolved_po']}")
    print("---- 样例 ----")
    for s in res["samples"]:
        print("  ", s)
    print("\n约束校验通过。" + ("已提交。" if commit else "未提交,已回滚(dry-run)。"))


if __name__ == "__main__":
    main()
