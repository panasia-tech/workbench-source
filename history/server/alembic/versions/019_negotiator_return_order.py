"""negotiator role fields and return_order table

Revision ID: 019_negotiator_return_order
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "019_negotiator_return_order"
down_revision: Union[str, None] = "018_purchase_attachments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("negotiated_at", sa.DateTime(), nullable=True))
    op.add_column("sku", sa.Column("negotiation_remark", sa.String(512), nullable=True))
    op.execute(
        "UPDATE sku SET negotiated_at = inbound_at "
        "WHERE status = 'IN_STOCK' AND inbound_at IS NOT NULL AND negotiated_at IS NULL"
    )

    op.create_table(
        "return_order",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("return_no", sa.String(32), nullable=False),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("sku_code", sa.String(64), nullable=False),
        sa.Column("product_name", sa.String(256), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("listing_snapshot", sa.JSON(), nullable=True),
        sa.Column("outbound_id", sa.String(36), sa.ForeignKey("sales_outbound.id"), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("receiver_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("received_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_return_order_return_no", "return_order", ["return_no"], unique=True)
    op.create_index("ix_return_order_sku_id", "return_order", ["sku_id"])
    op.create_index("ix_return_order_sku_code", "return_order", ["sku_code"])
    op.create_index("ix_return_order_status", "return_order", ["status"])


def downgrade() -> None:
    op.drop_table("return_order")
    op.drop_column("sku", "negotiation_remark")
    op.drop_column("sku", "negotiated_at")
