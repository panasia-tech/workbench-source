"""所有 ETL step 的注册中心。"""

from scripts.migration.common import EtlStep
from scripts.migration.etl import (
    api_key as _api_key,
    asset as _asset,
    audit as _audit,
    event_log as _event_log,
    export as _export,
    inventory as _inventory,
    inventory_req as _inv_req,
    issue_merge as _issue_merge,
    items as _items,
    logistics as _logistics,
    negotiation as _negotiation,
    ops as _ops,
    payment_txn as _payment_txn,
    price_adjustment as _price_adj,
    purchase as _purchase,
    sales as _sales,
    schedule as _schedule,
    slow_moving as _slow_moving,
    todo as _todo,
    users_payment as _users_payment,
    xianyu as _xianyu,
)

STEPS: list[EtlStep] = [
    # ---- 阶段 1: 核心依赖 ----
    EtlStep("users", "users", _users_payment.run_users),
    EtlStep("payment_accounts", "payment_accounts", _users_payment.run_payment_accounts),
    # ---- 阶段 2: 业务主表 ----
    EtlStep("purchase_orders", "purchase_orders", _purchase.run, depends_on=["users"]),
    EtlStep("sales_orders", "sales_orders", _sales.run, depends_on=["users", "payment_accounts"]),
    EtlStep("items", "items", _items.run, depends_on=["purchase_orders"]),
    EtlStep("inventory_ledger", "inventory_ledger", _inventory.run, depends_on=["items", "users"]),
    EtlStep("xianyu_listings", "xianyu_listings", _xianyu.run, depends_on=["items"]),
    # ---- 阶段 3: 对账/支付 ----
    EtlStep("payment_bindings", "payment_bindings", _payment_txn.run_bindings, depends_on=["payment_accounts"]),
    EtlStep("payment_transactions", "payment_transactions", _payment_txn.run_transactions, depends_on=["payment_accounts"]),
    EtlStep("audit_runs", "audit_runs", _audit.run_runs, depends_on=["payment_accounts", "users"]),
    EtlStep("audit_tasks", "audit_tasks", _audit.run_tasks, depends_on=["payment_accounts"]),
    EtlStep("audit_issues", "audit_issues", _audit.run_issues, depends_on=["payment_accounts"]),
    # ---- 阶段 4: 业务工单 ----
    EtlStep("ops_tasks", "ops_tasks", _ops.run, depends_on=["users"]),
    EtlStep("negotiation_tasks", "negotiation_tasks", _negotiation.run, depends_on=["users", "purchase_orders"]),
    EtlStep("slow_moving", "slow_moving_restock_records", _slow_moving.run, depends_on=["users"]),
    EtlStep("price_adjustments", "price_adjustments", _price_adj.run_adjustments, depends_on=["users"]),
    EtlStep("price_adjustment_logs", "price_adjustment_logs", _price_adj.run_logs, depends_on=["price_adjustments"]),
    EtlStep("issue_tickets_merge", "issue_tickets", _issue_merge.run, depends_on=["purchase_orders"]),
    EtlStep("inventory_manual_requests", "inventory_manual_requests", _inv_req.run_manual, depends_on=["users"]),
    EtlStep("inventory_listing_tasks", "inventory_listing_tasks", _inv_req.run_listing, depends_on=["users"]),
    # ---- 阶段 5: 辅助模块 ----
    EtlStep("asset_devices", "asset_devices", _asset.run_devices, depends_on=["users"]),
    EtlStep("asset_inventory_tasks", "asset_inventory_tasks", _asset.run_tasks, depends_on=["users"]),
    EtlStep("asset_inventory_records", "asset_inventory_records", _asset.run_records, depends_on=["asset_devices", "asset_inventory_tasks"]),
    EtlStep("asset_reduction_requests", "asset_reduction_requests", _asset.run_reductions, depends_on=["asset_devices"]),
    EtlStep("staff_schedule_logs", "staff_schedule_logs", _schedule.run_logs, depends_on=["users"]),
    EtlStep("staff_schedule_overrides", "staff_schedule_overrides", _schedule.run_overrides, depends_on=["users"]),
    EtlStep("staff_schedule_holiday_requests", "staff_schedule_holiday_requests", _schedule.run_holidays, depends_on=["users"]),
    EtlStep("todo_task_templates", "todo_task_templates", _todo.run_templates, depends_on=["users"]),
    EtlStep("todo_task_assignments", "todo_task_assignments", _todo.run_assignments, depends_on=["users"]),
    EtlStep("todo_task_logs", "todo_task_logs", _todo.run_logs, depends_on=["users"]),
    EtlStep("api_keys", "llm_api_keys", _api_key.run, depends_on=["users"]),
    EtlStep("export_tasks", "export_tasks", _export.run, depends_on=["users"]),
    # ---- 阶段 6: 历史归档 ----
    EtlStep("logistics_track_events", "logistics_track_events", _logistics.run),
    EtlStep("event_log", "event_log", _event_log.run, depends_on=["users"]),
]
