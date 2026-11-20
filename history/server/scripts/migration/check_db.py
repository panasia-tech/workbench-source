"""迁移后体检:逐表统计、金额抽样、孤儿 FK、脏数据落 0 复核。

跑法:
    cd server
    python3 -m scripts.migration.check_db
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import func, select

from app.database import SessionLocal
from app.models.asset import AssetDevice, AssetInventoryRecord, AssetInventoryTask, AssetReductionRequest
from app.models.audit import AuditIssue, AuditRun, AuditTask
from app.models.inspection import Inspection
from app.models.inventory import Sku, StockEvent
from app.models.inventory_request import InventoryManualRequest
from app.models.listing import SkuListingInfo
from app.models.payment import PaymentAccount, PaymentBinding, PaymentTransaction
from app.models.purchase import PurchaseOrder
from app.models.sales import SaleOrder
from app.models.staff import Staff


def count(db, model):
    return db.execute(select(func.count()).select_from(model)).scalar() or 0


def amount_stats(db, model, column):
    row = db.execute(
        select(
            func.count(column).label("n"),
            func.sum(column).label("total"),
            func.min(column).label("min"),
            func.max(column).label("max"),
            func.avg(column).label("avg"),
        )
    ).one()
    return row


def main() -> None:
    db = SessionLocal()
    try:
        print("=" * 60)
        print("行数统计")
        print("=" * 60)
        tables = [
            ("staff", Staff),
            ("payment_account", PaymentAccount),
            ("purchase_order", PurchaseOrder),
            ("sale_order", SaleOrder),
            ("sku", Sku),
            ("inspection", Inspection),
            ("stock_event", StockEvent),
            ("sku_listing_info", SkuListingInfo),
            ("payment_binding", PaymentBinding),
            ("payment_transaction", PaymentTransaction),
            ("audit_run", AuditRun),
            ("audit_task", AuditTask),
            ("audit_issue", AuditIssue),
            ("inventory_manual_request", InventoryManualRequest),
            ("asset_device", AssetDevice),
            ("asset_inventory_task", AssetInventoryTask),
            ("asset_inventory_record", AssetInventoryRecord),
            ("asset_reduction_request", AssetReductionRequest),
        ]
        for name, model in tables:
            print(f"  {name:30s} {count(db, model):>8}")

        print()
        print("=" * 60)
        print("金额字段统计(回填是否生效)")
        print("=" * 60)
        amount_checks = [
            ("purchase_order.unit_price", PurchaseOrder, PurchaseOrder.unit_price),
            ("sale_order.amount", SaleOrder, SaleOrder.amount),
            ("sku.cost_price", Sku, Sku.cost_price),
            ("payment_transaction.amount", PaymentTransaction, PaymentTransaction.amount),
        ]
        for label, model, col in amount_checks:
            r = amount_stats(db, model, col)
            print(f"  {label}")
            print(
                f"    非 NULL={r.n}  总和={r.total or 0}  最小={r.min or 0}  最大={r.max or 0}  平均={r.avg or 0}"
            )
            zero_cnt = db.execute(
                select(func.count()).select_from(model).where(col == Decimal("0.00"))
            ).scalar() or 0
            print(f"    =0 行数={zero_cnt}")

        print()
        print("=" * 60)
        print("脏数据落 0 复核(应能在 purchase_order/sale_order/sku 各找到 1 条)")
        print("=" * 60)
        # 4 条云端科学记数法溢出的脏数据应该被落 0
        # cloud_id → 检查 unit_price/amount/cost_price=0
        po_zero = db.execute(
            select(func.count()).select_from(PurchaseOrder).where(PurchaseOrder.unit_price == Decimal("0.00"))
        ).scalar()
        so_zero_amount = db.execute(
            select(func.count()).select_from(SaleOrder).where(SaleOrder.amount == Decimal("0.00"))
        ).scalar()
        sku_zero_cost = db.execute(
            select(func.count()).select_from(Sku).where(Sku.cost_price == Decimal("0.00"))
        ).scalar()
        print(f"  purchase_order.unit_price=0: {po_zero}")
        print(f"  sale_order.amount=0:         {so_zero_amount}")
        print(f"  sku.cost_price=0:            {sku_zero_cost}")
        print("  注:0 不一定全是脏数据,云端确实可能 amountFen=0(待支付/虚拟单)")

        print()
        print("=" * 60)
        print("孤儿 FK 检查(stock_event 是 nullable,容易漏)")
        print("=" * 60)
        se_total = db.execute(select(func.count()).select_from(StockEvent)).scalar()
        se_null_sku = db.execute(
            select(func.count()).select_from(StockEvent).where(StockEvent.sku_id.is_(None))
        ).scalar()
        se_null_po = db.execute(
            select(func.count()).select_from(StockEvent).where(StockEvent.purchase_order_id.is_(None))
        ).scalar()
        print(f"  stock_event 总数={se_total}")
        print(f"  sku_id IS NULL={se_null_sku}  (上游 items 没有对应 PO 跳过导致)")
        print(f"  purchase_order_id IS NULL={se_null_po}")

        print()
        print("=" * 60)
        print("Inspection 占位行(迁移注入)")
        print("=" * 60)
        insp_total = db.execute(select(func.count()).select_from(Inspection)).scalar()
        insp_mig = db.execute(
            select(func.count()).select_from(Inspection).where(Inspection.inspect_no.like("INS-MIG-%"))
        ).scalar()
        print(f"  inspection 总数={insp_total}  其中迁移占位={insp_mig}")

        print()
        print("=" * 60)
        print("Staff 状态分布")
        print("=" * 60)
        for st in ["ACTIVE", "DISABLED", "PENDING"]:
            n = db.execute(
                select(func.count()).select_from(Staff).where(Staff.status == st)
            ).scalar()
            print(f"  {st}: {n}")

    finally:
        db.close()


if __name__ == "__main__":
    main()
