"""自动上架流水线行加 hold_publish：存量回填只补价补图、停在待人工上架，绝不进发布

Revision ID: 100_auto_listing_hold_publish
Revises: 099_purchase_pieces
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "100_auto_listing_hold_publish"
down_revision: Union[str, None] = "099_purchase_pieces"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sku_auto_listing",
        sa.Column("hold_publish", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("sku_auto_listing", "hold_publish")
