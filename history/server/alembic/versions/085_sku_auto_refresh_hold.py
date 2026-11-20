"""商品详情页管理自动上架：这件货暂停 / 推迟链接焕新

Revision ID: 085_sku_auto_refresh_hold
Revises: 084_inspection_ops
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "085_sku_auto_refresh_hold"
down_revision: Union[str, None] = "084_inspection_ops"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("auto_refresh_paused", sa.Boolean(), server_default=sa.false(), nullable=False))
    op.add_column("sku", sa.Column("auto_refresh_not_before", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("sku", "auto_refresh_not_before")
    op.drop_column("sku", "auto_refresh_paused")
