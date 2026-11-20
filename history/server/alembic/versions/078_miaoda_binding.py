"""员工工作台（妙搭）免登录进 H5：工作台账号 → ERP 账号的确认绑定

工作台那边的绑定是员工自己填的，ERP 不直接信；第一次进来输一次 ERP 密码确认本人，记在这张表，
之后免登录。见 app/models/miaoda_binding.py。

Revision ID: 078_miaoda_binding
Revises: 077_asset_intake
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "078_miaoda_binding"
down_revision: Union[str, None] = "077_asset_intake"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "miaoda_binding",
        sa.Column("miaoda_user_id", sa.String(length=64), primary_key=True),
        sa.Column("staff_id", sa.String(length=36), nullable=False),
        sa.Column("last_entry_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["staff_id"], ["staff.id"], name="fk_miaoda_binding_staff"),
    )
    op.create_index("ix_miaoda_binding_staff_id", "miaoda_binding", ["staff_id"])


def downgrade() -> None:
    op.drop_table("miaoda_binding")
