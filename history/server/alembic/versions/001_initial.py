"""initial schema v0.2

Revision ID: 001_initial
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "staff",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("password_hash", sa.String(256), nullable=False),
        sa.Column("openid", sa.String(64), nullable=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("shop", sa.String(64), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("username"),
        sa.UniqueConstraint("openid"),
    )

    op.create_table(
        "purchase_account",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("label", sa.String(64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("code"),
    )

    op.create_table(
        "warehouse_location",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("zone", sa.String(32), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("code"),
    )

    op.create_table(
        "purchase_order",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("order_no", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("product_name", sa.String(256), nullable=False),
        sa.Column("brand", sa.String(128), nullable=True),
        sa.Column("model", sa.String(128), nullable=True),
        sa.Column("spec", sa.String(128), nullable=True),
        sa.Column("unit_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("purchase_account", sa.String(64), nullable=True),
        sa.Column("seller_name", sa.String(128), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("screenshot_url", sa.String(512), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("order_no"),
    )
    op.create_index("ix_po_status_created", "purchase_order", ["status", "created_at"])

    op.create_table(
        "inspection",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("inspect_no", sa.String(32), nullable=False),
        sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_order.id"), nullable=False),
        sa.Column("listing_images", sa.JSON(), nullable=False),
        sa.Column("defect_images", sa.JSON(), nullable=False),
        sa.Column("condition_grade", sa.String(16), nullable=True),
        sa.Column("location_code", sa.String(32), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("inspector_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("inspected_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("inspect_no"),
        sa.UniqueConstraint("purchase_order_id"),
    )

    op.create_table(
        "sku",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sku_code", sa.String(64), nullable=False),
        sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_order.id"), nullable=False),
        sa.Column("inspection_id", sa.String(36), sa.ForeignKey("inspection.id"), nullable=False),
        sa.Column("product_name", sa.String(256), nullable=False),
        sa.Column("brand", sa.String(128), nullable=True),
        sa.Column("model", sa.String(128), nullable=True),
        sa.Column("spec", sa.String(128), nullable=True),
        sa.Column("location_code", sa.String(32), nullable=True),
        sa.Column("condition_grade", sa.String(16), nullable=True),
        sa.Column("cost_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("suggest_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("cover_url", sa.String(512), nullable=True),
        sa.Column("images", sa.JSON(), nullable=False),
        sa.Column("inbound_at", sa.DateTime(), nullable=True),
        sa.Column("outbound_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("sku_code"),
        sa.UniqueConstraint("purchase_order_id"),
    )

    op.create_table(
        "sale_order",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("order_no", sa.String(32), nullable=False),
        sa.Column("platform", sa.String(32), nullable=True),
        sa.Column("external_order_no", sa.String(64), nullable=True),
        sa.Column("buyer_name", sa.String(128), nullable=True),
        sa.Column("buyer_phone", sa.String(128), nullable=True),
        sa.Column("amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("screenshot_url", sa.String(512), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("order_no"),
    )

    op.create_table(
        "sales_outbound",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("outbound_no", sa.String(32), nullable=False),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("sale_order_id", sa.String(36), sa.ForeignKey("sale_order.id"), nullable=True),
        sa.Column("buyer_name", sa.String(128), nullable=True),
        sa.Column("outbound_type", sa.String(32), nullable=False),
        sa.Column("sale_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("cost_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("evidence_urls", sa.JSON(), nullable=False),
        sa.Column("payment_screenshot_url", sa.String(512), nullable=True),
        sa.Column("tracking_no", sa.String(64), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("outbound_no"),
    )

    op.create_table(
        "stock_event",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_order.id"), nullable=True),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=True),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("ref_no", sa.String(32), nullable=True),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )

    op.create_table(
        "inventory_adjustment",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("adjust_no", sa.String(32), nullable=False),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("adjust_type", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(512), nullable=True),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("adjust_no"),
    )


def downgrade() -> None:
    for t in (
        "inventory_adjustment",
        "stock_event",
        "sales_outbound",
        "sale_order",
        "sku",
        "inspection",
        "purchase_order",
        "warehouse_location",
        "purchase_account",
        "staff",
    ):
        op.drop_table(t)
