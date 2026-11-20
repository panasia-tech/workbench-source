"""SPU 共享同款图库:审核通过后整池写入商品档案,上架页按品牌+型号直接读取

Revision ID: 110_spu_image_archive
Revises: 109_staff_github
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "110_spu_image_archive"
down_revision: Union[str, None] = "109_staff_github"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "warehouse_spu_image",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "spu_id",
            sa.String(36),
            sa.ForeignKey("warehouse_spu.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("model_key", sa.String(128), nullable=False),
        sa.Column("url", sa.String(512), nullable=False),
        sa.Column("url_hash", sa.String(32), nullable=False),
        sa.Column("crawler_url", sa.String(1024), nullable=True),
        sa.Column("source_url", sa.String(1024), nullable=True),
        sa.Column("source", sa.String(16), nullable=False, server_default="crawler"),
        sa.Column("status", sa.String(16), nullable=False, server_default="approved"),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("watermark", sa.String(16), nullable=True),
        sa.Column("quality_grade", sa.String(8), nullable=True),
        sa.Column("quality_score", sa.Float(), nullable=True),
        sa.Column("quality_flags", sa.JSON(), nullable=True),
        sa.Column("product_confidence", sa.Float(), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_cover", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("crawler_task_id", sa.String(64), nullable=True),
        sa.Column("approved_by", sa.String(64), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("spu_id", "url_hash", name="uq_spu_image_spu_url"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(
        "ix_warehouse_spu_image_model_key_status",
        "warehouse_spu_image",
        ["model_key", "status"],
    )
    op.create_index(
        "ix_warehouse_spu_image_spu_id_status",
        "warehouse_spu_image",
        ["spu_id", "status"],
    )
    op.create_index("ix_warehouse_spu_image_url_hash", "warehouse_spu_image", ["url_hash"])

    op.add_column(
        "spu_image_search",
        sa.Column("archive_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("spu_image_search", sa.Column("archived_at", sa.DateTime(), nullable=True))
    op.add_column("spu_image_search", sa.Column("search_progress", sa.JSON(), nullable=True))
    op.add_column(
        "spu_image_search", sa.Column("last_requested_at", sa.DateTime(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("spu_image_search", "last_requested_at")
    op.drop_column("spu_image_search", "search_progress")
    op.drop_column("spu_image_search", "archived_at")
    op.drop_column("spu_image_search", "archive_count")
    op.drop_index("ix_warehouse_spu_image_url_hash", table_name="warehouse_spu_image")
    op.drop_index(
        "ix_warehouse_spu_image_spu_id_status", table_name="warehouse_spu_image"
    )
    op.drop_index(
        "ix_warehouse_spu_image_model_key_status", table_name="warehouse_spu_image"
    )
    op.drop_table("warehouse_spu_image")
