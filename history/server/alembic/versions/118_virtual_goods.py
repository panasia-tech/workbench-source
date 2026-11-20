"""虚拟商品线：产品卡、卡券库存、聊天认出的订单、显示卡密留痕、退款名单（11-14 销售工作台交付包虚拟线）

Revision ID: 118_virtual_goods
Revises: 117_sales_report
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "118_virtual_goods"
down_revision: Union[str, None] = "117_sales_report"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts():
    return [
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "virtual_product",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("brand", sa.String(64), nullable=True),
        sa.Column("face", sa.String(256), nullable=True),
        sa.Column("path", sa.JSON(), nullable=False),
        sa.Column("delivery", sa.String(16), nullable=False),
        sa.Column("listing_type", sa.String(16), nullable=False),
        sa.Column("step", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("cost", sa.Numeric(12, 2), nullable=True),
        sa.Column("price", sa.Numeric(12, 2), nullable=True),
        sa.Column("platform_fee_rate", sa.Numeric(6, 4), nullable=False),
        sa.Column("after_sale_reserve", sa.Numeric(12, 2), nullable=False),
        sa.Column("valid", sa.String(64), nullable=True),
        sa.Column("region", sa.String(64), nullable=True),
        sa.Column("signals", sa.JSON(), nullable=False),
        sa.Column("peers", sa.JSON(), nullable=False),
        sa.Column("sourcing", sa.JSON(), nullable=False),
        sa.Column("notes", sa.JSON(), nullable=False),
        sa.Column("compliance", sa.JSON(), nullable=False),
        sa.Column("shared_content_enc", sa.Text(), nullable=True),
        sa.Column("item_ids", sa.JSON(), nullable=False),
        sa.Column("warn_at", sa.Integer(), nullable=False),
        sa.Column("stop_at", sa.Integer(), nullable=False),
        sa.Column("auto_delivery", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("checks", sa.JSON(), nullable=False),
        sa.Column("decision", sa.String(16), nullable=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("approved_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("reject_note", sa.Text(), nullable=True),
        *_ts(),
    )
    op.create_index("ix_virtual_product_code", "virtual_product", ["code"], unique=True)
    op.create_index("ix_virtual_product_state", "virtual_product", ["state"])
    op.create_index("ix_virtual_product_owner_id", "virtual_product", ["owner_id"])

    op.create_table(
        "virtual_evidence",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("virtual_product.id"), nullable=False),
        sa.Column("step", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("images", sa.JSON(), nullable=False),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_virtual_evidence_product_id", "virtual_evidence", ["product_id"])

    op.create_table(
        "virtual_code_batch",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("virtual_product.id"), nullable=False),
        sa.Column("no", sa.Integer(), nullable=False),
        sa.Column("supplier", sa.String(128), nullable=True),
        sa.Column("cost", sa.Numeric(12, 2), nullable=True),
        sa.Column("qty", sa.Integer(), nullable=False),
        sa.Column("expire_on", sa.String(16), nullable=True),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_virtual_code_batch_product_id", "virtual_code_batch", ["product_id"])

    op.create_table(
        "virtual_code",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("virtual_product.id"), nullable=False),
        sa.Column("batch_id", sa.String(36), sa.ForeignKey("virtual_code_batch.id"), nullable=False),
        sa.Column("code_enc", sa.Text(), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("order_id", sa.String(36), nullable=True),
        sa.Column("void_note", sa.String(256), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("product_id", "code_hash", name="uq_virtual_code_hash"),
    )
    op.create_index("ix_virtual_code_product_id", "virtual_code", ["product_id"])
    op.create_index("ix_virtual_code_batch_id", "virtual_code", ["batch_id"])
    op.create_index("ix_virtual_code_status", "virtual_code", ["status"])
    op.create_index("ix_virtual_code_order_id", "virtual_code", ["order_id"])

    op.create_table(
        "virtual_order",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("virtual_product.id"), nullable=False),
        sa.Column("paid_msg_id", sa.String(36), nullable=False, unique=True),
        sa.Column("conversation_id", sa.String(36), nullable=False),
        sa.Column("account_id", sa.String(36), nullable=True),
        sa.Column("item_id", sa.String(64), nullable=True),
        sa.Column("buyer_key", sa.String(128), nullable=True),
        sa.Column("buyer_name", sa.String(128), nullable=True),
        sa.Column("amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("paid_at", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("hits", sa.JSON(), nullable=False),
        sa.Column("platform_status", sa.String(64), nullable=True),
        sa.Column("code_id", sa.String(36), nullable=True),
        sa.Column("send_task_id", sa.String(36), nullable=True),
        sa.Column("send_error", sa.String(256), nullable=True),
        sa.Column("sent_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("sent_at", sa.DateTime(), nullable=True),
        sa.Column("released_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        *_ts(),
    )
    op.create_index("ix_virtual_order_product_id", "virtual_order", ["product_id"])
    op.create_index("ix_virtual_order_conversation_id", "virtual_order", ["conversation_id"])
    op.create_index("ix_virtual_order_buyer_key", "virtual_order", ["buyer_key"])
    op.create_index("ix_virtual_order_paid_at", "virtual_order", ["paid_at"])
    op.create_index("ix_virtual_order_status", "virtual_order", ["status"])

    op.create_table(
        "virtual_reveal",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code_id", sa.String(36), nullable=True),
        sa.Column("product_id", sa.String(36), nullable=False),
        sa.Column("order_id", sa.String(36), nullable=True),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_virtual_reveal_code_id", "virtual_reveal", ["code_id"])
    op.create_index("ix_virtual_reveal_product_id", "virtual_reveal", ["product_id"])

    op.create_table(
        "virtual_buyer_flag",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("buyer_key", sa.String(128), nullable=False, unique=True),
        sa.Column("buyer_name", sa.String(128), nullable=True),
        sa.Column("refunds", sa.Integer(), nullable=False),
        sa.Column("blacklisted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("note", sa.String(256), nullable=True),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    for t in ("virtual_buyer_flag", "virtual_reveal", "virtual_order", "virtual_code", "virtual_code_batch",
              "virtual_evidence", "virtual_product"):
        op.drop_table(t)
