"""员工记钉钉部门、GitHub 账号:钉钉按部门给角色,技术部新人填 GitHub 后自动邀请进代码仓库

Revision ID: 109_staff_github
Revises: 108_image_dewatermark
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "109_staff_github"
down_revision: Union[str, None] = "108_image_dewatermark"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("staff", sa.Column("department", sa.String(128), nullable=True))
    op.add_column("staff", sa.Column("github_account", sa.String(128), nullable=True))
    op.add_column("staff", sa.Column("github_status", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("staff", "github_status")
    op.drop_column("staff", "github_account")
    op.drop_column("staff", "department")
