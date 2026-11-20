"""采购工作台 W04：快照挂平台订单、卖家写的型号和规格、怎么抓的、原件转存（对象名 + SHA-256）

Revision ID: 127_purchase_snapshot_media
Revises: 126_purchase_platform_order
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "127_purchase_snapshot_media"
down_revision: Union[str, None] = "126_purchase_platform_order"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("purchase_item_snapshot") as b:
        b.add_column(sa.Column("platform_order_id", sa.String(36), nullable=True))
        b.add_column(sa.Column("declared_model", sa.String(128), nullable=True))
        b.add_column(sa.Column("specs", sa.Text(), nullable=True))
        b.add_column(sa.Column("capture_kind", sa.String(16), nullable=False, server_default="manual"))
        b.add_column(sa.Column("captured_at", sa.DateTime(), nullable=True))
        b.add_column(sa.Column("media", sa.JSON(), nullable=True))
        b.create_foreign_key("fk_purchase_item_snapshot_platform_order_id", "purchase_platform_order",
                             ["platform_order_id"], ["id"])
        b.create_index("ix_purchase_item_snapshot_platform_order_id", ["platform_order_id"])


def downgrade() -> None:
    with op.batch_alter_table("purchase_item_snapshot") as b:
        b.drop_constraint("fk_purchase_item_snapshot_platform_order_id", type_="foreignkey")
        b.drop_index("ix_purchase_item_snapshot_platform_order_id")
        for c in ("media", "captured_at", "capture_kind", "specs", "declared_model", "platform_order_id"):
            b.drop_column(c)
