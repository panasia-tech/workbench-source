"""大台账对账也对出库单：ledger_bill_row 加 sale_outbound_id（闲鱼卖出大多只有手动出库、没有销售单）

Revision ID: 119_ledger_bill_outbound
Revises: 118_virtual_goods
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "119_ledger_bill_outbound"
down_revision: Union[str, None] = "118_virtual_goods"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ledger_bill_row", sa.Column("sale_outbound_id", sa.String(36), nullable=True))
    op.create_index("ix_ledger_bill_row_sale_outbound_id", "ledger_bill_row", ["sale_outbound_id"])


def downgrade() -> None:
    op.drop_index("ix_ledger_bill_row_sale_outbound_id", table_name="ledger_bill_row")
    op.drop_column("ledger_bill_row", "sale_outbound_id")
