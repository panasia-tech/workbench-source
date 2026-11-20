"""purchase order trade fields

Revision ID: 007_purchase_order_trade_fields
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "007_purchase_order_trade_fields"
down_revision: Union[str, None] = "006_order_archive"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("purchase_order", sa.Column("external_order_no", sa.String(64), nullable=True))
    op.add_column("purchase_order", sa.Column("transaction_no", sa.String(64), nullable=True))
    op.add_column("purchase_order", sa.Column("tracking_no", sa.String(64), nullable=True))
    op.add_column("purchase_order", sa.Column("order_time", sa.DateTime(), nullable=True))
    op.add_column("purchase_order", sa.Column("paid_at", sa.DateTime(), nullable=True))
    op.create_index("ix_po_external_order_no", "purchase_order", ["external_order_no"])


def downgrade() -> None:
    op.drop_index("ix_po_external_order_no", table_name="purchase_order")
    op.drop_column("purchase_order", "paid_at")
    op.drop_column("purchase_order", "order_time")
    op.drop_column("purchase_order", "tracking_no")
    op.drop_column("purchase_order", "transaction_no")
    op.drop_column("purchase_order", "external_order_no")
