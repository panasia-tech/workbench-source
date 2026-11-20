#!/usr/bin/env python3
"""一次性修复历史遗留的 PENDING_INSPECT 采购单（2026-06-22）。

背景：迁移残留导致 dashboard「待验货」角标曾显示 285，而验货列表只有 10。285 =
  - 10  真正待验：Inspection 状态 PENDING（列表正确显示的这批）
  - 212 已验完：Inspection 状态 DONE（action=INBOUND）且已生成 SKU，但 PO 仍挂 PENDING_INSPECT
  - 63  PENDING_INSPECT 但无任何验货单（迁移占位）

本脚本做两件事：
  A) 对「有 DONE 验货单」的 PENDING_INSPECT 采购单，把 PO 状态对齐到验货结果：
     action=REJECT → CANCELLED；否则（INBOUND/入库）→ IN_STOCK。
  B) 对「无任何验货单」的 PENDING_INSPECT 采购单，补建一条 PENDING 验货单
     （inspect_no 走与建单流程相同的 generate_order_no），使其进入待验货列表可人工补验。

幂等：只处理仍处于上述异常态的行，重复运行不会重复建单 / 重复改状态。
用法：cd /www/wwwroot/py-api && PYTHONPATH=. ./venv/bin/python scripts/fix_pending_inspect_residue.py [--dry-run]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal
from app.enums import InspectionActionType, InspectionStatus, OrderStatus
from app.models import Inspection, PurchaseOrder
from app.services.order_no import generate_order_no


def main():
    dry = "--dry-run" in sys.argv
    db = SessionLocal()
    try:
        # ---- A) 有 DONE 验货单但 PO 仍 PENDING_INSPECT ----
        a_rows = (
            db.query(PurchaseOrder, Inspection)
            .join(Inspection, Inspection.purchase_order_id == PurchaseOrder.id)
            .filter(
                PurchaseOrder.status == OrderStatus.PENDING_INSPECT,
                Inspection.status == InspectionStatus.DONE,
            )
            .all()
        )
        a_in_stock = a_cancelled = 0
        for po, insp in a_rows:
            if insp.action_type == InspectionActionType.REJECT:
                po.status = OrderStatus.CANCELLED
                a_cancelled += 1
            else:
                po.status = OrderStatus.IN_STOCK
                a_in_stock += 1
        print(f"A) 有DONE验货单的PENDING_INSPECT：{len(a_rows)} 条 → IN_STOCK {a_in_stock}，CANCELLED {a_cancelled}")

        # ---- B) PENDING_INSPECT 但无任何验货单 → 补建 PENDING 验货单 ----
        has_insp = db.query(Inspection.purchase_order_id).distinct()
        b_pos = (
            db.query(PurchaseOrder)
            .filter(
                PurchaseOrder.status == OrderStatus.PENDING_INSPECT,
                ~PurchaseOrder.id.in_(has_insp),
            )
            .order_by(PurchaseOrder.created_at.asc())
            .all()
        )
        for po in b_pos:
            inspect_no = generate_order_no(db, "IN", Inspection, "inspect_no")
            db.add(
                Inspection(
                    inspect_no=inspect_no,
                    purchase_order_id=po.id,
                    status=InspectionStatus.PENDING,
                )
            )
            db.flush()  # 让下一个 generate_order_no 看到本次新建，避免撞唯一键
        print(f"B) 无验货单的PENDING_INSPECT：{len(b_pos)} 条 → 补建 PENDING 验货单")

        if dry:
            db.rollback()
            print("[dry-run] 已回滚，未写库")
        else:
            db.commit()
            pending = db.query(Inspection).filter(Inspection.status == InspectionStatus.PENDING).count()
            print(f"已提交。当前 Inspection PENDING（待验货角标/列表）= {pending}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
