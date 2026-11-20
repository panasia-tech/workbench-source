"""销售协同：主管加派的任务、协同请求（11-14 对齐销售工作台交付包）

Revision ID: 116_sales_team
Revises: 115_price_clean
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "116_sales_team"
down_revision: Union[str, None] = "115_price_clean"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sales_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("due_at", sa.DateTime(), nullable=False),
        sa.Column("sku_code", sa.String(64), nullable=True),
        sa.Column("assignee_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("wait_who", sa.String(64), nullable=True),
        sa.Column("wait_why", sa.String(256), nullable=True),
        sa.Column("wait_until", sa.String(32), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("handoff", sa.Text(), nullable=True),
        sa.Column("done_at", sa.DateTime(), nullable=True),
        sa.Column("log", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_sales_task_assignee_id", "sales_task", ["assignee_id"])
    op.create_index("ix_sales_task_state", "sales_task", ["state"])
    op.create_table(
        "sales_collab",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("sku_code", sa.String(64), nullable=True),
        sa.Column("conversation_id", sa.String(64), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("to_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("taken_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("taken_at", sa.DateTime(), nullable=True),
        sa.Column("done_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_sales_collab_state", "sales_collab", ["state"])


def downgrade() -> None:
    op.drop_table("sales_collab")
    op.drop_table("sales_task")
