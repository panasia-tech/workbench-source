"""统一登录第四期：按 Frappe HR 员工档案上的部门进平台分组

  frappe_department_map  Frappe 的部门 → 平台分组（一个部门可以进几个组；配在上级部门上，下级部门的人也算）
  frappe_employee        Frappe 同步读到的员工档案：对上了哪个 ERP 员工、部门和它的各级上级、状态（每次读成功整张重写）

不种默认映射：哪个部门进哪些组由老板在后台「统一登录」页的「部门 → 分组」卡片上配，没配之前谁的组都不变。
见 app/models/sso.py、app/services/frappe_departments.py、docs/统一登录接入说明.md 第八节。

Revision ID: 082_frappe_departments
Revises: 081_platform_access
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "082_frappe_departments"
down_revision: Union[str, None] = "081_platform_access"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _timestamps():
    return [
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "frappe_department_map",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("department", sa.String(length=140), nullable=False),
        sa.Column("group_id", sa.String(length=36), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["group_id"], ["platform_group.id"], name="fk_frappe_department_map_group"),
        sa.UniqueConstraint("department", "group_id", name="uq_frappe_department_map"),
    )
    op.create_index("ix_frappe_department_map_group_id", "frappe_department_map", ["group_id"])

    op.create_table(
        "frappe_employee",
        sa.Column("employee", sa.String(length=140), primary_key=True),
        sa.Column("staff_id", sa.String(length=36), nullable=False),
        sa.Column("employee_name", sa.String(length=140), nullable=False),
        sa.Column("department", sa.String(length=140), nullable=True),
        sa.Column("department_path", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("synced_at", sa.DateTime(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["staff_id"], ["staff.id"], name="fk_frappe_employee_staff"),
    )
    op.create_index("ix_frappe_employee_staff_id", "frappe_employee", ["staff_id"])


def downgrade() -> None:
    op.drop_table("frappe_employee")
    op.drop_table("frappe_department_map")
