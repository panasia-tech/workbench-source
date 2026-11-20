"""business extension: sale_shop, listing, switch_order, express_fee

Revision ID: 005_business_extension
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005_business_extension"
down_revision: Union[str, None] = "004_stocktake_approval"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sale_shop",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("label", sa.String(64), nullable=False),
        sa.Column("xianyu_user_name", sa.String(64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("code"),
    )

    op.create_table(
        "sku_listing_info",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("title", sa.String(256), nullable=True),
        sa.Column("desc", sa.Text(), nullable=True),
        sa.Column("price", sa.Numeric(12, 2), nullable=True),
        sa.Column("original_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("express_fee", sa.Numeric(12, 2), nullable=True),
        sa.Column("images", sa.JSON(), nullable=False),
        sa.Column("item_biz_type", sa.Integer(), nullable=True),
        sa.Column("sp_biz_type", sa.Integer(), nullable=True),
        sa.Column("channel_cat_id", sa.String(64), nullable=True),
        sa.Column("stuff_status", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="DRAFT"),
        sa.Column("xgj_product_id", sa.String(32), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("sku_id"),
    )
    op.create_index("ix_sku_listing_info_status", "sku_listing_info", ["status"])

    op.create_table(
        "sku_shop_listing",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("sale_shop_id", sa.String(36), sa.ForeignKey("sale_shop.id"), nullable=False),
        sa.Column("xgj_product_id", sa.String(32), nullable=True),
        sa.Column("publish_status", sa.String(32), nullable=False, server_default="PENDING"),
        sa.Column("sold_at", sa.DateTime(), nullable=True),
        sa.Column("delisted_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("sku_id", "sale_shop_id", name="uq_sku_shop"),
    )
    op.create_index("ix_sku_shop_listing_status", "sku_shop_listing", ["publish_status"])

    op.add_column("sales_outbound", sa.Column("express_fee", sa.Numeric(12, 2), nullable=True))

    op.create_table(
        "switch_order",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("switch_no", sa.String(32), nullable=False),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("unit_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("deposit_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("deposit_paid_at", sa.DateTime(), nullable=True),
        sa.Column("deposit_evidence_urls", sa.JSON(), nullable=False),
        sa.Column("final_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("final_paid_at", sa.DateTime(), nullable=True),
        sa.Column("final_evidence_urls", sa.JSON(), nullable=False),
        sa.Column("cutoff_status", sa.String(32), nullable=False, server_default="NONE"),
        sa.Column("cutoff_applied_at", sa.DateTime(), nullable=True),
        sa.Column("cutoff_reviewed_by", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("cutoff_remark", sa.Text(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="ACTIVE"),
        sa.Column("evidence_urls", sa.JSON(), nullable=False),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("sales_outbound_id", sa.String(36), sa.ForeignKey("sales_outbound.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("switch_no"),
    )
    op.create_index("ix_switch_order_status", "switch_order", ["status"])


def downgrade() -> None:
    op.drop_table("switch_order")
    op.drop_column("sales_outbound", "express_fee")
    op.drop_table("sku_shop_listing")
    op.drop_table("sku_listing_info")
    op.drop_table("sale_shop")
