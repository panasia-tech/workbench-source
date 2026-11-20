"""采购入站 webhook 收件箱：purchase_webhook_event

Revision ID: 046_purchase_webhook
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "046_purchase_webhook"
# 注意：本迁移刻意挂在 044 之后（而非 045_groupcontrol），使采购 webhook 可独立于
# 尚未上线的 groupcontrol 部署。groupcontrol(045) 已改挂到本迁移之后。
down_revision: Union[str, None] = "044_lawsuit_evidence_media"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "purchase_webhook_event",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("event_id", sa.String(length=128), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False, server_default="unknown"),
        sa.Column("occurred_at", sa.DateTime(), nullable=True),
        sa.Column("headers", sa.JSON(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="PENDING"),
        sa.Column("ref_type", sa.String(length=32), nullable=True),
        sa.Column("ref_id", sa.String(length=64), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("processed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(
        op.f("ix_purchase_webhook_event_event_id"),
        "purchase_webhook_event",
        ["event_id"],
        unique=True,
    )
    op.create_index(
        op.f("ix_purchase_webhook_event_event_type"),
        "purchase_webhook_event",
        ["event_type"],
        unique=False,
    )
    op.create_index(
        op.f("ix_purchase_webhook_event_status"),
        "purchase_webhook_event",
        ["status"],
        unique=False,
    )
    op.create_index(
        op.f("ix_purchase_webhook_event_ref_id"),
        "purchase_webhook_event",
        ["ref_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_purchase_webhook_event_ref_id"), table_name="purchase_webhook_event")
    op.drop_index(op.f("ix_purchase_webhook_event_status"), table_name="purchase_webhook_event")
    op.drop_index(op.f("ix_purchase_webhook_event_event_type"), table_name="purchase_webhook_event")
    op.drop_index(op.f("ix_purchase_webhook_event_event_id"), table_name="purchase_webhook_event")
    op.drop_table("purchase_webhook_event")
