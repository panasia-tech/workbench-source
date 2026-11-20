"""purchase attachments

Revision ID: 018_purchase_attachments
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "018_purchase_attachments"
down_revision: Union[str, None] = "017_tracking_phone_suffix"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("purchase_order", sa.Column("attachments", sa.JSON(), nullable=True))
    op.execute("UPDATE purchase_order SET attachments = '[]' WHERE attachments IS NULL")


def downgrade() -> None:
    op.drop_column("purchase_order", "attachments")
