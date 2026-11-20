"""add stocktake_session

Revision ID: 003_stocktake_session
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003_stocktake_session"
down_revision: Union[str, None] = "002_staff_no"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "stocktake_session",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_no", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("scanned_items", sa.JSON(), nullable=False),
        sa.Column("diff_result", sa.JSON(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("paused_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("session_no"),
    )
    op.create_index("ix_stocktake_session_status", "stocktake_session", ["status"])
    op.create_index("ix_stocktake_session_operator_id", "stocktake_session", ["operator_id"])


def downgrade() -> None:
    op.drop_index("ix_stocktake_session_operator_id", table_name="stocktake_session")
    op.drop_index("ix_stocktake_session_status", table_name="stocktake_session")
    op.drop_table("stocktake_session")
