"""sale_order xianguanjia sync fields

Revision ID: 013_sale_order_xgj_sync
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "013_sale_order_xgj_sync"
down_revision: Union[str, None] = "012_inspection_action_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sale_order", sa.Column("product_title", sa.String(256), nullable=True))
    op.add_column("sale_order", sa.Column("product_spec", sa.String(128), nullable=True))
    op.add_column("sale_order", sa.Column("xgj_product_id", sa.String(32), nullable=True))
    op.add_column("sale_order", sa.Column("shop_name", sa.String(64), nullable=True))
    op.add_column("sale_order", sa.Column("tracking_no", sa.String(64), nullable=True))
    op.create_index("ix_sale_order_external_order_no", "sale_order", ["external_order_no"])


def downgrade() -> None:
    op.drop_index("ix_sale_order_external_order_no", table_name="sale_order")
    op.drop_column("sale_order", "tracking_no")
    op.drop_column("sale_order", "shop_name")
    op.drop_column("sale_order", "xgj_product_id")
    op.drop_column("sale_order", "product_spec")
    op.drop_column("sale_order", "product_title")
