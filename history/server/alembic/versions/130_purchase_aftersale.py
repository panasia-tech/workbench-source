"""采购工作台 W12：验货异常单上补平台售后——申请状态和回执、平台期限和来源、留货补差提议

Revision ID: 130_purchase_aftersale
Revises: 129_inspection_compare
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "130_purchase_aftersale"
down_revision: Union[str, None] = "129_inspection_compare"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLS = ("aftersale_status", "aftersale_deadline", "deadline_source", "aftersale_receipt", "aftersale_submitted_at", "keep_offers")


def upgrade() -> None:
    op.add_column("inspection_exception", sa.Column("aftersale_status", sa.String(16), nullable=False, server_default="none"))
    op.add_column("inspection_exception", sa.Column("aftersale_deadline", sa.DateTime(), nullable=True))
    op.add_column("inspection_exception", sa.Column("deadline_source", sa.String(16), nullable=True))
    op.add_column("inspection_exception", sa.Column("aftersale_receipt", sa.JSON(), nullable=True))
    op.add_column("inspection_exception", sa.Column("aftersale_submitted_at", sa.DateTime(), nullable=True))
    op.add_column("inspection_exception", sa.Column("keep_offers", sa.JSON(), nullable=True))


def downgrade() -> None:
    for c in reversed(_COLS):
        op.drop_column("inspection_exception", c)
