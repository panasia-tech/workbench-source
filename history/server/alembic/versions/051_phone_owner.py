"""手机号台账加归属员工 owner_id：员工各管各的，管理员看全部

Revision ID: 051_phone_owner
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "051_phone_owner"
down_revision: Union[str, None] = "050_phone_iccid_remark"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # phone_number 建表时已显式 utf8mb4_unicode_ci(043)，与 staff 一致，FK 无 1215 风险
    op.add_column("phone_number", sa.Column("owner_id", sa.String(length=36), nullable=True))
    op.create_index("ix_phone_number_owner_id", "phone_number", ["owner_id"])
    op.create_foreign_key(
        "fk_phone_number_owner_id_staff", "phone_number", "staff", ["owner_id"], ["id"]
    )


def downgrade() -> None:
    op.drop_constraint("fk_phone_number_owner_id_staff", "phone_number", type_="foreignkey")
    op.drop_index("ix_phone_number_owner_id", table_name="phone_number")
    op.drop_column("phone_number", "owner_id")
