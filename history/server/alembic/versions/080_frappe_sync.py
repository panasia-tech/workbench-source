"""统一登录第二期：Frappe（hr.panasia.fun）按平台分组开号、给角色

  frappe_role_map  平台分组 → Frappe 角色（group_id 为空 = 所有员工）
  frappe_account   同步在 Frappe 里给员工建的号，和同步加上去、归它撤的角色

默认映射（角色名都在 Frappe 各 app 的源码里核对过）：所有员工 → LMS Student（Learning）；销售 → Sales User
（CRM）；ERP管理员 → Sales Manager、Sales User（CRM 自己给经理角色也是两个一起给）。不给 Employee（跟着 Frappe
员工档案走，见 services/frappe_sync.py 的 BLOCKED_ROLES），也不给 System Manager。

分组按名字找：079 种的分组线上已经在用，改了名或删掉了的，就不种那一条。只在建表时种一次，之后在后台「统一登录」
页里改。见 app/models/sso.py、docs/统一登录接入说明.md。

Revision ID: 080_frappe_sync
Revises: 079_platform_sso
"""
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "080_frappe_sync"
down_revision: Union[str, None] = "079_platform_sso"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (组名, Frappe 角色)。组名为 None = 所有员工
DEFAULT_ROLE_MAP = [
    (None, "LMS Student"),
    ("销售", "Sales User"),
    ("ERP管理员", "Sales Manager"),
    ("ERP管理员", "Sales User"),
]


def _timestamps():
    return [
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    ]


def upgrade() -> None:
    role_map = op.create_table(
        "frappe_role_map",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("group_id", sa.String(length=36), nullable=True),
        sa.Column("role", sa.String(length=140), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["group_id"], ["platform_group.id"], name="fk_frappe_role_map_group"),
        sa.UniqueConstraint("group_id", "role", name="uq_frappe_role_map"),
    )
    op.create_index("ix_frappe_role_map_group_id", "frappe_role_map", ["group_id"])

    op.create_table(
        "frappe_account",
        sa.Column("staff_id", sa.String(length=36), primary_key=True),
        sa.Column("frappe_user", sa.String(length=140), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("roles", sa.JSON(), nullable=False),
        sa.Column("synced_at", sa.DateTime(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["staff_id"], ["staff.id"], name="fk_frappe_account_staff"),
    )

    group_ids = {name: gid for gid, name in op.get_bind().execute(sa.text("SELECT id, name FROM platform_group"))}
    rows = [
        {"id": str(uuid.uuid4()), "group_id": group_ids[group] if group else None, "role": role}
        for group, role in DEFAULT_ROLE_MAP
        if group is None or group in group_ids
    ]
    if rows:
        op.bulk_insert(role_map, rows)


def downgrade() -> None:
    op.drop_table("frappe_account")
    op.drop_table("frappe_role_map")
