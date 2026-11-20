"""验货异常通知记发送次数（失败自动重试；通知钉钉优先、企微兜底）

Revision ID: 093_staff_notify_channels
Revises: 092_inspection_item_log
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "093_staff_notify_channels"
down_revision: Union[str, None] = "092_inspection_item_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "inspection_exception_event",
        sa.Column("channel_attempts", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("inspection_exception_event", "channel_attempts")
