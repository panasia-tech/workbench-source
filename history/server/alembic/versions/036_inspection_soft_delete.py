"""inspection 增加 deleted_at 软删除字段（隐藏旧系统迁移占位验货单，保留行不影响库存）

Revision ID: 036_inspection_soft_delete
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "036_inspection_soft_delete"
down_revision: Union[str, None] = "035_negotiation_media"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "inspection",
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_inspection_deleted_at", "inspection", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_inspection_deleted_at", table_name="inspection")
    op.drop_column("inspection", "deleted_at")
