"""商品种类类型:新增 product_type 表(名称+AI提示词+尺寸+启用);sku 加 product_type 列(入库单选,可空兼容旧数据)

Revision ID: 059_product_type
Revises: 058_worry_free_sell
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "059_product_type"
down_revision: Union[str, None] = "058_worry_free_sell"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "product_type",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("prompt", sa.Text(), nullable=True),
        sa.Column("ai_size", sa.String(length=16), nullable=True),
        sa.Column("ai_resolution", sa.String(length=8), nullable=True),
        sa.UniqueConstraint("name", name="uq_product_type_name"),
    )
    # sku 商品种类类型:可空(存量数据/议价转在库路径无值);入库单选必填由应用层校验。
    op.add_column("sku", sa.Column("product_type", sa.String(length=64), nullable=True))
    op.create_index("ix_sku_product_type", "sku", ["product_type"])


def downgrade() -> None:
    op.drop_index("ix_sku_product_type", table_name="sku")
    op.drop_column("sku", "product_type")
    op.drop_table("product_type")
