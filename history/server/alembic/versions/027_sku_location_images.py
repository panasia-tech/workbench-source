"""sku 增加 location_images 仓库定位图字段,与 images 产品实拍图分开

Revision ID: 027_sku_location_images
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "027_sku_location_images"
down_revision: Union[str, None] = "026_drop_sku_po_unique_fix"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("location_images", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("sku", "location_images")
