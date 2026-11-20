"""tracking phone suffix for SF express query

Revision ID: 017_tracking_phone_suffix
Revises: 016_sale_shop_ship_region
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "017_tracking_phone_suffix"
down_revision: Union[str, None] = "016_sale_shop_ship_region"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sale_order",
        sa.Column("tracking_phone_suffix", sa.String(8), nullable=True),
    )
    op.add_column(
        "sales_outbound",
        sa.Column("tracking_phone_suffix", sa.String(8), nullable=True),
    )
    op.add_column(
        "express_tracking_cache",
        sa.Column("phone_suffix", sa.String(8), nullable=False, server_default=""),
    )
    op.drop_index("ix_express_tracking_cache_tracking_no", table_name="express_tracking_cache")
    op.create_index(
        "ix_express_tracking_cache_no_suffix",
        "express_tracking_cache",
        ["tracking_no", "phone_suffix"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_express_tracking_cache_no_suffix", table_name="express_tracking_cache")
    op.create_index(
        "ix_express_tracking_cache_tracking_no",
        "express_tracking_cache",
        ["tracking_no"],
        unique=True,
    )
    op.drop_column("express_tracking_cache", "phone_suffix")
    op.drop_column("sales_outbound", "tracking_phone_suffix")
    op.drop_column("sale_order", "tracking_phone_suffix")
