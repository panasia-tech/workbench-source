"""新增云端迁移所需表(payment / audit / ops / negotiation / slow_moving /
price_adjustment / inventory_request / asset / schedule / todo / api_key /
export / event_log / logistics)

Revision ID: 024_cloudbase_migration
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "024_cloudbase_migration"
down_revision: Union[str, None] = "023_ai_redraw"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _now() -> sa.sql.elements.TextClause:
    return sa.text("CURRENT_TIMESTAMP")


def _ts_columns() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=_now()),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=_now(),
            server_onupdate=_now(),
        ),
    ]


def upgrade() -> None:
    # ------------------ payment ------------------
    op.create_table(
        "payment_account",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("account_alias", sa.String(64), nullable=False),
        sa.Column("account_hint", sa.String(128), nullable=True),
        sa.Column("channel", sa.String(16), nullable=False),
        sa.Column("usage", sa.String(16), nullable=False),
        sa.Column("is_system_seed", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        *_ts_columns(),
    )
    op.create_index("ix_payment_account_account_alias", "payment_account", ["account_alias"])
    op.create_index("ix_payment_account_channel", "payment_account", ["channel"])
    op.create_index("ix_payment_account_usage", "payment_account", ["usage"])
    op.create_index("ix_payment_account_status", "payment_account", ["status"])

    op.create_table(
        "payment_binding",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("account_id", sa.String(36), sa.ForeignKey("payment_account.id"), nullable=False),
        sa.Column("entity_type", sa.String(16), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=False),
        sa.Column("out_trade_no", sa.String(64), nullable=True),
        sa.Column("direction", sa.String(8), nullable=False),
        sa.Column("expected_amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("alipay_trade_no", sa.String(64), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_payment_binding_account_id", "payment_binding", ["account_id"])
    op.create_index("ix_payment_binding_entity_type", "payment_binding", ["entity_type"])
    op.create_index("ix_payment_binding_entity_id", "payment_binding", ["entity_id"])
    op.create_index("ix_payment_binding_out_trade_no", "payment_binding", ["out_trade_no"])

    op.create_table(
        "payment_transaction",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("account_id", sa.String(36), sa.ForeignKey("payment_account.id"), nullable=False),
        sa.Column("channel", sa.String(16), nullable=False),
        sa.Column("direction", sa.String(8), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("counterparty_hint", sa.String(256), nullable=True),
        sa.Column("out_trade_no", sa.String(64), nullable=True),
        sa.Column("txn_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("source", sa.String(16), nullable=False, server_default="MANUAL"),
        sa.Column("trade_time", sa.DateTime(), nullable=True),
        sa.Column("ingested_at", sa.DateTime(), nullable=True),
        sa.Column("raw", sa.JSON(), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_payment_transaction_account_id", "payment_transaction", ["account_id"])
    op.create_index("ix_payment_transaction_direction", "payment_transaction", ["direction"])
    op.create_index("ix_payment_transaction_out_trade_no", "payment_transaction", ["out_trade_no"])
    op.create_index("ix_payment_transaction_txn_id", "payment_transaction", ["txn_id"])
    op.create_index("ix_payment_transaction_status", "payment_transaction", ["status"])
    op.create_index("ix_payment_transaction_trade_time", "payment_transaction", ["trade_time"])

    # ------------------ audit ------------------
    op.create_table(
        "audit_run",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(64), nullable=False, unique=True),
        sa.Column("account_id", sa.String(36), sa.ForeignKey("payment_account.id"), nullable=True),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("scope", sa.String(16), nullable=False),
        sa.Column("match_window_hours", sa.Integer(), nullable=False, server_default="48"),
        sa.Column("time_start", sa.DateTime(), nullable=True),
        sa.Column("time_end", sa.DateTime(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="RUNNING"),
        sa.Column("summary", sa.JSON(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_audit_run_run_id", "audit_run", ["run_id"])
    op.create_index("ix_audit_run_account_id", "audit_run", ["account_id"])
    op.create_index("ix_audit_run_scope", "audit_run", ["scope"])
    op.create_index("ix_audit_run_status", "audit_run", ["status"])

    op.create_table(
        "audit_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("account_id", sa.String(36), sa.ForeignKey("payment_account.id"), nullable=True),
        sa.Column("entity_type", sa.String(16), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=False),
        sa.Column("idem_key", sa.String(128), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("run_at", sa.DateTime(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        *_ts_columns(),
    )
    op.create_index("ix_audit_task_account_id", "audit_task", ["account_id"])
    op.create_index("ix_audit_task_entity_type", "audit_task", ["entity_type"])
    op.create_index("ix_audit_task_entity_id", "audit_task", ["entity_id"])
    op.create_index("ix_audit_task_idem_key", "audit_task", ["idem_key"])
    op.create_index("ix_audit_task_run_at", "audit_task", ["run_at"])
    op.create_index("ix_audit_task_status", "audit_task", ["status"])

    op.create_table(
        "audit_issue",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("audit_run_id", sa.String(64), nullable=True),
        sa.Column("run_id", sa.String(64), nullable=True),
        sa.Column("account_id", sa.String(36), sa.ForeignKey("payment_account.id"), nullable=True),
        sa.Column("scope", sa.String(16), nullable=False),
        sa.Column("entity_type", sa.String(16), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=False),
        sa.Column("audit_status", sa.String(32), nullable=False),
        sa.Column("matched_txn_ids", sa.JSON(), nullable=False),
        sa.Column("matched_txn_refs", sa.JSON(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_audit_issue_audit_run_id", "audit_issue", ["audit_run_id"])
    op.create_index("ix_audit_issue_entity_type", "audit_issue", ["entity_type"])
    op.create_index("ix_audit_issue_entity_id", "audit_issue", ["entity_id"])
    op.create_index("ix_audit_issue_audit_status", "audit_issue", ["audit_status"])

    # ------------------ ops_task ------------------
    op.create_table(
        "ops_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_type", sa.String(64), nullable=False),
        sa.Column("source", sa.String(64), nullable=True),
        sa.Column("source_idem_key", sa.String(128), nullable=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("priority", sa.String(16), nullable=False, server_default="MEDIUM"),
        sa.Column("entity_type", sa.String(32), nullable=True),
        sa.Column("entity_id", sa.String(64), nullable=True),
        sa.Column("assignee_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="OPEN"),
        sa.Column("resolve_note", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_ops_task_task_type", "ops_task", ["task_type"])
    op.create_index("ix_ops_task_source", "ops_task", ["source"])
    op.create_index("ix_ops_task_source_idem_key", "ops_task", ["source_idem_key"])
    op.create_index("ix_ops_task_assignee_id", "ops_task", ["assignee_id"])
    op.create_index("ix_ops_task_status", "ops_task", ["status"])

    # ------------------ negotiation_task ------------------
    op.create_table(
        "negotiation_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("order_no", sa.String(64), nullable=True),
        sa.Column("purchase_no", sa.String(32), nullable=True),
        sa.Column("trade_no", sa.String(64), nullable=True),
        sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_order.id"), nullable=True),
        sa.Column("item_id", sa.String(36), nullable=True),
        sa.Column("goods_code", sa.String(64), nullable=True),
        sa.Column("serial_no", sa.String(128), nullable=True),
        sa.Column("seller_nickname", sa.String(128), nullable=True),
        sa.Column("product_name", sa.String(256), nullable=True),
        sa.Column("location", sa.String(64), nullable=True),
        sa.Column("inspection_result", sa.String(32), nullable=True),
        sa.Column("inspection_result_text", sa.String(128), nullable=True),
        sa.Column("inspection_description", sa.Text(), nullable=True),
        sa.Column("purchase_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("product_images", sa.JSON(), nullable=False),
        sa.Column("defect_images", sa.JSON(), nullable=False),
        sa.Column("defect_videos", sa.JSON(), nullable=False),
        sa.Column("logistics_tracking_no", sa.String(64), nullable=True),
        sa.Column("inspector_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("inspector_name", sa.String(64), nullable=True),
        sa.Column("inspected_at", sa.DateTime(), nullable=True),
        sa.Column("close_evidence_type", sa.String(32), nullable=True),
        sa.Column("close_evidence_files", sa.JSON(), nullable=False),
        sa.Column("close_note", sa.Text(), nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("closed_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("closed_by_name", sa.String(64), nullable=True),
        sa.Column("cancel_reason", sa.Text(), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(), nullable=True),
        sa.Column("source", sa.String(64), nullable=True),
        sa.Column("source_idem_key", sa.String(128), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="OPEN"),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_negotiation_task_order_no", "negotiation_task", ["order_no"])
    op.create_index("ix_negotiation_task_purchase_no", "negotiation_task", ["purchase_no"])
    op.create_index("ix_negotiation_task_purchase_order_id", "negotiation_task", ["purchase_order_id"])
    op.create_index("ix_negotiation_task_item_id", "negotiation_task", ["item_id"])
    op.create_index("ix_negotiation_task_source_idem_key", "negotiation_task", ["source_idem_key"])
    op.create_index("ix_negotiation_task_status", "negotiation_task", ["status"])

    # ------------------ slow_moving_restock_record ------------------
    op.create_table(
        "slow_moving_restock_record",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("action_type", sa.String(16), nullable=False),
        sa.Column("action_result", sa.String(16), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("status_text", sa.String(64), nullable=True),
        sa.Column("record_type", sa.String(32), nullable=True),
        sa.Column("target_key", sa.String(128), nullable=True),
        sa.Column("task_model_version", sa.Integer(), nullable=True),
        sa.Column("days_in_stock", sa.Integer(), nullable=True),
        sa.Column("goods_code", sa.String(64), nullable=True),
        sa.Column("product_name", sa.String(256), nullable=True),
        sa.Column("model", sa.String(128), nullable=True),
        sa.Column("location", sa.String(64), nullable=True),
        sa.Column("sn", sa.String(128), nullable=True),
        sa.Column("cover", sa.String(512), nullable=True),
        sa.Column("proof_image", sa.String(512), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("transition_reason", sa.String(256), nullable=True),
        sa.Column("item_id", sa.String(36), nullable=True),
        sa.Column("legacy_id", sa.String(64), nullable=True),
        sa.Column("purchase_order_id", sa.String(64), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("updated_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_slow_moving_action_type", "slow_moving_restock_record", ["action_type"])
    op.create_index("ix_slow_moving_status", "slow_moving_restock_record", ["status"])
    op.create_index("ix_slow_moving_target_key", "slow_moving_restock_record", ["target_key"])
    op.create_index("ix_slow_moving_goods_code", "slow_moving_restock_record", ["goods_code"])

    # ------------------ price_adjustment ------------------
    op.create_table(
        "price_adjustment",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("adjustment_no", sa.String(32), nullable=False, unique=True),
        sa.Column("adjustment_id", sa.String(64), nullable=True),
        sa.Column("biz_type", sa.String(16), nullable=False),
        sa.Column("reason_type", sa.String(32), nullable=True),
        sa.Column("reason_text", sa.String(256), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending_review"),
        sa.Column("risk_level", sa.String(16), nullable=True),
        sa.Column("currency", sa.String(8), nullable=False, server_default="CNY"),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("goods_code", sa.String(64), nullable=True),
        sa.Column("item_id", sa.String(64), nullable=True),
        sa.Column("item_snapshot", sa.JSON(), nullable=True),
        sa.Column("product_name", sa.String(256), nullable=True),
        sa.Column("product_model", sa.String(128), nullable=True),
        sa.Column("customer_name", sa.String(128), nullable=True),
        sa.Column("sales_order_id", sa.String(36), nullable=True),
        sa.Column("sales_order_no", sa.String(64), nullable=True),
        sa.Column("sales_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("purchase_order_id", sa.String(36), nullable=True),
        sa.Column("purchase_order_no", sa.String(64), nullable=True),
        sa.Column("purchase_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("alipay_txn_id", sa.String(64), nullable=True),
        sa.Column("out_trade_no", sa.String(64), nullable=True),
        sa.Column("evidence_files", sa.JSON(), nullable=False),
        sa.Column("handling_remark", sa.Text(), nullable=True),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
        sa.Column("paid_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(), nullable=True),
        sa.Column("cancelled_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("cancelled_reason", sa.String(256), nullable=True),
        sa.Column("failed_reason", sa.Text(), nullable=True),
        sa.Column("rejected_reason", sa.Text(), nullable=True),
        sa.Column("duplicate_signature", sa.String(256), nullable=True),
        sa.Column("legacy_ref", sa.String(64), nullable=True),
        sa.Column("source_summary", sa.String(256), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_price_adjustment_adjustment_no", "price_adjustment", ["adjustment_no"])
    op.create_index("ix_price_adjustment_adjustment_id", "price_adjustment", ["adjustment_id"])
    op.create_index("ix_price_adjustment_biz_type", "price_adjustment", ["biz_type"])
    op.create_index("ix_price_adjustment_status", "price_adjustment", ["status"])
    op.create_index("ix_price_adjustment_sales_order_id", "price_adjustment", ["sales_order_id"])
    op.create_index("ix_price_adjustment_purchase_order_id", "price_adjustment", ["purchase_order_id"])
    op.create_index("ix_price_adjustment_dup_sig", "price_adjustment", ["duplicate_signature"])

    op.create_table(
        "price_adjustment_log",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("adjustment_id", sa.String(36), sa.ForeignKey("price_adjustment.id"), nullable=False),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_price_adjustment_log_adjustment_id", "price_adjustment_log", ["adjustment_id"])
    op.create_index("ix_price_adjustment_log_created_at", "price_adjustment_log", ["created_at"])

    # ------------------ inventory_request ------------------
    op.create_table(
        "inventory_manual_request",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("request_no", sa.String(32), nullable=False, unique=True),
        sa.Column("request_type", sa.String(16), nullable=False),
        sa.Column("source", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("request_payload", sa.JSON(), nullable=True),
        sa.Column("item_snapshot", sa.JSON(), nullable=True),
        sa.Column("review_decision", sa.String(16), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("executed_result", sa.JSON(), nullable=True),
        sa.Column("ops_task_id", sa.String(36), nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_inventory_manual_request_no", "inventory_manual_request", ["request_no"])
    op.create_index("ix_inventory_manual_request_type", "inventory_manual_request", ["request_type"])
    op.create_index("ix_inventory_manual_request_status", "inventory_manual_request", ["status"])

    op.create_table(
        "inventory_listing_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("listing_id", sa.String(64), nullable=True),
        sa.Column("listing_title", sa.String(256), nullable=True),
        sa.Column("listing_model", sa.String(128), nullable=True),
        sa.Column("listing_status", sa.String(32), nullable=True),
        sa.Column("model_key", sa.String(128), nullable=True),
        sa.Column("reason_type", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("in_stock_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_detected_at", sa.DateTime(), nullable=True),
        sa.Column("resolve_note", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_inventory_listing_task_listing_id", "inventory_listing_task", ["listing_id"])
    op.create_index("ix_inventory_listing_task_model_key", "inventory_listing_task", ["model_key"])
    op.create_index("ix_inventory_listing_task_status", "inventory_listing_task", ["status"])

    # ------------------ asset ------------------
    op.create_table(
        "asset_device",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("asset_no", sa.String(32), nullable=False, unique=True),
        sa.Column("device_name", sa.String(128), nullable=False),
        sa.Column("device_sn", sa.String(128), nullable=True),
        sa.Column("sn_normalized", sa.String(128), nullable=True),
        sa.Column("device_type", sa.String(64), nullable=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("owner_name", sa.String(64), nullable=True),
        sa.Column("owner_account", sa.String(64), nullable=True),
        sa.Column("office_site", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="IDLE"),
        sa.Column("purpose", sa.String(256), nullable=True),
        sa.Column("purchase_date", sa.Date(), nullable=True),
        sa.Column("cost", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("image_files", sa.JSON(), nullable=False),
        *_ts_columns(),
    )
    op.create_index("ix_asset_device_asset_no", "asset_device", ["asset_no"])
    op.create_index("ix_asset_device_sn_normalized", "asset_device", ["sn_normalized"])
    op.create_index("ix_asset_device_owner_id", "asset_device", ["owner_id"])
    op.create_index("ix_asset_device_office_site", "asset_device", ["office_site"])
    op.create_index("ix_asset_device_status", "asset_device", ["status"])

    op.create_table(
        "asset_inventory_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(128), nullable=False),
        sa.Column("scope_type", sa.String(16), nullable=False),
        sa.Column("office_site", sa.String(64), nullable=True),
        sa.Column("device_type", sa.String(64), nullable=True),
        sa.Column("deadline", sa.DateTime(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="OPEN"),
        sa.Column("total_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("checked_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("abnormal_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_check_at", sa.DateTime(), nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_asset_inventory_task_status", "asset_inventory_task", ["status"])

    op.create_table(
        "asset_inventory_record",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(64), nullable=True),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("asset_device.id"), nullable=True),
        sa.Column("asset_no", sa.String(32), nullable=True),
        sa.Column("device_name", sa.String(128), nullable=True),
        sa.Column("device_sn", sa.String(128), nullable=True),
        sa.Column("sn_normalized", sa.String(128), nullable=True),
        sa.Column("office_site", sa.String(64), nullable=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("owner_name", sa.String(64), nullable=True),
        sa.Column("owner_account", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("result", sa.String(16), nullable=False, server_default="UNSET"),
        sa.Column("checked_at", sa.DateTime(), nullable=True),
        sa.Column("checked_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("cycle_type", sa.String(32), nullable=True),
        sa.Column("due_at", sa.DateTime(), nullable=True),
        sa.Column("period_key", sa.String(16), nullable=True),
        sa.Column("period_title", sa.String(64), nullable=True),
        sa.Column("alipay_trade_no", sa.String(64), nullable=True),
        sa.Column("order_no", sa.String(64), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_asset_inv_record_task_id", "asset_inventory_record", ["task_id"])
    op.create_index("ix_asset_inv_record_device_id", "asset_inventory_record", ["device_id"])
    op.create_index("ix_asset_inv_record_asset_no", "asset_inventory_record", ["asset_no"])
    op.create_index("ix_asset_inv_record_status", "asset_inventory_record", ["status"])

    op.create_table(
        "asset_reduction_request",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("request_no", sa.String(32), nullable=False, unique=True),
        sa.Column("asset_no", sa.String(32), nullable=True),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("asset_device.id"), nullable=True),
        sa.Column("device_name", sa.String(128), nullable=True),
        sa.Column("device_sn", sa.String(128), nullable=True),
        sa.Column("before_status", sa.String(16), nullable=True),
        sa.Column("target_status", sa.String(16), nullable=True),
        sa.Column("reason", sa.String(32), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("attachments", sa.JSON(), nullable=False),
        sa.Column("office_site", sa.String(64), nullable=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("owner_name", sa.String(64), nullable=True),
        sa.Column("owner_account", sa.String(64), nullable=True),
        sa.Column("requested_at", sa.DateTime(), nullable=True),
        sa.Column("requested_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        *_ts_columns(),
    )
    op.create_index("ix_asset_reduction_request_no", "asset_reduction_request", ["request_no"])
    op.create_index("ix_asset_reduction_asset_no", "asset_reduction_request", ["asset_no"])
    op.create_index("ix_asset_reduction_status", "asset_reduction_request", ["status"])

    # ------------------ schedule ------------------
    op.create_table(
        "staff_schedule_log",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("log_id", sa.String(64), nullable=True),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("month", sa.String(8), nullable=True),
        sa.Column("target_date", sa.Date(), nullable=True),
        sa.Column("before_status", sa.String(16), nullable=True),
        sa.Column("after_status", sa.String(16), nullable=True),
        sa.Column("default_status", sa.String(16), nullable=True),
        sa.Column("source", sa.String(16), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("operator_mode", sa.String(16), nullable=True),
        sa.Column("target_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_staff_schedule_log_log_id", "staff_schedule_log", ["log_id"])
    op.create_index("ix_staff_schedule_log_action", "staff_schedule_log", ["action"])
    op.create_index("ix_staff_schedule_log_month", "staff_schedule_log", ["month"])
    op.create_index("ix_staff_schedule_log_target_date", "staff_schedule_log", ["target_date"])
    op.create_index("ix_staff_schedule_log_target_id", "staff_schedule_log", ["target_id"])
    op.create_index("ix_staff_schedule_log_created_at", "staff_schedule_log", ["created_at"])

    op.create_table(
        "staff_schedule_override",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("target_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("target_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("source", sa.String(16), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_staff_schedule_override_target_id", "staff_schedule_override", ["target_id"])
    op.create_index("ix_staff_schedule_override_date", "staff_schedule_override", ["target_date"])

    op.create_table(
        "staff_schedule_holiday_request",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("target_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("reviewed_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_staff_schedule_holiday_target_id", "staff_schedule_holiday_request", ["target_id"])
    op.create_index("ix_staff_schedule_holiday_status", "staff_schedule_holiday_request", ["status"])

    # ------------------ todo ------------------
    op.create_table(
        "todo_task_template",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("template_id", sa.String(64), nullable=False, unique=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("priority", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("effective_date", sa.Date(), nullable=True),
        sa.Column("due_at", sa.DateTime(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("remind_mode", sa.String(16), nullable=True),
        sa.Column("strong_remind", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("assignee_user_ids", sa.JSON(), nullable=False),
        sa.Column("assignee_names", sa.JSON(), nullable=False),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_todo_task_template_template_id", "todo_task_template", ["template_id"])
    op.create_index("ix_todo_task_template_effective_date", "todo_task_template", ["effective_date"])
    op.create_index("ix_todo_task_template_status", "todo_task_template", ["status"])

    op.create_table(
        "todo_task_assignment",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("assignment_id", sa.String(128), nullable=False, unique=True),
        sa.Column("task_template_id", sa.String(64), nullable=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("user_name", sa.String(64), nullable=True),
        sa.Column("title_snapshot", sa.String(256), nullable=True),
        sa.Column("content_snapshot", sa.Text(), nullable=True),
        sa.Column("remark_snapshot", sa.Text(), nullable=True),
        sa.Column("priority", sa.String(16), nullable=True),
        sa.Column("effective_date", sa.Date(), nullable=True),
        sa.Column("due_at", sa.DateTime(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("remind_visible", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("completed_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_todo_task_assignment_assignment_id", "todo_task_assignment", ["assignment_id"])
    op.create_index("ix_todo_task_assignment_template_id", "todo_task_assignment", ["task_template_id"])
    op.create_index("ix_todo_task_assignment_user_id", "todo_task_assignment", ["user_id"])
    op.create_index("ix_todo_task_assignment_status", "todo_task_assignment", ["status"])

    op.create_table(
        "todo_task_log",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("template_id", sa.String(64), nullable=True),
        sa.Column("assignment_id", sa.String(128), nullable=True),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_todo_task_log_template_id", "todo_task_log", ["template_id"])
    op.create_index("ix_todo_task_log_assignment_id", "todo_task_log", ["assignment_id"])
    op.create_index("ix_todo_task_log_created_at", "todo_task_log", ["created_at"])

    # ------------------ api_key ------------------
    op.create_table(
        "api_key",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("key_hash", sa.String(512), nullable=False),
        sa.Column("scopes", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_api_key_name", "api_key", ["name"])
    op.create_index("ix_api_key_status", "api_key", ["status"])

    # ------------------ export_task ------------------
    op.create_table(
        "export_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("filters", sa.JSON(), nullable=True),
        sa.Column("time_start", sa.DateTime(), nullable=True),
        sa.Column("time_end", sa.DateTime(), nullable=True),
        sa.Column("file_path", sa.String(512), nullable=True),
        sa.Column("file_id", sa.String(512), nullable=True),
        sa.Column("row_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("include_sensitive", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("truncated", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts_columns(),
    )
    op.create_index("ix_export_task_type", "export_task", ["type"])
    op.create_index("ix_export_task_status", "export_task", ["status"])

    # ------------------ event_log ------------------
    op.create_table(
        "event_log",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("entity_type", sa.String(32), nullable=True),
        sa.Column("entity_id", sa.String(64), nullable=True),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("occurred_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_event_log_event_type", "event_log", ["event_type"])
    op.create_index("ix_event_log_entity_type", "event_log", ["entity_type"])
    op.create_index("ix_event_log_entity_id", "event_log", ["entity_id"])
    op.create_index("ix_event_log_occurred_at", "event_log", ["occurred_at"])
    op.create_index("ix_event_log_created_at", "event_log", ["created_at"])

    # ------------------ logistics_track_event ------------------
    op.create_table(
        "logistics_track_event",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("tracking_no", sa.String(64), nullable=False),
        sa.Column("carrier", sa.String(64), nullable=True),
        sa.Column("event_time", sa.DateTime(), nullable=True),
        sa.Column("status", sa.String(32), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_logistics_track_event_tracking_no", "logistics_track_event", ["tracking_no"])
    op.create_index("ix_logistics_track_event_event_time", "logistics_track_event", ["event_time"])
    op.create_index("ix_logistics_track_event_created_at", "logistics_track_event", ["created_at"])


def downgrade() -> None:
    for table in [
        "logistics_track_event",
        "event_log",
        "export_task",
        "api_key",
        "todo_task_log",
        "todo_task_assignment",
        "todo_task_template",
        "staff_schedule_holiday_request",
        "staff_schedule_override",
        "staff_schedule_log",
        "asset_reduction_request",
        "asset_inventory_record",
        "asset_inventory_task",
        "asset_device",
        "inventory_listing_task",
        "inventory_manual_request",
        "price_adjustment_log",
        "price_adjustment",
        "slow_moving_restock_record",
        "negotiation_task",
        "ops_task",
        "audit_issue",
        "audit_task",
        "audit_run",
        "payment_transaction",
        "payment_binding",
        "payment_account",
    ]:
        op.drop_table(table)
