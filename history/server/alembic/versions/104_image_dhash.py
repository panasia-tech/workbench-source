"""上架图判重：图床上每张图的灰度 dHash 缓存（各号首图、整组图看起来像不像）

按 OSS 对象 key 认（key_hash = md5(key)），见 app/services/image_similarity.py。

Revision ID: 104_image_dhash
Revises: 103_image_material_status
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "104_image_dhash"
down_revision: Union[str, None] = "103_image_material_status"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "image_dhash",
        sa.Column("key_hash", sa.String(32), primary_key=True),
        sa.Column("object_key", sa.String(512), nullable=False),
        sa.Column("dhash", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("image_dhash")
