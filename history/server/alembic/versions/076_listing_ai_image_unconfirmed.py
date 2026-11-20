"""上架信息标记「主图是 AI 按型号生成的、还没人确认」

10-08 文生图把「盛色 N50PRO6」(显示器)画成了耳机——没有同型号实拍图可参考时,AI 只能凭型号名猜品类。
用户定:有同款实拍图的拿它当参考重绘,自动上架;没有同款的照样生成,但要人在小程序里确认才上架。
这一列为真时后台不下发,等人点「确认上架」或在填表页自己保存了图片。
见 app/services/gc_bridge/ai_image_publish.py。

Revision ID: 076_listing_ai_image_unconfirmed
Revises: 075_shop_listing_ai_image_job
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "076_listing_ai_image_unconfirmed"
down_revision: Union[str, None] = "075_shop_listing_ai_image_job"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku_listing_info", sa.Column("ai_image_unconfirmed", sa.Boolean(), nullable=False,
                                                server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("sku_listing_info", "ai_image_unconfirmed")
