"""物流轮询任务表:已发货单据轨迹跟踪,签收自动完结

Revision ID: 028_logistics_poll_task
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "028_logistics_poll_task"
down_revision: Union[str, None] = "027_sku_location_images"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "logistics_poll_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("entity_type", sa.String(32), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=False),
        sa.Column("order_no", sa.String(64), nullable=True),
        sa.Column("tracking_no", sa.String(64), nullable=False),
        sa.Column("phone_suffix", sa.String(8), nullable=True),
        sa.Column("state", sa.String(16), nullable=False, server_default="ACTIVE"),
        sa.Column("streak", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("query_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_due_at", sa.DateTime(), nullable=True),
        sa.Column("last_status", sa.String(512), nullable=True),
        sa.Column("last_event_at", sa.String(64), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(), nullable=True),
        sa.Column("shipped_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.String(256), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint("entity_type", "entity_id", "tracking_no", name="uq_poll_entity_tracking"),
    )
    op.create_index("ix_poll_state", "logistics_poll_task", ["state"])
    op.create_index("ix_poll_next_due", "logistics_poll_task", ["next_due_at"])
    op.create_index("ix_poll_tracking", "logistics_poll_task", ["tracking_no"])
    op.create_index("ix_poll_entity", "logistics_poll_task", ["entity_type", "entity_id"])


def downgrade() -> None:
    op.drop_table("logistics_poll_task")
