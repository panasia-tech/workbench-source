"""上架前按店铺选图:爬虫正式图转存进图床当候选;每个店铺记下自己发的那组图

Revision ID: 089_shop_images
Revises: 088_spu_image_search
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "089_shop_images"
down_revision: Union[str, None] = "088_spu_image_search"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("spu_image_search", sa.Column("pool_images", sa.JSON(), nullable=True))
    op.add_column("sku_shop_listing", sa.Column("images", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("sku_shop_listing", "images")
    op.drop_column("spu_image_search", "pool_images")
