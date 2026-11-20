"""OA/台账 MCP 推送发件箱表 oa_push_outbox（本 ERP 作 MCP 客户端向外部 OA 推数据）

Revision ID: 060_oa_push_outbox
Revises: 059_product_type
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "060_oa_push_outbox"
down_revision: Union[str, None] = "059_product_type"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "oa_push_outbox",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("tool", sa.String(length=32), nullable=False),
        sa.Column("arguments", sa.JSON(), nullable=False),
        sa.Column("dedup_key", sa.String(length=191), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="PENDING"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_due_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("remote_id", sa.String(length=64), nullable=True),
        sa.Column("source_type", sa.String(length=32), nullable=True),
        sa.Column("source_id", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("sent_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        # dedup_key 唯一：同一业务事件只入库一次（尤其 finance_record 服务端无防重）
        sa.UniqueConstraint("dedup_key", name="uq_oa_push_dedup_key"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(op.f("ix_oa_push_outbox_tool"), "oa_push_outbox", ["tool"], unique=False)
    op.create_index(op.f("ix_oa_push_outbox_status"), "oa_push_outbox", ["status"], unique=False)
    op.create_index(op.f("ix_oa_push_outbox_next_due_at"), "oa_push_outbox", ["next_due_at"], unique=False)
    op.create_index(op.f("ix_oa_push_outbox_source_id"), "oa_push_outbox", ["source_id"], unique=False)
    op.create_index(op.f("ix_oa_push_outbox_created_at"), "oa_push_outbox", ["created_at"], unique=False)


def downgrade() -> None:
    # MySQL：drop_table 自动级联删除索引/唯一键，逐个 drop 会被依赖阻塞
    op.drop_table("oa_push_outbox")
