"""采购工作台 W11：检查项分栏（外观 / 功能 / 配件 / 包装 / 型号）、卖家已披露、原因待判；差异工单关联检查项和快照

Revision ID: 129_inspection_compare
Revises: 128_purchase_price_rule
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "129_inspection_compare"
down_revision: Union[str, None] = "128_purchase_price_rule"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("inspection_check_item", sa.Column("dimension", sa.String(16), nullable=True))
    op.add_column("inspection_check_item", sa.Column("disclosed", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("inspection_check_item", sa.Column("cause", sa.String(16), nullable=True))
    op.add_column("inspection_exception", sa.Column("check_item_keys", sa.JSON(), nullable=True))
    op.add_column("inspection_exception", sa.Column("snapshot_id", sa.String(36), nullable=True))


def downgrade() -> None:
    op.drop_column("inspection_exception", "snapshot_id")
    op.drop_column("inspection_exception", "check_item_keys")
    op.drop_column("inspection_check_item", "cause")
    op.drop_column("inspection_check_item", "disclosed")
    op.drop_column("inspection_check_item", "dimension")
