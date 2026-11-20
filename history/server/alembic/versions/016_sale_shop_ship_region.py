"""sale_shop 发货省市区（闲管家 create publish_shop）

Revision ID: 016_sale_shop_ship_region
Revises: 015_listing_channel_category
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "016_sale_shop_ship_region"
down_revision: Union[str, None] = "015_listing_channel_category"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sale_shop", sa.Column("ship_province", sa.Integer(), nullable=True))
    op.add_column("sale_shop", sa.Column("ship_city", sa.Integer(), nullable=True))
    op.add_column("sale_shop", sa.Column("ship_district", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("sale_shop", "ship_district")
    op.drop_column("sale_shop", "ship_city")
    op.drop_column("sale_shop", "ship_province")
