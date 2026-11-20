"""purchase_order 增加 tracking_phone_suffix 字段（顺丰物流查询的手机号后四位，选填）

Revision ID: 031_purchase_tracking_phone
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "031_purchase_tracking_phone"
down_revision: Union[str, None] = "030_sku_rfid_epc"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("purchase_order", sa.Column("tracking_phone_suffix", sa.String(8), nullable=True))


def downgrade() -> None:
    op.drop_column("purchase_order", "tracking_phone_suffix")
