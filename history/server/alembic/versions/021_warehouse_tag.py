"""warehouse_tag table for warehouse list custom filter

Revision ID: 021_warehouse_tag
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "021_warehouse_tag"
down_revision: Union[str, None] = "020_daily_bill"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "warehouse_tag",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_unique_constraint("uq_warehouse_tag_name", "warehouse_tag", ["name"])
    op.add_column("sku", sa.Column("tags", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("sku", "tags")
    op.drop_constraint("uq_warehouse_tag_name", "warehouse_tag", type_="unique")
    op.drop_table("warehouse_tag")
