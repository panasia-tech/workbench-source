"""店铺上架行记「在等哪张 AI 生成的主图」

手动上架时货没有商品图,改为先按「品牌 型号」文生图、出图后自动上架(同自动上架流水线的兜底)。
等图期间店铺行停在「上架中」,这一列记着等的是哪个 ai_redraw_job;出图/失败后清空。
见 app/services/gc_bridge/ai_image_publish.py。

Revision ID: 075_shop_listing_ai_image_job
Revises: 074_login_throttle
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "075_shop_listing_ai_image_job"
down_revision: Union[str, None] = "074_login_throttle"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku_shop_listing", sa.Column("ai_image_job_id", sa.String(length=36), nullable=True))
    op.create_index("ix_sku_shop_listing_ai_image_job_id", "sku_shop_listing", ["ai_image_job_id"])


def downgrade() -> None:
    op.drop_index("ix_sku_shop_listing_ai_image_job_id", table_name="sku_shop_listing")
    op.drop_column("sku_shop_listing", "ai_image_job_id")
