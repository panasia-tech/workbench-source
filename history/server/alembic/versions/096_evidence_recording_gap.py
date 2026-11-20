"""开箱凭证：开始录的时间、录制中断标记与原因

Revision ID: 096_evidence_recording_gap
Revises: 095_exception_return_refund
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "096_evidence_recording_gap"
down_revision: Union[str, None] = "095_exception_return_refund"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("inspection_evidence", sa.Column("started_at", sa.DateTime(), nullable=True))
    op.add_column("inspection_evidence", sa.Column("interrupted", sa.Boolean(), nullable=False, server_default="0"))
    op.add_column("inspection_evidence", sa.Column("gap_note", sa.String(255), nullable=True))


def downgrade() -> None:
    for col in ("gap_note", "interrupted", "started_at"):
        op.drop_column("inspection_evidence", col)
