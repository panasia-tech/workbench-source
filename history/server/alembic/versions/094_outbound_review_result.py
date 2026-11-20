"""出库复核：结果（核对无误/发现新问题）、身份核对码、当前货况照片、问题处理时间

Revision ID: 094_outbound_review_result
Revises: 093_staff_notify_channels
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "094_outbound_review_result"
down_revision: Union[str, None] = "093_staff_notify_channels"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("outbound_review", sa.Column("result", sa.String(16), nullable=False, server_default="OK"))
    op.add_column("outbound_review", sa.Column("identity_code", sa.String(64), nullable=True))
    op.add_column("outbound_review", sa.Column("media", sa.JSON(), nullable=True))
    op.add_column("outbound_review", sa.Column("closed_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    for col in ("closed_at", "media", "identity_code", "result"):
        op.drop_column("outbound_review", col)
