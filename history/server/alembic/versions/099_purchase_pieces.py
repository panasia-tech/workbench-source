"""一张采购单多件、分次到货：采购单记件数，验货单按件（piece_no）一件一张

Revision ID: 099_purchase_pieces
Revises: 098_return_recheck
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "099_purchase_pieces"
down_revision: Union[str, None] = "098_return_recheck"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _single_unique_on_order(bind) -> list[str]:
    """原来 purchase_order_id 上的唯一索引（生产上就叫 purchase_order_id，各环境名字不一定一样）。"""
    return [
        ix["name"]
        for ix in sa.inspect(bind).get_indexes("inspection")
        if ix.get("unique") and ix["column_names"] == ["purchase_order_id"]
    ]


def upgrade() -> None:
    op.add_column("purchase_order", sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("inspection", sa.Column("piece_no", sa.Integer(), nullable=False, server_default="1"))
    # 先建 (采购单, 第几件) 唯一索引：外键要有索引撑着，旧唯一索引才删得掉
    op.create_index("uq_inspection_order_piece", "inspection", ["purchase_order_id", "piece_no"], unique=True)
    for name in _single_unique_on_order(op.get_bind()):
        op.drop_index(name, table_name="inspection")
    op.create_index("ix_inspection_purchase_order_id", "inspection", ["purchase_order_id"])


def downgrade() -> None:
    # 有一单多件的数据时回不去（同一采购单有多张验货单），先手工处理再降级
    op.drop_index("ix_inspection_purchase_order_id", table_name="inspection")
    op.create_index("purchase_order_id", "inspection", ["purchase_order_id"], unique=True)
    op.drop_index("uq_inspection_order_piece", table_name="inspection")
    op.drop_column("inspection", "piece_no")
    op.drop_column("purchase_order", "quantity")
