"""资产录入：员工把别的系统里的电脑、显示器手工录成在库商品

一条录入对应一件 SKU，记录入人和来源资产编号。货本身走手动入库同一套占位采购单/验货单，
录完直接进待上架。见 app/routers/asset_intake.py。

Revision ID: 077_asset_intake
Revises: 076_listing_ai_image_unconfirmed
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "077_asset_intake"
down_revision: Union[str, None] = "076_listing_ai_image_unconfirmed"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "asset_intake",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("sku_id", sa.String(length=36), nullable=False),
        # 来源系统里的资产编号，对账用
        sa.Column("source_asset_no", sa.String(length=64), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("entered_by_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["sku_id"], ["sku.id"], name="fk_asset_intake_sku"),
        sa.ForeignKeyConstraint(["entered_by_id"], ["staff.id"], name="fk_asset_intake_entered_by"),
    )
    op.create_index("ix_asset_intake_sku_id", "asset_intake", ["sku_id"], unique=True)
    op.create_index("ix_asset_intake_source_asset_no", "asset_intake", ["source_asset_no"])
    op.create_index("ix_asset_intake_entered_by_id", "asset_intake", ["entered_by_id"])


def downgrade() -> None:
    op.drop_table("asset_intake")
