"""员工软删除 staff.deleted_at（不再物理删除，避免历史单据的制单人/操作人外键悬空）

Revision ID: 061_staff_soft_delete
Revises: 060_oa_push_outbox
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "061_staff_soft_delete"
down_revision: Union[str, None] = "060_oa_push_outbox"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("staff", sa.Column("deleted_at", sa.DateTime(), nullable=True))
    op.create_index("ix_staff_deleted_at", "staff", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_staff_deleted_at", table_name="staff")
    op.drop_column("staff", "deleted_at")
