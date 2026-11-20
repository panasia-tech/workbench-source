"""入库后自动上架流水线状态表 sku_auto_listing

一件 SKU 一行，记录「解析 SPU → 等行情/采图 → 写上架信息 → 等议价 → 发布」的进度。
只记流水线状态，上架信息本身仍写进 SkuListingInfo（与人工填的没有区别，两条路径共存）。

Revision ID: 067_sku_auto_listing
Revises: 066_warehouse_spu
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "067_sku_auto_listing"
down_revision: Union[str, None] = "066_warehouse_spu"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sku_auto_listing",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("sku_id", sa.String(length=36), nullable=False),
        sa.Column("stage", sa.String(length=24), nullable=False, server_default="RESOLVING"),
        # SPU 对照表是可维护的主数据，删一款不该拖垮历史流水线记录，故不设外键
        sa.Column("spu_id", sa.String(length=36), nullable=True),
        sa.Column("spu_query", sa.String(length=128), nullable=True),
        sa.Column("match_how", sa.String(length=16), nullable=True),
        sa.Column("market_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("resolved_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("image_task_id", sa.String(length=64), nullable=True),
        sa.Column("image_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("gc_job_id", sa.String(length=36), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("next_run_at", sa.DateTime(), nullable=True),
        sa.Column("collecting_since", sa.DateTime(), nullable=True),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["sku_id"], ["sku.id"], name="fk_sku_auto_listing_sku"),
        # 一件 SKU 只能有一条流水线记录，重复登记直接撞唯一键
        sa.UniqueConstraint("sku_id", name="uq_sku_auto_listing_sku"),
    )
    op.create_index("ix_sku_auto_listing_stage", "sku_auto_listing", ["stage"])
    op.create_index("ix_sku_auto_listing_spu_id", "sku_auto_listing", ["spu_id"])
    # worker 按 (stage, next_run_at) 捞待处理行
    op.create_index("ix_sku_auto_listing_next_run_at", "sku_auto_listing", ["next_run_at"])


def downgrade() -> None:
    op.drop_index("ix_sku_auto_listing_next_run_at", table_name="sku_auto_listing")
    op.drop_index("ix_sku_auto_listing_spu_id", table_name="sku_auto_listing")
    op.drop_index("ix_sku_auto_listing_stage", table_name="sku_auto_listing")
    op.drop_table("sku_auto_listing")
