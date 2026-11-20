"""新增 pickup_payment 表（自提扫码收款单，支付成功自动出库）

Revision ID: 032_pickup_payment
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "032_pickup_payment"
down_revision: Union[str, None] = "031_purchase_tracking_phone"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pickup_payment",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("out_trade_no", sa.String(64), nullable=False),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("sku_code", sa.String(64), nullable=False),
        sa.Column("buyer_name", sa.String(128), nullable=True),
        sa.Column("sale_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("evidence_urls", sa.JSON(), nullable=True),
        sa.Column("express_fee", sa.Numeric(12, 2), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("subject", sa.String(256), nullable=True),
        sa.Column("qr_code", sa.String(512), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("alipay_trade_no", sa.String(64), nullable=True),
        sa.Column("outbound_id", sa.String(36), sa.ForeignKey("sales_outbound.id"), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        # 被引用表(sku/staff/sales_outbound)均为 utf8mb4_unicode_ci，
        # 必须与之一致，否则外键报 1215（库默认是 general_ci）。
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_unique_constraint("uq_pickup_payment_out_trade_no", "pickup_payment", ["out_trade_no"])
    op.create_index("ix_pickup_payment_sku_id", "pickup_payment", ["sku_id"])
    op.create_index("ix_pickup_payment_sku_code", "pickup_payment", ["sku_code"])
    op.create_index("ix_pickup_payment_operator_id", "pickup_payment", ["operator_id"])
    op.create_index("ix_pickup_payment_status", "pickup_payment", ["status"])
    op.create_index("ix_pickup_payment_alipay_trade_no", "pickup_payment", ["alipay_trade_no"])
    op.create_index("ix_pickup_payment_expires_at", "pickup_payment", ["expires_at"])


def downgrade() -> None:
    op.drop_table("pickup_payment")
