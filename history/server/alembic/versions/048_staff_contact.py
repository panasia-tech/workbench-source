"""员工表新增联系方式字段（手机号 / ICCID）

Revision ID: 048_staff_contact
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "048_staff_contact"
down_revision: Union[str, None] = "045_groupcontrol"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("staff", sa.Column("phone", sa.String(length=32), nullable=True))
    op.add_column("staff", sa.Column("iccid", sa.String(length=50), nullable=True))


def downgrade() -> None:
    op.drop_column("staff", "iccid")
    op.drop_column("staff", "phone")
