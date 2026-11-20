"""sku reserve_source

Revision ID: 014_sku_reserve_source
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "014_sku_reserve_source"
down_revision: Union[str, None] = "013_sale_order_xgj_sync"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("reserve_source", sa.String(16), nullable=True))
    op.create_index("ix_sku_reserve_source", "sku", ["reserve_source"])


def downgrade() -> None:
    op.drop_index("ix_sku_reserve_source", table_name="sku")
    op.drop_column("sku", "reserve_source")
