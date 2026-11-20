"""purchase order second screenshot

Revision ID: 008_purchase_screenshot_url_2
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "008_purchase_screenshot_url_2"
down_revision: Union[str, None] = "007_purchase_order_trade_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("purchase_order", sa.Column("screenshot_url_2", sa.String(512), nullable=True))


def downgrade() -> None:
    op.drop_column("purchase_order", "screenshot_url_2")
