"""sku 增上架短编码列:short_code（4 位,上架时分配,出库回收复用）

Revision ID: 056_sku_short_code
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "056_sku_short_code"
down_revision: Union[str, None] = "055_gc_shop_listing_ref"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("short_code", sa.String(length=8), nullable=True))
    op.create_index("ix_sku_short_code", "sku", ["short_code"])


def downgrade() -> None:
    op.drop_index("ix_sku_short_code", table_name="sku")
    op.drop_column("sku", "short_code")
