"""员工关联钉钉 userid:钉钉入职建号、离职删号按它认人

不加唯一约束:软删除的号保留原 userid,同一个人离职再入职会再建一个号。

Revision ID: 090_staff_dingtalk
Revises: 089_shop_images
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "090_staff_dingtalk"
down_revision: Union[str, None] = "089_shop_images"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("staff", sa.Column("dingtalk_userid", sa.String(64), nullable=True))
    op.create_index("ix_staff_dingtalk_userid", "staff", ["dingtalk_userid"])


def downgrade() -> None:
    op.drop_index("ix_staff_dingtalk_userid", table_name="staff")
    op.drop_column("staff", "dingtalk_userid")
