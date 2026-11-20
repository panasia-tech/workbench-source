"""上架审批：每件货每个店铺的价和图经管理员批过才发

Revision ID: 087_listing_approval
Revises: 086_wecom_notice
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "087_listing_approval"
down_revision: Union[str, None] = "086_wecom_notice"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "listing_approval",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("sale_shop_id", sa.String(36), sa.ForeignKey("sale_shop.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(16), nullable=False, server_default="DRAFT"),
        sa.Column("price", sa.Numeric(12, 2), nullable=True),
        sa.Column("images", sa.JSON(), nullable=True),
        sa.Column("cost_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("min_cost_ratio", sa.Numeric(5, 2), nullable=True),
        sa.Column("market_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("market_basis", sa.String(16), nullable=True),
        sa.Column("market_date", sa.DateTime(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("edited_by", sa.String(36), nullable=True),
        sa.Column("submitted_by", sa.String(36), nullable=True),
        sa.Column("submitted_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by", sa.String(36), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("stale_reason", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_listing_approval_sku_id", "listing_approval", ["sku_id"])
    op.create_index("ix_listing_approval_sale_shop_id", "listing_approval", ["sale_shop_id"])
    op.create_index("ix_listing_approval_status", "listing_approval", ["status"])
    op.add_column("sku_shop_listing", sa.Column("listing_approval_id", sa.String(36), nullable=True))


def downgrade() -> None:
    op.drop_column("sku_shop_listing", "listing_approval_id")
    op.drop_index("ix_listing_approval_status", table_name="listing_approval")
    op.drop_index("ix_listing_approval_sale_shop_id", table_name="listing_approval")
    op.drop_index("ix_listing_approval_sku_id", table_name="listing_approval")
    op.drop_table("listing_approval")
