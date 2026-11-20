"""页面上改的键值配置 app_setting

第一个用到的是聊天「发送仓库位置」的自提地址（pickup_address），管理员在聊天页里直接填。
见 app/models/app_setting.py、app/routers/chat_assist.py。

Revision ID: 083_app_setting
Revises: 082_frappe_departments
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "083_app_setting"
down_revision: Union[str, None] = "082_frappe_departments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "app_setting",
        sa.Column("key", sa.String(length=64), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("app_setting")
