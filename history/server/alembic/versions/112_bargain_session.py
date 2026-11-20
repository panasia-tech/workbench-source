"""采购议价状态机（W07 / PC-088）：识别报价还价谈妥

Revision ID: 112_bargain_session
Revises: 111_purchase_item_snapshot
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "112_bargain_session"
down_revision: Union[str, None] = "111_purchase_item_snapshot"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "bargain_session",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("platform", sa.String(32), nullable=False, server_default="xianyu"),
        sa.Column("platform_item_id", sa.String(64), nullable=True),
        sa.Column("source_url", sa.String(1024), nullable=True),
        sa.Column("purchase_account", sa.String(64), nullable=True),
        sa.Column("seller_name", sa.String(128), nullable=True),
        sa.Column("gc_conversation_id", sa.String(36), nullable=True),
        sa.Column("snapshot_id", sa.String(36), sa.ForeignKey("purchase_item_snapshot.id"), nullable=True),
        sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_order.id"), nullable=True),
        sa.Column("state", sa.String(16), nullable=False, server_default="IDENTIFY"),
        sa.Column("paused_from", sa.String(16), nullable=True),
        sa.Column("our_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("their_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("deal_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("listed_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("title", sa.String(512), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("events", sa.JSON(), nullable=True),
        sa.Column("round_no", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("identified_at", sa.DateTime(), nullable=True),
        sa.Column("quoted_at", sa.DateTime(), nullable=True),
        sa.Column("dealt_at", sa.DateTime(), nullable=True),
        sa.Column("paused_at", sa.DateTime(), nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("assignee_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_bargain_session_platform_item_id", "bargain_session", ["platform_item_id"])
    op.create_index("ix_bargain_session_purchase_account", "bargain_session", ["purchase_account"])
    op.create_index("ix_bargain_session_gc_conversation_id", "bargain_session", ["gc_conversation_id"])
    op.create_index("ix_bargain_session_purchase_order_id", "bargain_session", ["purchase_order_id"])
    op.create_index("ix_bargain_session_state", "bargain_session", ["state"])


def downgrade() -> None:
    # 直接删表：索引跟着表走；先删索引会被外键挡住（MySQL 1553）
    op.drop_table("bargain_session")
