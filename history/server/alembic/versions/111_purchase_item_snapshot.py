"""采购商品快照（W04 / PC-047～050）：平台商品 ID、原链接、原文多版本

Revision ID: 111_purchase_item_snapshot
Revises: 110_spu_image_archive
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "111_purchase_item_snapshot"
down_revision: Union[str, None] = "110_spu_image_archive"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "purchase_item_snapshot",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_order.id"), nullable=True),
        sa.Column("platform", sa.String(32), nullable=False, server_default="xianyu"),
        sa.Column("platform_item_id", sa.String(64), nullable=True),
        sa.Column("source_url", sa.String(1024), nullable=True),
        sa.Column("title", sa.String(512), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("condition_text", sa.String(128), nullable=True),
        sa.Column("accessories_text", sa.String(512), nullable=True),
        sa.Column("listed_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("seller_name", sa.String(128), nullable=True),
        sa.Column("images", sa.JSON(), nullable=True),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("content_hash", sa.String(64), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("root_id", sa.String(36), sa.ForeignKey("purchase_item_snapshot.id"), nullable=True),
        sa.Column("frozen_at", sa.DateTime(), nullable=True),
        sa.Column("capture_status", sa.String(32), nullable=False, server_default="OK"),
        sa.Column("capture_error", sa.String(255), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_purchase_item_snapshot_purchase_order_id", "purchase_item_snapshot", ["purchase_order_id"])
    op.create_index("ix_purchase_item_snapshot_platform_item_id", "purchase_item_snapshot", ["platform_item_id"])
    op.create_index("ix_purchase_item_snapshot_content_hash", "purchase_item_snapshot", ["content_hash"])


def downgrade() -> None:
    # 直接删表：索引跟着表走；先删索引会被外键挡住（MySQL 1553）
    op.drop_table("purchase_item_snapshot")
