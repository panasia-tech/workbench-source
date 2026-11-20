"""员工手机卡信息一对多：新建 staff_sim_card 表，移除 staff.phone / staff.iccid 单字段

原 048 在 staff 上加的 phone/iccid 单字段改为独立的 staff_sim_card 一对多表
（一名员工可绑定多张卡片，每张含手机号 / ICCID / 空卡序列号）。

Revision ID: 049_staff_sim_card
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "049_staff_sim_card"
down_revision: Union[str, None] = "048_staff_contact"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "staff_sim_card",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("staff_id", sa.String(length=36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("phone", sa.String(length=32), nullable=True),
        sa.Column("iccid", sa.String(length=50), nullable=True),
        sa.Column("blank_serial", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        # 带外键的新表须显式 unicode_ci，否则与 staff 表 collation 不一致导致 1215 外键失败
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index("ix_staff_sim_card_staff_id", "staff_sim_card", ["staff_id"])

    op.drop_column("staff", "iccid")
    op.drop_column("staff", "phone")


def downgrade() -> None:
    op.add_column("staff", sa.Column("phone", sa.String(length=32), nullable=True))
    op.add_column("staff", sa.Column("iccid", sa.String(length=50), nullable=True))
    op.drop_index("ix_staff_sim_card_staff_id", table_name="staff_sim_card")
    op.drop_table("staff_sim_card")
