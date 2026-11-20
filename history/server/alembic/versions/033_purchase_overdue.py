"""purchase_order 增加 is_overdue 字段（逾期采购：提交时快件已到浙江省内，不发放基础提成）

Revision ID: 033_purchase_overdue
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "033_purchase_overdue"
down_revision: Union[str, None] = "032_pickup_payment"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "purchase_order",
        sa.Column(
            "is_overdue",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("purchase_order", "is_overdue")
