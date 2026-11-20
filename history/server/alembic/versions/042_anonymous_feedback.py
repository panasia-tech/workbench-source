"""新增匿名反馈表（返工/系统反馈/投诉，方案 B 留痕不展示）

Revision ID: 042_anonymous_feedback
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "042_anonymous_feedback"
down_revision: Union[str, None] = "041_outbound_worry_free"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "anonymous_feedback",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=128), nullable=False),
        sa.Column("target", sa.String(length=128), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("attachments", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("handled_note", sa.Text(), nullable=True),
        sa.Column("handled_at", sa.DateTime(), nullable=True),
        sa.Column("handled_by_id", sa.String(length=36), nullable=True),
        sa.Column("handled_by_name", sa.String(length=64), nullable=True),
        # 方案 B：提交人留痕供受限审计，对外接口不返回
        sa.Column("created_by_id", sa.String(length=36), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["handled_by_id"], ["staff.id"]),
        sa.ForeignKeyConstraint(["created_by_id"], ["staff.id"]),
        sa.PrimaryKeyConstraint("id"),
        # 与被引用表 staff 的 utf8mb4_unicode_ci 对齐，否则外键 errno 1215
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(op.f("ix_anonymous_feedback_category"), "anonymous_feedback", ["category"], unique=False)
    op.create_index(op.f("ix_anonymous_feedback_handled_by_id"), "anonymous_feedback", ["handled_by_id"], unique=False)
    op.create_index(op.f("ix_anonymous_feedback_created_by_id"), "anonymous_feedback", ["created_by_id"], unique=False)
    op.create_index(op.f("ix_anonymous_feedback_status"), "anonymous_feedback", ["status"], unique=False)


def downgrade() -> None:
    # MySQL：drop_table 自动级联删除表上的索引与外键；逐个 drop_index 会被外键依赖阻塞(errno 1553)
    op.drop_table("anonymous_feedback")
