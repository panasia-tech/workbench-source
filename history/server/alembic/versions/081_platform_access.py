"""统一登录第三期：能进哪些系统（平台分组 → 统一登录里的应用）

  platform_access_map  平台分组 → 能进的系统（group_id 为空 = 所有员工）

默认按 10-19 老板定的：所有员工 → Frappe、门户（Homarr）；ERP管理员另加 Paperless、NocoBase、LiteLLM、Netdata、
Gatus。别的系统（Budibase、Rundeck、n8n、Twenty、Snipe-IT、Donetick、Homebox、Plane、自研控制台）ERP 的号都不进，
回到 10-18 之前。员工工作台不在表里：它有自己的策略，固定给所有员工。

系统的 key 见 app/services/authentik_access.py 的 SYSTEMS。分组按名字找（同 080）：改了名、删掉了的分组不种那一条。
只在建表时种一次，之后在后台「统一登录」页里改。见 app/models/sso.py、docs/统一登录接入说明.md 第七节。

Revision ID: 081_platform_access
Revises: 080_frappe_sync
"""
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "081_platform_access"
down_revision: Union[str, None] = "080_frappe_sync"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (组名, 系统)。组名为 None = 所有员工
DEFAULT_ACCESS_MAP = [
    (None, "frappe"),
    (None, "portal"),
    ("ERP管理员", "paperless"),
    ("ERP管理员", "nocobase"),
    ("ERP管理员", "litellm"),
    ("ERP管理员", "netdata"),
    ("ERP管理员", "gatus"),
]


def _timestamps():
    return [
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    ]


def upgrade() -> None:
    access_map = op.create_table(
        "platform_access_map",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("group_id", sa.String(length=36), nullable=True),
        sa.Column("system", sa.String(length=32), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["group_id"], ["platform_group.id"], name="fk_platform_access_map_group"),
        sa.UniqueConstraint("group_id", "system", name="uq_platform_access_map"),
    )
    op.create_index("ix_platform_access_map_group_id", "platform_access_map", ["group_id"])

    group_ids = {name: gid for gid, name in op.get_bind().execute(sa.text("SELECT id, name FROM platform_group"))}
    rows = [
        {"id": str(uuid.uuid4()), "group_id": group_ids[group] if group else None, "system": system}
        for group, system in DEFAULT_ACCESS_MAP
        if group is None or group in group_ids
    ]
    if rows:
        op.bulk_insert(access_map, rows)


def downgrade() -> None:
    op.drop_table("platform_access_map")
