"""采购工作台 W10：平台订单（执行端只读「我买到的」抓回来）+ 变化事件；采购单挂平台订单

Revision ID: 126_purchase_platform_order
Revises: 125_daily_bill_per_account
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "126_purchase_platform_order"
down_revision: Union[str, None] = "125_daily_bill_per_account"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "purchase_platform_order",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("platform", sa.String(16), nullable=False, server_default="xianyu"),
        sa.Column("buyer_account", sa.String(64), nullable=False),
        sa.Column("purchase_account", sa.String(64), nullable=True),
        sa.Column("platform_order_no", sa.String(64), nullable=False),
        sa.Column("item_id", sa.String(64), nullable=True),
        sa.Column("item_title", sa.String(512), nullable=True),
        sa.Column("item_image", sa.String(1024), nullable=True),
        sa.Column("seller_name", sa.String(128), nullable=True),
        sa.Column("seller_id", sa.String(64), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=True),
        sa.Column("order_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("paid_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("freight", sa.Numeric(12, 2), nullable=True),
        sa.Column("refunded_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("trade_status", sa.String(16), nullable=False, server_default="unknown"),
        sa.Column("pay_status", sa.String(16), nullable=False, server_default="unknown"),
        sa.Column("refund_status", sa.String(16), nullable=False, server_default="none"),
        sa.Column("ship_status", sa.String(16), nullable=False, server_default="unknown"),
        sa.Column("raw_status", sa.String(64), nullable=True),
        sa.Column("tracking_no", sa.String(64), nullable=True),
        sa.Column("logistics_company", sa.String(64), nullable=True),
        sa.Column("ordered_at", sa.DateTime(), nullable=True),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
        sa.Column("platform_updated_at", sa.DateTime(), nullable=True),
        sa.Column("sync_status", sa.String(16), nullable=False, server_default="ok"),
        sa.Column("sync_error", sa.String(255), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(), nullable=True),
        sa.Column("needs_review", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("review_reason", sa.String(255), nullable=True),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("platform", "buyer_account", "platform_order_no", name="uq_purchase_platform_order"),
    )
    op.create_index("ix_purchase_platform_order_purchase_account", "purchase_platform_order", ["purchase_account"])
    op.create_index("ix_purchase_platform_order_platform_order_no", "purchase_platform_order", ["platform_order_no"])
    op.create_index("ix_purchase_platform_order_item_id", "purchase_platform_order", ["item_id"])
    op.create_index("ix_purchase_platform_order_trade_status", "purchase_platform_order", ["trade_status"])
    op.create_index("ix_purchase_platform_order_needs_review", "purchase_platform_order", ["needs_review"])

    op.create_table(
        "purchase_platform_event",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("purchase_platform_order.id"), nullable=False),
        sa.Column("event_key", sa.String(128), nullable=False, unique=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("data", sa.JSON(), nullable=True),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("occurred_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_purchase_platform_event_order_id", "purchase_platform_event", ["order_id"])

    with op.batch_alter_table("purchase_order") as b:
        b.add_column(sa.Column("platform_order_id", sa.String(36), nullable=True))
        b.create_foreign_key("fk_purchase_order_platform_order_id", "purchase_platform_order", ["platform_order_id"], ["id"])
        b.create_index("ix_purchase_order_platform_order_id", ["platform_order_id"])


def downgrade() -> None:
    # MySQL：外键在用的索引删不掉，先删外键
    with op.batch_alter_table("purchase_order") as b:
        b.drop_constraint("fk_purchase_order_platform_order_id", type_="foreignkey")
        b.drop_index("ix_purchase_order_platform_order_id")
        b.drop_column("platform_order_id")
    op.drop_table("purchase_platform_event")
    op.drop_table("purchase_platform_order")
