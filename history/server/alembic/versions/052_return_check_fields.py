"""退货单收货核对/异常裁决字段：仓库收货强制核对（序列号/状态/库位/照片），异常件管理员裁决

Revision ID: 052_return_check_fields
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "052_return_check_fields"
down_revision: Union[str, None] = "051_phone_owner"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 全部可空、无默认值（JSON 列不设 server_default——042 的坑），存量退货单不受影响。
# resolved_by_id 不建外键（避免 collation 1215 坑），展示名走 map_staff_names。
_COLUMNS = (
    sa.Column("reason_code", sa.String(length=32), nullable=True),
    sa.Column("received_serial", sa.String(length=128), nullable=True),
    sa.Column("received_condition", sa.String(length=16), nullable=True),
    sa.Column("received_location_code", sa.String(length=32), nullable=True),
    sa.Column("received_media", sa.JSON(), nullable=True),
    sa.Column("received_remark", sa.String(length=255), nullable=True),
    sa.Column("abnormal_reason", sa.String(length=255), nullable=True),
    sa.Column("resolution", sa.String(length=16), nullable=True),
    sa.Column("resolved_by_id", sa.String(length=36), nullable=True),
    sa.Column("resolved_at", sa.DateTime(), nullable=True),
)


def upgrade() -> None:
    for col in _COLUMNS:
        op.add_column("return_order", col)


def downgrade() -> None:
    for col in reversed(_COLUMNS):
        op.drop_column("return_order", col.name)
