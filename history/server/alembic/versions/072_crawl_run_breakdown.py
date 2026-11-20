"""采集轮次记下失败分类

端上一直在分 empty / invalid_price / risk_control 三类，上报时却只送
success/failed——于是服务端看得到「失败 12 条」，看不到为什么。而这三类要采取的
动作完全不同：搜不到结果是改任务，价格解析不出多半是闲鱼改版，**撞风控是停手
等冷却、绝不是重试**。最后这个最该第一眼看见：它意味着账号正在被盯上。

Revision ID: 072_crawl_run_breakdown
Revises: 071_market_crawl_run
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "072_crawl_run_breakdown"
down_revision: Union[str, None] = "071_market_crawl_run"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for col in ("empty", "invalid_price", "risk_control"):
        op.add_column("market_crawl_run",
                      sa.Column(col, sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    for col in ("risk_control", "invalid_price", "empty"):
        op.drop_column("market_crawl_run", col)
