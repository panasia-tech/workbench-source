"""sale_order 增加商品图片字段:闲管家同步单无库内 SKU 关联时的封面兜底

Revision ID: 029_sale_order_product_image
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "029_sale_order_product_image"
down_revision: Union[str, None] = "028_logistics_poll_task"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sale_order", sa.Column("product_image_url", sa.String(512), nullable=True))


def downgrade() -> None:
    op.drop_column("sale_order", "product_image_url")
