"""验货异常通知走企微：员工绑企微账号，每条通知记送达结果

Revision ID: 086_wecom_notice
Revises: 085_sku_auto_refresh_hold
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "086_wecom_notice"
down_revision: Union[str, None] = "085_sku_auto_refresh_hold"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("staff", sa.Column("wecom_userid", sa.String(64), nullable=True))
    op.add_column("inspection_exception_event", sa.Column("channel_status", sa.String(16), nullable=True))
    op.add_column("inspection_exception_event", sa.Column("channel_detail", sa.String(255), nullable=True))
    op.add_column("inspection_exception_event", sa.Column("channel_at", sa.DateTime(), nullable=True))
    op.create_index("ix_inspection_exception_event_channel_status", "inspection_exception_event", ["channel_status"])


def downgrade() -> None:
    op.drop_index("ix_inspection_exception_event_channel_status", table_name="inspection_exception_event")
    op.drop_column("inspection_exception_event", "channel_at")
    op.drop_column("inspection_exception_event", "channel_detail")
    op.drop_column("inspection_exception_event", "channel_status")
    op.drop_column("staff", "wecom_userid")
