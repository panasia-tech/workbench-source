"""占位：群控发布前回 ERP 再核（E05-10）不需要改表，只占住版本号让迁移链连续

Revision ID: 106_gc_precheck
Revises: 105_stock_lock_delist
"""
from typing import Sequence, Union

revision: str = "106_gc_precheck"
down_revision: Union[str, None] = "105_stock_lock_delist"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
