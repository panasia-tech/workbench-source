"""sku_shop_listing 增新群控引用列:gc_job_id / gc_account_id（真机上下架接管）

Revision ID: 055_gc_shop_listing_ref
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "055_gc_shop_listing_ref"
down_revision: Union[str, None] = "054_archive_bill_ts_default"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 均可空、无默认:存量行不受影响,与 xgj_product_id 并存(灰度/回退期)。
_COLUMNS = (
    sa.Column("gc_job_id", sa.String(length=36), nullable=True),
    sa.Column("gc_account_id", sa.String(length=36), nullable=True),
)


def upgrade() -> None:
    for col in _COLUMNS:
        op.add_column("sku_shop_listing", col)


def downgrade() -> None:
    for col in reversed(_COLUMNS):
        op.drop_column("sku_shop_listing", col.name)
