"""order archive batch tables

Revision ID: 006_order_archive
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "006_order_archive"
down_revision: Union[str, None] = "005_business_extension"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "archive_batch",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("batch_no", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("order_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("file_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("package_url", sa.String(512), nullable=True),
        sa.Column("package_object_key", sa.String(512), nullable=True),
        sa.Column("fc_request_id", sa.String(128), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("packed_at", sa.DateTime(), nullable=True),
        sa.Column("oss_deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("batch_no"),
    )
    op.create_index("ix_archive_batch_status", "archive_batch", ["status"])

    op.create_table(
        "archive_order",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("batch_id", sa.String(36), sa.ForeignKey("archive_batch.id"), nullable=False),
        sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_order.id"), nullable=False),
        sa.Column("order_no", sa.String(32), nullable=False),
        sa.Column("file_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("object_keys", sa.JSON(), nullable=False),
        sa.Column("media_bindings", sa.JSON(), nullable=False),
        sa.Column("oss_deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_archive_order_batch_id", "archive_order", ["batch_id"])
    op.create_index("ix_archive_order_purchase_order_id", "archive_order", ["purchase_order_id"])


def downgrade() -> None:
    op.drop_table("archive_order")
    op.drop_table("archive_batch")
