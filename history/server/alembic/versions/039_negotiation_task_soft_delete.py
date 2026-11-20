"""negotiation_task 增加 deleted_at 软删除字段（隐藏老系统回填的陈旧议价任务，保留行）

Revision ID: 039_negotiation_task_soft_delete
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "039_negotiation_task_soft_delete"
down_revision: Union[str, None] = "038_lawsuit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "negotiation_task",
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_negotiation_task_deleted_at", "negotiation_task", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_negotiation_task_deleted_at", table_name="negotiation_task")
    op.drop_column("negotiation_task", "deleted_at")
