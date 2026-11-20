"""采购单/SKU 增加货况警示字段（实拍图 OCR 命中「全新/几乎全新」→ 验货/议价标红）

Revision ID: 037_condition_warning
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "037_condition_warning"
down_revision: Union[str, None] = "036_inspection_soft_delete"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "purchase_order",
        sa.Column("condition_warning", sa.Boolean(), nullable=False, server_default="0"),
    )
    op.add_column(
        "purchase_order",
        sa.Column("condition_warning_text", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "purchase_order",
        sa.Column("condition_scanned_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_purchase_order_condition_warning", "purchase_order", ["condition_warning"]
    )
    op.add_column(
        "sku",
        sa.Column("condition_warning", sa.Boolean(), nullable=False, server_default="0"),
    )
    op.add_column(
        "sku",
        sa.Column("condition_warning_text", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sku", "condition_warning_text")
    op.drop_column("sku", "condition_warning")
    op.drop_index("ix_purchase_order_condition_warning", table_name="purchase_order")
    op.drop_column("purchase_order", "condition_scanned_at")
    op.drop_column("purchase_order", "condition_warning_text")
    op.drop_column("purchase_order", "condition_warning")
