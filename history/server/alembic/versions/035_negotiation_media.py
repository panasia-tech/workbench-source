"""sku 增加 negotiation_media 字段（议价证据：图片/视频混存）

Revision ID: 035_negotiation_media
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "035_negotiation_media"
down_revision: Union[str, None] = "034_market_crawl"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # MySQL 的 JSON 列不能带字面量 DEFAULT，沿用项目约定：nullable=True，由模型 default=list 兜底
    op.add_column(
        "sku",
        sa.Column("negotiation_media", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sku", "negotiation_media")
