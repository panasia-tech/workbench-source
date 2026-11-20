"""删掉 ERP 内嵌的那套旧群控（gc_device / gc_task）

# 为什么是死的

群控早就独立成服务了（groupcontrol-server，:8100，nginx 的 /gc/ 转发到它），
ERP 这边只保留 gc_bridge 作为代理。但 045 建的这两张表、routers/groupcontrol.py
的 9 条 /api/gc 路由、还有一个每次启动都初始化的 WebSocket 网关，一直留着没清。

2026-09-16 核对生产：gc_device 0 行，gc_task 0 行。

# 为什么非清不可

两个 `/api/gc` 前缀并存——ERP 自己挂一个，nginx 又把 /gc/ 转发到真群控。改错地方
的成本很高，代码里已经有人留下「别与旧内嵌 /api/gc/* 混」这种注释，说明有人绊过。
留着一套没人用、名字又和在用的那套一样的东西，是个会持续收利息的债。

# 顺带说明

gc_account_profile.gc_device_id 指的是**新群控**的设备 id，是个普通字符串列，
没有外键指到这里，所以删这两张表不会连累它。

Revision ID: 069_drop_legacy_groupcontrol
Revises: 068_workbench_lease
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "069_drop_legacy_groupcontrol"
down_revision: Union[str, None] = "068_workbench_lease"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 先任务后设备：gc_task.device_id 指向 gc_device
    op.drop_table("gc_task")
    op.drop_table("gc_device")


def downgrade() -> None:
    """按 045 原样重建。空表，回滚只是把壳子放回去。"""
    op.create_table(
        "gc_device",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("device_token", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="OFFLINE"),
        sa.Column("last_seen_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "gc_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("gc_device.id"), nullable=True),
        sa.Column("task_type", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("result", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
