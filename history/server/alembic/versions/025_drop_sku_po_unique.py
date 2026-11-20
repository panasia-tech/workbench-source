"""drop UNIQUE on sku.purchase_order_id,允许一个采购单对应多个 sku

(配合 CloudBase 数据迁移:云端 items 可能多条共享同一 purchaseOrderId)

Revision ID: 025_drop_sku_po_unique
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "025_drop_sku_po_unique"
down_revision: Union[str, None] = "024_cloudbase_migration"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # MySQL 中 SQLAlchemy 的 UniqueConstraint("purchase_order_id") 默认约束名
    # 与列名一致,即 "purchase_order_id"。同时存在同名 unique index。
    # 先尝试 drop constraint,再 drop index(可能 MySQL 把它当 INDEX 不是 CONSTRAINT)。
    try:
        op.drop_constraint("purchase_order_id", "sku", type_="unique")
    except Exception:
        pass
    try:
        op.drop_index("purchase_order_id", table_name="sku")
    except Exception:
        pass
    # 加一个非唯一索引方便查询
    op.create_index("ix_sku_purchase_order_id", "sku", ["purchase_order_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_sku_purchase_order_id", table_name="sku")
    op.create_unique_constraint("purchase_order_id", "sku", ["purchase_order_id"])
