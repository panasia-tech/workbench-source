"""listing_channel_category — 上架类目（管理后台勾选）

Revision ID: 015_listing_channel_category
Revises: 014_sku_reserve_source
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "015_listing_channel_category"
down_revision: Union[str, None] = "014_sku_reserve_source"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "listing_channel_category",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("channel_cat_id", sa.String(64), nullable=False),
        sa.Column("channel_cat_name", sa.String(128), nullable=False),
        sa.Column("sp_biz_type", sa.Integer(), nullable=False),
        sa.Column("sp_biz_name", sa.String(64), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("channel_cat_id", name="uq_listing_channel_category_cat_id"),
    )


def downgrade() -> None:
    op.drop_table("listing_channel_category")
