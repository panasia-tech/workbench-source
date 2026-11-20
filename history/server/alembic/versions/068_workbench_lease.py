"""浏览器工作台的设备登记与爬虫租约

一个员工账号允许在多台电脑上同时登录，但同一个爬虫任何时候只能在一台电脑上开着。
互斥必须由服务端判——两台电脑各记一个「我开着」，谁也不知道对方。

crawler_lease 用 feature 作主键：一个功能只能有一行，互斥由数据库保证，
不靠应用层自觉。

Revision ID: 068_workbench_lease
Revises: 067_sku_auto_listing
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "068_workbench_lease"
down_revision: Union[str, None] = "067_sku_auto_listing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workbench_device",
        # 客户端安装时生成并落盘；服务端只认不发——服务端发 id 意味着每次重装
        # 都会多出一台永远不再心跳的僵尸设备
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("name", sa.String(length=64), nullable=False, server_default="未命名电脑"),
        sa.Column("os", sa.String(length=32), nullable=True),
        sa.Column("app_version", sa.String(length=32), nullable=True),
        # 只作展示：租约归设备不归人，管理员下班关掉应用，租约该因为没人续期而释放
        sa.Column("last_staff_id", sa.String(length=36), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_workbench_device_last_seen_at", "workbench_device", ["last_seen_at"])
    op.create_index("ix_workbench_device_last_staff_id", "workbench_device", ["last_staff_id"])

    op.create_table(
        "crawler_lease",
        sa.Column("feature", sa.String(length=16), primary_key=True),
        sa.Column("device_id", sa.String(length=64), nullable=False),
        sa.Column("staff_id", sa.String(length=36), nullable=True),
        sa.Column("acquired_at", sa.DateTime(), nullable=False),
        # 过了这个点就算失联，别人可以接手。断电/关机不会主动还租约，只能靠它。
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        # 管理员请求让位的目标；持有方跑完当前这轮再放手，不掐断正在跑的采集
        sa.Column("handoff_to", sa.String(length=64), nullable=True),
        sa.Column("handoff_by", sa.String(length=36), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_crawler_lease_device_id", "crawler_lease", ["device_id"])
    op.create_index("ix_crawler_lease_expires_at", "crawler_lease", ["expires_at"])


    # AdsPower 分组归属：原来每台机器一份 run/env_purposes.json，谁改谁的。
    # 收到服务端后它是唯一说明书，工作台登录时拉下来推进本机代理。
    op.create_table(
        "ads_env_purpose",
        # 分组名就是主键：AdsPower 侧也按名字认，多一个 id 只会多一次对不上的机会
        sa.Column("name", sa.String(length=32), primary_key=True),
        sa.Column("owner", sa.String(length=16), nullable=False),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column("updated_by", sa.String(length=36), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("ads_env_purpose")
    op.drop_table("crawler_lease")
    op.drop_table("workbench_device")
