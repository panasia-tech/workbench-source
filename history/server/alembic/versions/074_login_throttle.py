"""登录防暴力尝试的失败计数

H5 版（panasia.fun/h5/）把账号密码登录对公网开给了全体员工，原来所有登录门都没有限流。
规则见 app/services/login_throttle.py；计数要在两个 worker 之间共享，所以落库而不放进程内存。

Revision ID: 074_login_throttle
Revises: 073_crawl_snapshot_request
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "074_login_throttle"
down_revision: Union[str, None] = "073_crawl_snapshot_request"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "login_throttle",
        sa.Column("id", sa.String(length=36), primary_key=True),
        # pair = 账号+IP，ip = IP，user = 账号
        sa.Column("scope", sa.String(length=8), nullable=False),
        sa.Column("subject", sa.String(length=128), nullable=False),
        sa.Column("failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("window_start", sa.DateTime(), nullable=False),
        sa.Column("locked_until", sa.DateTime(), nullable=True),
        sa.Column("lock_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("scope", "subject", name="uq_login_throttle_scope_subject"),
    )
    op.create_index("ix_login_throttle_updated_at", "login_throttle", ["updated_at"])


def downgrade() -> None:
    op.drop_table("login_throttle")
