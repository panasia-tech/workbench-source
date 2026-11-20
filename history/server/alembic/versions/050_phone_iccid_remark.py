"""手机号管理台账新增 ICCID / 备注 两个字段

Revision ID: 050_phone_iccid_remark
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "050_phone_iccid_remark"
down_revision: Union[str, None] = "049_staff_sim_card"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("phone_number", sa.Column("iccid", sa.String(length=50), nullable=True))
    op.add_column("phone_number", sa.Column("remark", sa.Text(), nullable=True))
    op.create_index("ix_phone_number_iccid", "phone_number", ["iccid"])


def downgrade() -> None:
    op.drop_index("ix_phone_number_iccid", table_name="phone_number")
    op.drop_column("phone_number", "remark")
    op.drop_column("phone_number", "iccid")
