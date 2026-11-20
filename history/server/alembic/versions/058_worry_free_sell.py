"""无忧卖可配置:sale_shop 加账号级默认 worry_free_sell(默认关),sku_shop_listing 加商品级覆盖(可空=继承)

Revision ID: 058_worry_free_sell
Revises: 057_sale_shop_gc_account_id
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "058_worry_free_sell"
down_revision: Union[str, None] = "057_sale_shop_gc_account_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 账号级默认:NOT NULL 默认 0(关),存量店铺回填 0 —— 与「未配置=不加入无忧卖」一致。
    op.add_column(
        "sale_shop",
        sa.Column("worry_free_sell", sa.Boolean(), nullable=False, server_default="0"),
    )
    # 商品×店铺覆盖:可空,NULL=继承账号默认。
    op.add_column(
        "sku_shop_listing",
        sa.Column("worry_free_sell", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sku_shop_listing", "worry_free_sell")
    op.drop_column("sale_shop", "worry_free_sell")
