"""客户退回的货重新验一遍（return_recheck），入库前对照原验货结果

Revision ID: 098_return_recheck
Revises: 097_check_item_defect_detail
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "098_return_recheck"
down_revision: Union[str, None] = "097_check_item_defect_detail"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 不建外键：只按 id 关联，免得和老表的字符集/排序规则对不上（MySQL 3780）
    op.create_table(
        "return_recheck",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("return_order_id", sa.String(36), nullable=False, unique=True),
        sa.Column("sku_id", sa.String(36), nullable=False),
        sa.Column("inspection_id", sa.String(36), nullable=True),
        sa.Column("items", sa.JSON(), nullable=True),
        sa.Column("result", sa.String(16), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("media", sa.JSON(), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=False),
        sa.Column("finished_by", sa.String(36), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_return_recheck_sku_id", "return_recheck", ["sku_id"])


def downgrade() -> None:
    op.drop_table("return_recheck")
