"""行情采集轮次

采集此前完全是本机的事：桌面端自己定时、自己跑、结果存本机 electron-store。
服务端只收到「决策影子」（每次定价怎么算的），收不到轮次——所以「昨晚那台电脑
到底跑没跑」「跑了多久」「多少条失败」，只有坐在那台电脑前的人知道。

爬虫租约解决了「谁该跑」，这张表解决「跑得怎么样」，顺带把手动触发也接上：
管理员在任意一台登录都能发起一轮。

它不是任务队列：只记登记/认领/结束三个时刻和一份计数，采集内部的调度仍在端上
（一轮几十分钟、中途断点续跑，搬成队列会把端上跑了三个月的调度推倒重来）。

Revision ID: 071_market_crawl_run
Revises: 070_workbench_ads_envs
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "071_market_crawl_run"
down_revision: Union[str, None] = "070_workbench_ads_envs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "market_crawl_run",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("device_id", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="PENDING"),
        sa.Column("trigger", sa.String(length=16), nullable=False, server_default="manual"),
        sa.Column("staff_id", sa.String(length=36), nullable=True),
        # 端上那份历史记录的 id：出问题时要能从服务端这条对到本机那条
        sa.Column("local_run_id", sa.String(length=64), nullable=True),
        # 服务端当时不可达，端上先跑了、事后补登记。宁可事后知道，不要不知道。
        sa.Column("offline_started", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("success", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reason", sa.String(length=300), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_market_crawl_run_device_id", "market_crawl_run", ["device_id"])
    op.create_index("ix_market_crawl_run_status", "market_crawl_run", ["status"])
    op.create_index("ix_market_crawl_run_created_at", "market_crawl_run", ["created_at"])


def downgrade() -> None:
    op.drop_table("market_crawl_run")
