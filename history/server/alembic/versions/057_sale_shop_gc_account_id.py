"""sale_shop 增显式群控账号绑定列:gc_account_id(优先于按闲鱼账号名匹配)

Revision ID: 057_sale_shop_gc_account_id
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "057_sale_shop_gc_account_id"
down_revision: Union[str, None] = "056_sku_short_code"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 可空、无默认:存量行不受影响,未绑定的店铺回退旧的按名匹配逻辑。
_COLUMN = sa.Column("gc_account_id", sa.String(length=36), nullable=True)


def upgrade() -> None:
    op.add_column("sale_shop", _COLUMN)


def downgrade() -> None:
    op.drop_column("sale_shop", _COLUMN.name)
