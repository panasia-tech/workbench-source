"""占位：锁货 / 手动出库后联动下架（E05-16）+ 行情样本转人工（E04-10）

两件事都不加表不加列：开关和阈值存在 app_setting（stock_lock_delist、auto_listing_sample_check、
auto_listing_min_samples、auto_listing_max_spread），没写就是默认（关）。这个文件只为占住版本号。

Revision ID: 105_stock_lock_delist
Revises: 104_image_dhash
"""
from typing import Sequence, Union

revision: str = "105_stock_lock_delist"
down_revision: Union[str, None] = "104_image_dhash"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
