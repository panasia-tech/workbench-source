"""add stocktake approval

Revision ID: 004_stocktake_approval
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "004_stocktake_approval"
down_revision: Union[str, None] = "003_stocktake_session"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("stocktake_session", sa.Column("submitted_at", sa.DateTime(), nullable=True))
    op.add_column("stocktake_session", sa.Column("reviewer_id", sa.String(36), nullable=True))
    op.add_column("stocktake_session", sa.Column("reviewed_at", sa.DateTime(), nullable=True))
    op.add_column("stocktake_session", sa.Column("review_comment", sa.String(512), nullable=True))
    op.create_foreign_key(
        "fk_stocktake_session_reviewer_id",
        "stocktake_session",
        "staff",
        ["reviewer_id"],
        ["id"],
    )

    op.create_table(
        "stocktake_adjustment",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("stocktake_session.id"), nullable=False),
        sa.Column("sku_code", sa.String(64), nullable=False),
        sa.Column("diff_type", sa.String(16), nullable=False),
        sa.Column("adjust_type", sa.String(16), nullable=True),
        sa.Column("reason", sa.String(512), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("adjust_no", sa.String(32), nullable=True),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("reviewer_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("review_comment", sa.String(512), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("ix_stocktake_adjustment_session_id", "stocktake_adjustment", ["session_id"])
    op.create_index("ix_stocktake_adjustment_sku_code", "stocktake_adjustment", ["sku_code"])
    op.create_index("ix_stocktake_adjustment_status", "stocktake_adjustment", ["status"])


def downgrade() -> None:
    op.drop_index("ix_stocktake_adjustment_status", table_name="stocktake_adjustment")
    op.drop_index("ix_stocktake_adjustment_sku_code", table_name="stocktake_adjustment")
    op.drop_index("ix_stocktake_adjustment_session_id", table_name="stocktake_adjustment")
    op.drop_table("stocktake_adjustment")
    op.drop_constraint("fk_stocktake_session_reviewer_id", "stocktake_session", type_="foreignkey")
    op.drop_column("stocktake_session", "review_comment")
    op.drop_column("stocktake_session", "reviewed_at")
    op.drop_column("stocktake_session", "reviewer_id")
    op.drop_column("stocktake_session", "submitted_at")
