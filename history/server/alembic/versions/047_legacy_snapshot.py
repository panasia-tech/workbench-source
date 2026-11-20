"""老系统库存快照参考表：legacy_snapshot（仓库搜索兜底用）

Revision ID: 047_legacy_snapshot
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "047_legacy_snapshot"
# 注意：挂在 046 之后（而非 045_groupcontrol），使本迁移可独立于尚未上线的
# groupcontrol 部署。groupcontrol(045) 已改挂到本迁移之后。生产升级用
# `alembic upgrade 047_legacy_snapshot`，不要用 head。
down_revision: Union[str, None] = "046_purchase_webhook"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "legacy_snapshot",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("legacy_id", sa.String(length=64), nullable=False),
        sa.Column("goods_no", sa.String(length=64), nullable=True),
        sa.Column("product_name", sa.String(length=256), nullable=True),
        sa.Column("model", sa.String(length=128), nullable=True),
        sa.Column("serial_no", sa.String(length=128), nullable=True),
        sa.Column("barcode", sa.String(length=128), nullable=True),
        sa.Column("cover_url", sa.String(length=512), nullable=True),
        sa.Column("location", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=True),
        sa.Column("qty", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("purchase_price_fen", sa.Integer(), nullable=True),
        sa.Column("inbound_at", sa.DateTime(), nullable=True),
        sa.Column("source_system", sa.String(length=32), nullable=True),
        sa.Column("legacy_tag", sa.String(length=128), nullable=True),
        sa.Column("migrated_sku_code", sa.String(length=64), nullable=True),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(op.f("ix_legacy_snapshot_legacy_id"), "legacy_snapshot", ["legacy_id"], unique=True)
    op.create_index(op.f("ix_legacy_snapshot_goods_no"), "legacy_snapshot", ["goods_no"], unique=False)
    op.create_index(op.f("ix_legacy_snapshot_product_name"), "legacy_snapshot", ["product_name"], unique=False)
    op.create_index(op.f("ix_legacy_snapshot_serial_no"), "legacy_snapshot", ["serial_no"], unique=False)
    op.create_index(op.f("ix_legacy_snapshot_barcode"), "legacy_snapshot", ["barcode"], unique=False)
    op.create_index(op.f("ix_legacy_snapshot_status"), "legacy_snapshot", ["status"], unique=False)
    op.create_index(
        op.f("ix_legacy_snapshot_migrated_sku_code"), "legacy_snapshot", ["migrated_sku_code"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_legacy_snapshot_migrated_sku_code"), table_name="legacy_snapshot")
    op.drop_index(op.f("ix_legacy_snapshot_status"), table_name="legacy_snapshot")
    op.drop_index(op.f("ix_legacy_snapshot_barcode"), table_name="legacy_snapshot")
    op.drop_index(op.f("ix_legacy_snapshot_serial_no"), table_name="legacy_snapshot")
    op.drop_index(op.f("ix_legacy_snapshot_product_name"), table_name="legacy_snapshot")
    op.drop_index(op.f("ix_legacy_snapshot_goods_no"), table_name="legacy_snapshot")
    op.drop_index(op.f("ix_legacy_snapshot_legacy_id"), table_name="legacy_snapshot")
    op.drop_table("legacy_snapshot")
