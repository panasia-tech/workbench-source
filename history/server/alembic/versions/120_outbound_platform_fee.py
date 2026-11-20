"""出库单记闲鱼实际服务费：sales_outbound 加 platform_fee（无忧卖按类目和售出时长 1%～17.5%，固定比例估不准）

Revision ID: 120_outbound_platform_fee
Revises: 119_ledger_bill_outbound
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "120_outbound_platform_fee"
down_revision: Union[str, None] = "119_ledger_bill_outbound"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sales_outbound", sa.Column("platform_fee", sa.Numeric(12, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("sales_outbound", "platform_fee")
