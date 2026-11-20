"""daily_bill table for finance daily uploads

Revision ID: 020_daily_bill
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "020_daily_bill"
down_revision: Union[str, None] = "019_negotiator_return_order"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "daily_bill",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("bill_date", sa.Date(), nullable=False),
        sa.Column("file_url", sa.String(512), nullable=False),
        sa.Column("file_name", sa.String(256), nullable=False),
        sa.Column("uploaded_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_daily_bill_bill_date", "daily_bill", ["bill_date"])
    op.create_unique_constraint("uq_daily_bill_date", "daily_bill", ["bill_date"])


def downgrade() -> None:
    op.drop_constraint("uq_daily_bill_date", "daily_bill", type_="unique")
    op.drop_index("ix_daily_bill_bill_date", table_name="daily_bill")
    op.drop_table("daily_bill")
