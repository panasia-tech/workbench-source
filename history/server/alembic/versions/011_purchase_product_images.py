"""purchase product_images

Revision ID: 011_purchase_product_images
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "011_purchase_product_images"
down_revision: Union[str, None] = "010_sku_serial_number"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("purchase_order", sa.Column("product_images", sa.JSON(), nullable=True))
    op.execute("UPDATE purchase_order SET product_images = '[]' WHERE product_images IS NULL")


def downgrade() -> None:
    op.drop_column("purchase_order", "product_images")
