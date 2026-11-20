"""express tracking cache

Revision ID: 009_express_tracking_cache
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "009_express_tracking_cache"
down_revision: Union[str, None] = "008_purchase_screenshot_url_2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "express_tracking_cache",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("tracking_no", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=True),
        sa.Column("msg", sa.String(512), nullable=True),
        sa.Column("traces", sa.JSON(), nullable=False),
        sa.Column("queried_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            nullable=False,
        ),
    )
    op.create_index("ix_express_tracking_cache_tracking_no", "express_tracking_cache", ["tracking_no"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_express_tracking_cache_tracking_no", table_name="express_tracking_cache")
    op.drop_table("express_tracking_cache")
