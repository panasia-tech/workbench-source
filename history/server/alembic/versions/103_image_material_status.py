"""上架素材分池：候选图的人工结论（可用 / 淘汰 + 原因）

没有这一行的图按规则算（爬虫质量分 bad → 待复核，像头像、表情包、截图的 → 淘汰），见 app/services/image_material.py。
按图床干净地址认（url_hash = md5(url)，url 太长不直接建唯一索引）。

Revision ID: 103_image_material_status
Revises: 102_ledger_alipay_bills
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "103_image_material_status"
down_revision: Union[str, None] = "102_ledger_alipay_bills"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "image_material_mark",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("url_hash", sa.String(32), nullable=False),
        sa.Column("url", sa.String(512), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(64), nullable=True),
        sa.Column("sku_id", sa.String(36), nullable=True),
        sa.Column("spu_id", sa.String(36), nullable=True),
        sa.Column("marked_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_image_material_mark_url_hash", "image_material_mark", ["url_hash"], unique=True)
    op.create_index("ix_image_material_mark_sku_id", "image_material_mark", ["sku_id"])


def downgrade() -> None:
    op.drop_index("ix_image_material_mark_sku_id", table_name="image_material_mark")
    op.drop_index("ix_image_material_mark_url_hash", table_name="image_material_mark")
    op.drop_table("image_material_mark")
