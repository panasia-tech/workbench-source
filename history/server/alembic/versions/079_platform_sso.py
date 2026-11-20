"""统一登录第一期：ERP 当 Authentik 的账号来源（OIDC 授权码）、平台分组、同步对照

  oidc_auth_code         ERP 账号登录发出的授权码和 access_token（只存哈希）
  platform_group         平台分组：按 ERP 角色自动进，或手工挂人；带同步回写的 Authentik 对照
  platform_group_member  手工挂进分组的员工
  authentik_account      员工在 Authentik 里的号（同步确认过才有），ERP 登录页凭它放行

默认分组按 10-18 定的：ADMIN→ERP管理员、PURCHASER→采购、WAREHOUSE→仓管、NEGOTIATOR→议价、
SALES→销售、FINANCE→财务；另建两个不挂角色的空组给工作台（工作台老板 / 工作台管理员，手工挂人）。
见 app/models/sso.py、docs/统一登录接入说明.md。

Revision ID: 079_platform_sso
Revises: 078_miaoda_binding
"""
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "079_platform_sso"
down_revision: Union[str, None] = "078_miaoda_binding"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (组名, 自动进组的角色, 说明)。只在建表时种一次，之后在后台「统一登录分组」里改。
DEFAULT_GROUPS = [
    ("ERP管理员", ["ADMIN"], None),
    ("采购", ["PURCHASER"], None),
    ("仓管", ["WAREHOUSE"], None),
    ("议价", ["NEGOTIATOR"], None),
    ("销售", ["SALES"], None),
    ("财务", ["FINANCE"], None),
    ("工作台老板", [], "员工工作台的老板角色（工作台 AUTH_BOSS_GROUPS），手工挂人"),
    ("工作台管理员", [], "员工工作台的管理员角色（工作台 AUTH_ADMIN_GROUPS），手工挂人"),
]


def _timestamps():
    return [
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "oidc_auth_code",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("client_id", sa.String(length=128), nullable=False),
        sa.Column("staff_id", sa.String(length=36), nullable=False),
        sa.Column("redirect_uri", sa.String(length=512), nullable=False),
        sa.Column("scope", sa.String(length=255), nullable=False),
        sa.Column("nonce", sa.String(length=255), nullable=True),
        sa.Column("code_challenge", sa.String(length=128), nullable=False),
        sa.Column("auth_time", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("access_token_hash", sa.String(length=64), nullable=True),
        sa.Column("access_expires_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(["staff_id"], ["staff.id"], name="fk_oidc_auth_code_staff"),
        sa.UniqueConstraint("code_hash", name="uq_oidc_auth_code_code_hash"),
        sa.UniqueConstraint("access_token_hash", name="uq_oidc_auth_code_access_token_hash"),
    )
    op.create_index("ix_oidc_auth_code_staff_id", "oidc_auth_code", ["staff_id"])
    op.create_index("ix_oidc_auth_code_expires_at", "oidc_auth_code", ["expires_at"])

    group = op.create_table(
        "platform_group",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("description", sa.String(length=255), nullable=True),
        sa.Column("roles", sa.JSON(), nullable=False),
        sa.Column("authentik_pk", sa.String(length=64), nullable=True),
        sa.Column("authentik_name", sa.String(length=80), nullable=True),
        sa.Column("authentik_note", sa.String(length=255), nullable=True),
        sa.Column("authentik_synced_at", sa.DateTime(), nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("name", name="uq_platform_group_name"),
    )

    op.create_table(
        "platform_group_member",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("group_id", sa.String(length=36), nullable=False),
        sa.Column("staff_id", sa.String(length=36), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["group_id"], ["platform_group.id"], name="fk_platform_group_member_group"),
        sa.ForeignKeyConstraint(["staff_id"], ["staff.id"], name="fk_platform_group_member_staff"),
        sa.UniqueConstraint("group_id", "staff_id", name="uq_platform_group_member"),
    )
    op.create_index("ix_platform_group_member_group_id", "platform_group_member", ["group_id"])
    op.create_index("ix_platform_group_member_staff_id", "platform_group_member", ["staff_id"])

    op.create_table(
        "authentik_account",
        sa.Column("staff_id", sa.String(length=36), primary_key=True),
        sa.Column("authentik_pk", sa.Integer(), nullable=False),
        sa.Column("authentik_username", sa.String(length=150), nullable=False),
        sa.Column("synced_at", sa.DateTime(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["staff_id"], ["staff.id"], name="fk_authentik_account_staff"),
    )

    op.bulk_insert(group, [
        {"id": str(uuid.uuid4()), "name": name, "roles": roles, "description": description}
        for name, roles, description in DEFAULT_GROUPS
    ])


def downgrade() -> None:
    op.drop_table("authentik_account")
    op.drop_table("platform_group_member")
    op.drop_table("platform_group")
    op.drop_table("oidc_auth_code")
