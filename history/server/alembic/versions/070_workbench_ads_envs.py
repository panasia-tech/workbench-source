"""工作台电脑记下它托管了哪些 AdsPower 环境

gc_device 和 workbench_device 模型的不是同一个东西：前者一行 = 一个执行单元
（一台手机，或一个 AdsPower 环境，绑闲鱼账号、接任务、有配额风控），后者一行 =
一台员工的电脑。一台电脑上可以挂十几个环境（2026-09-16 本机实测 11 个）。
是一对多，不是重复——所以不该合表。

但此前两边毫无关联：管理员在「机器现状」看到 4 个浏览器执行端，在「爬虫开关」
看到几台电脑，却说不出这些环境跑在谁的机器上。这一列就是那条关联。

Revision ID: 070_workbench_ads_envs
Revises: 069_drop_legacy_groupcontrol
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "070_workbench_ads_envs"
down_revision: Union[str, None] = "069_drop_legacy_groupcontrol"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("workbench_device", sa.Column("ads_env_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("workbench_device", "ads_env_ids")
