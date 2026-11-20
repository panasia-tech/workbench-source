"""步入式价格清洗：清洗任务、原始样本、价格版本（11-13，口径用户定：中位数 / 3C 诱饵 100 / 已售不算成交 / 7 天算旧 / 管理员生效）

Revision ID: 115_price_clean
Revises: 114_staff_practice
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "115_price_clean"
down_revision: Union[str, None] = "114_staff_practice"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "price_clean_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("crawl_product_id", sa.String(36), nullable=True),
        sa.Column("crawl_price_id", sa.String(36), nullable=True),
        sa.Column("crawl_date", sa.Date(), nullable=True),
        sa.Column("query", sa.String(128), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="OPEN"),
        sa.Column("started_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_price_clean_task_sku_id", "price_clean_task", ["sku_id"])
    op.create_table(
        "price_sample",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("price_clean_task.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(64), nullable=True),
        sa.Column("title", sa.String(512), nullable=True),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("query", sa.String(128), nullable=True),
        sa.Column("item_url", sa.String(1024), nullable=True),
        sa.Column("snapshot_path", sa.String(512), nullable=True),
        sa.Column("price_type", sa.String(16), nullable=False, server_default="LISTING"),
        sa.Column("kept", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("reject_reason", sa.String(128), nullable=True),
        sa.Column("auto", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("outlier", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("edited_by", sa.String(36), nullable=True),
    )
    op.create_index("ix_price_sample_task_id", "price_sample", ["task_id"])
    op.create_table(
        "price_version",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("price_clean_task.id"), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("median", sa.Numeric(12, 2), nullable=True),
        sa.Column("low", sa.Numeric(12, 2), nullable=True),
        sa.Column("high", sa.Numeric(12, 2), nullable=True),
        sa.Column("sample_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.String(8), nullable=True),
        sa.Column("crawl_date", sa.Date(), nullable=True),
        sa.Column("expires_on", sa.Date(), nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("confirmed_by", sa.String(36), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(), nullable=True),
        sa.Column("activated_by", sa.String(36), nullable=True),
        sa.Column("activated_at", sa.DateTime(), nullable=True),
        sa.Column("review_note", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("sku_id", "version", name="uq_price_version_sku_version"),
    )
    op.create_index("ix_price_version_sku_id", "price_version", ["sku_id"])


def downgrade() -> None:
    op.drop_table("price_version")
    op.drop_table("price_sample")
    op.drop_table("price_clean_task")
