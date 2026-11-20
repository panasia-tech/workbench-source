"""图片爬虫按 SPU 搜参考图:任务、审核结论、转存后的参考图

Revision ID: 088_spu_image_search
Revises: 087_listing_approval
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "088_spu_image_search"
down_revision: Union[str, None] = "087_listing_approval"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "spu_image_search",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("spu_id", sa.String(36), sa.ForeignKey("warehouse_spu.id", ondelete="CASCADE"), nullable=False),
        sa.Column("query", sa.String(200), nullable=False),
        sa.Column("task_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("formal_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("reference_url", sa.String(512), nullable=True),
        sa.Column("source_url", sa.String(1024), nullable=True),
        sa.Column("reviewer", sa.String(64), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("checked_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_spu_image_search_spu_id", "spu_image_search", ["spu_id"], unique=True)
    op.create_index("ix_spu_image_search_status", "spu_image_search", ["status"])


def downgrade() -> None:
    op.drop_index("ix_spu_image_search_status", table_name="spu_image_search")
    op.drop_index("ix_spu_image_search_spu_id", table_name="spu_image_search")
    op.drop_table("spu_image_search")
