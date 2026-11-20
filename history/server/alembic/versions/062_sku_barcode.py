"""sku 增加 barcode 字段（商品条码 69码/EAN-13，同款同码，非唯一）

Revision ID: 062_sku_barcode
Revises: 061_staff_soft_delete
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "062_sku_barcode"
down_revision: Union[str, None] = "061_staff_soft_delete"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("barcode", sa.String(32), nullable=True))
    op.create_index("ix_sku_barcode", "sku", ["barcode"])


def downgrade() -> None:
    op.drop_index("ix_sku_barcode", table_name="sku")
    op.drop_column("sku", "barcode")
