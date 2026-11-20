"""销售上手练习进度（练习门禁，11-13 对齐销售工作台交付包）

Revision ID: 114_staff_practice
Revises: 113_bargain_necessary_checks
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "114_staff_practice"
down_revision: Union[str, None] = "113_bargain_necessary_checks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "staff_practice",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("practice", sa.String(32), nullable=False),
        sa.Column("step", sa.Integer(), nullable=False),
        sa.Column("answer", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("staff_id", "practice", "step", name="uq_staff_practice_step"),
    )
    op.create_index("ix_staff_practice_staff_id", "staff_practice", ["staff_id"])


def downgrade() -> None:
    op.drop_table("staff_practice")
