"""群控调度中心：gc_device + gc_task

Revision ID: 045_groupcontrol
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "045_groupcontrol"
# 改挂到 047_legacy_snapshot 之后：webhook、legacy_snapshot 先独立上线，groupcontrol 随后。
# 链：044 → 046_purchase_webhook → 047_legacy_snapshot → 045_groupcontrol
down_revision: Union[str, None] = "047_legacy_snapshot"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "gc_device",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("device_token", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("client_id", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="OFFLINE"),
        sa.Column("xianyu_account", sa.String(length=64), nullable=True),
        sa.Column("sale_shop_id", sa.String(length=36), nullable=True),
        sa.Column("app_version", sa.String(length=32), nullable=True),
        sa.Column("last_heartbeat_at", sa.DateTime(), nullable=True),
        sa.Column("last_online_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["sale_shop_id"], ["sale_shop.id"]),
        sa.ForeignKeyConstraint(["created_by_id"], ["staff.id"]),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(op.f("ix_gc_device_device_token"), "gc_device", ["device_token"], unique=True)
    op.create_index(op.f("ix_gc_device_client_id"), "gc_device", ["client_id"], unique=False)
    op.create_index(op.f("ix_gc_device_status"), "gc_device", ["status"], unique=False)
    op.create_index(op.f("ix_gc_device_xianyu_account"), "gc_device", ["xianyu_account"], unique=False)

    op.create_table(
        "gc_task",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("device_id", sa.String(length=36), nullable=True),
        sa.Column("task_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="PENDING"),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=True),
        sa.Column("ref_type", sa.String(length=32), nullable=True),
        sa.Column("ref_id", sa.String(length=64), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("mark", sa.String(length=255), nullable=True),
        sa.Column("progress", sa.String(length=32), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("retry", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("dispatched_at", sa.DateTime(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["device_id"], ["gc_device.id"]),
        sa.ForeignKeyConstraint(["created_by_id"], ["staff.id"]),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(op.f("ix_gc_task_device_id"), "gc_task", ["device_id"], unique=False)
    op.create_index(op.f("ix_gc_task_task_type"), "gc_task", ["task_type"], unique=False)
    op.create_index(op.f("ix_gc_task_status"), "gc_task", ["status"], unique=False)
    op.create_index(op.f("ix_gc_task_ref_id"), "gc_task", ["ref_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_gc_task_ref_id"), table_name="gc_task")
    op.drop_index(op.f("ix_gc_task_status"), table_name="gc_task")
    op.drop_index(op.f("ix_gc_task_task_type"), table_name="gc_task")
    op.drop_index(op.f("ix_gc_task_device_id"), table_name="gc_task")
    op.drop_table("gc_task")

    op.drop_index(op.f("ix_gc_device_xianyu_account"), table_name="gc_device")
    op.drop_index(op.f("ix_gc_device_status"), table_name="gc_device")
    op.drop_index(op.f("ix_gc_device_client_id"), table_name="gc_device")
    op.drop_index(op.f("ix_gc_device_device_token"), table_name="gc_device")
    op.drop_table("gc_device")
