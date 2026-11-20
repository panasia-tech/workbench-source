"""sku 增加 rfid_epc 字段（RFID 标签一物一码绑定）

Revision ID: 030_sku_rfid_epc
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "030_sku_rfid_epc"
down_revision: Union[str, None] = "029_sale_order_product_image"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("rfid_epc", sa.String(64), nullable=True))
    op.create_index("ix_sku_rfid_epc", "sku", ["rfid_epc"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_sku_rfid_epc", table_name="sku")
    op.drop_column("sku", "rfid_epc")
