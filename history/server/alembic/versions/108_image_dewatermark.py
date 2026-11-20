"""占位:去闲鱼水印(销售工作台 V1 第 9 项 / E02)不建表

去水印的来源记录放在处理后图片旁边的同名 .json 里(services/dewatermark.py),不进库。
这个版本只为占住 108 的位置,upgrade / downgrade 什么都不做。

Revision ID: 108_image_dewatermark
Revises: 107_crawl_price_runs
"""
from typing import Sequence, Union

revision: str = "108_image_dewatermark"
down_revision: Union[str, None] = "107_crawl_price_runs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
