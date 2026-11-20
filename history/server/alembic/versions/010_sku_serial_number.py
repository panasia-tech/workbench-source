"""sku serial_number

Revision ID: 010_sku_serial_number
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "010_sku_serial_number"
down_revision: Union[str, None] = "009_express_tracking_cache"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("serial_number", sa.String(128), nullable=True))
    op.create_index("ix_sku_serial_number", "sku", ["serial_number"])


def downgrade() -> None:
    op.drop_index("ix_sku_serial_number", table_name="sku")
    op.drop_column("sku", "serial_number")
