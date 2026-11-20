"""起诉单表 lawsuit（采购/管理员发起诉讼，按律师/法院/判决材料反推状态）

Revision ID: 038_lawsuit
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "038_lawsuit"
down_revision: Union[str, None] = "037_condition_warning"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "lawsuit",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("lawsuit_no", sa.String(length=32), nullable=False),
        sa.Column("purchase_order_id", sa.String(length=36), nullable=False),
        sa.Column("lawyer_media", sa.JSON(), nullable=True),
        sa.Column("court_media", sa.JSON(), nullable=True),
        sa.Column("judgment_media", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="DRAFT"),
        sa.Column("created_by_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["purchase_order_id"], ["purchase_order.id"]),
        sa.ForeignKeyConstraint(["created_by_id"], ["staff.id"]),
        # 与被引用表 purchase_order/staff 的 utf8mb4_unicode_ci 对齐，否则外键报 errno 1215
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index("ix_lawsuit_lawsuit_no", "lawsuit", ["lawsuit_no"], unique=True)
    op.create_index(
        "ix_lawsuit_purchase_order_id", "lawsuit", ["purchase_order_id"], unique=True
    )
    op.create_index("ix_lawsuit_status", "lawsuit", ["status"])
    op.create_index("ix_lawsuit_created_by_id", "lawsuit", ["created_by_id"])


def downgrade() -> None:
    op.drop_index("ix_lawsuit_created_by_id", table_name="lawsuit")
    op.drop_index("ix_lawsuit_status", table_name="lawsuit")
    op.drop_index("ix_lawsuit_purchase_order_id", table_name="lawsuit")
    op.drop_index("ix_lawsuit_lawsuit_no", table_name="lawsuit")
    op.drop_table("lawsuit")
