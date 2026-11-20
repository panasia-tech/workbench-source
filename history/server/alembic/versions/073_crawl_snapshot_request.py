"""按需取回某一轮采集的现场

快照是整页 DOM，一个型号一轮最多 12 份。全量传 OSS 是 GB 级的量，而绝大多数
永远不会有人看——只有出了事那几轮才有人想看现场。所以默认不传，要看再取。

做成「待办」而不是「在线推送」：要看的时候往往正是出了事的时候，那台电脑很可能
恰好不在线（关机、断网、进程崩了）。待办让端上每次心跳问一句「有没有要我传的」，
在线就立刻传、不在线就下次开机补传，一条路覆盖两种情况。手法搬自群控的
gc_log_request，那边已经跑通。

Revision ID: 073_crawl_snapshot_request
Revises: 072_crawl_run_breakdown
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "073_crawl_snapshot_request"
down_revision: Union[str, None] = "072_crawl_run_breakdown"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "crawl_snapshot_request",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("device_id", sa.String(length=64), nullable=False),
        # 端上那一轮的 id：端上按它去本机找对应的快照文件
        sa.Column("local_run_id", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="PENDING"),
        sa.Column("requested_by", sa.String(length=36), nullable=True),
        sa.Column("object_key", sa.String(length=300), nullable=True),
        sa.Column("bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reason", sa.String(length=300), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_crawl_snapshot_request_run_id", "crawl_snapshot_request", ["run_id"])
    op.create_index("ix_crawl_snapshot_request_device_id", "crawl_snapshot_request", ["device_id"])
    op.create_index("ix_crawl_snapshot_request_status", "crawl_snapshot_request", ["status"])
    op.create_index("ix_crawl_snapshot_request_created_at", "crawl_snapshot_request", ["created_at"])


def downgrade() -> None:
    op.drop_table("crawl_snapshot_request")
