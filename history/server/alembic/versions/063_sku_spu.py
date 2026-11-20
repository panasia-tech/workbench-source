"""sku 增加 spu 字段（69码查询到的 SPU 商品信息，条码库返回的原始 JSON）

Revision ID: 063_sku_spu
Revises: 062_sku_barcode
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "063_sku_spu"
down_revision: Union[str, None] = "062_sku_barcode"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("spu", sa.JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("sku", "spu")
