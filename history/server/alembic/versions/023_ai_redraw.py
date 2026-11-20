"""ai_redraw_job + warehouse_tag.ai_size/ai_resolution

Revision ID: 023_ai_redraw
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "023_ai_redraw"
down_revision: Union[str, None] = "022_warehouse_tag_prompt"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("warehouse_tag", sa.Column("ai_size", sa.String(16), nullable=True))
    op.add_column("warehouse_tag", sa.Column("ai_resolution", sa.String(8), nullable=True))

    op.create_table(
        "ai_redraw_job",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sku_code", sa.String(64), nullable=False),
        sa.Column("source_image_url", sa.String(512), nullable=False),
        sa.Column("tag_name", sa.String(64), nullable=True),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("ai_size", sa.String(16), nullable=True),
        sa.Column("ai_resolution", sa.String(8), nullable=True),
        sa.Column("alapi_task_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("result_url", sa.String(512), nullable=True),
        sa.Column("result_object_key", sa.String(512), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("operator_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("poll_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_ai_redraw_job_sku_code", "ai_redraw_job", ["sku_code"])
    op.create_index("ix_ai_redraw_job_status", "ai_redraw_job", ["status"])
    op.create_index("ix_ai_redraw_job_created_at", "ai_redraw_job", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_ai_redraw_job_created_at", table_name="ai_redraw_job")
    op.drop_index("ix_ai_redraw_job_status", table_name="ai_redraw_job")
    op.drop_index("ix_ai_redraw_job_sku_code", table_name="ai_redraw_job")
    op.drop_table("ai_redraw_job")
    op.drop_column("warehouse_tag", "ai_resolution")
    op.drop_column("warehouse_tag", "ai_size")
