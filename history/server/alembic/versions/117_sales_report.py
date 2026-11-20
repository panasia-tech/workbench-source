"""销售「遇到没见过的情况」上报（11-14 对齐销售工作台交付包）

Revision ID: 117_sales_report
Revises: 116_sales_team
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "117_sales_report"
down_revision: Union[str, None] = "116_sales_team"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sales_report",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("sku_code", sa.String(64), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("answered_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("answered_at", sa.DateTime(), nullable=True),
        sa.Column("is_rule", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("seen", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_sales_report_created_by_id", "sales_report", ["created_by_id"])
    op.create_index("ix_sales_report_state", "sales_report", ["state"])
    op.create_index("ix_sales_report_is_rule", "sales_report", ["is_rule"])


def downgrade() -> None:
    op.drop_table("sales_report")
