"""群控账号初始化档案表(gc_account_profile)

Revision ID: 064_gc_account_profile
Revises: 063_sku_spu
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "064_gc_account_profile"
down_revision: Union[str, None] = "063_sku_spu"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "gc_account_profile",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("gc_account_id", sa.String(36), nullable=False),
        sa.Column("nick", sa.String(64), nullable=False),
        sa.Column("member_name", sa.String(64), nullable=True),
        sa.Column("gc_device_id", sa.String(36), nullable=True),
        sa.Column("device_serial", sa.String(64), nullable=True),
        sa.Column("imei1", sa.String(32), nullable=True),
        sa.Column("imei2", sa.String(32), nullable=True),
        sa.Column("phone_number", sa.String(32), nullable=True),
        sa.Column("asset_device_id", sa.String(36), sa.ForeignKey("asset_device.id"), nullable=True),
        sa.Column("asset_no", sa.String(32), nullable=True),
        sa.Column("carrier", sa.String(32), nullable=True),
        sa.Column("plan_details", sa.Text, nullable=True),
        sa.Column("legal_person", sa.String(64), nullable=True),
        sa.Column("account_type", sa.String(16), nullable=True),
        sa.Column("remark", sa.Text, nullable=True),
        sa.Column("exception_strategies", sa.JSON, nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("completed_at", sa.DateTime, nullable=True),
        sa.Column("completed_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_gc_account_profile_gc_account_id", "gc_account_profile", ["gc_account_id"], unique=True)
    op.create_index("ix_gc_account_profile_nick", "gc_account_profile", ["nick"])
    op.create_index("ix_gc_account_profile_device_serial", "gc_account_profile", ["device_serial"])
    op.create_index("ix_gc_account_profile_asset_device_id", "gc_account_profile", ["asset_device_id"])
    op.create_index("ix_gc_account_profile_status", "gc_account_profile", ["status"])


def downgrade() -> None:
    op.drop_table("gc_account_profile")
