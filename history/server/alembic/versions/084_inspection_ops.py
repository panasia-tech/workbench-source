"""验货规范、逐项全检、开箱凭证、异常跟踪、出库复核

见 app/models/inspection_ops.py。只加新表，现有验货、出库流程要在页面上打开开关才受影响。

Revision ID: 084_inspection_ops
Revises: 083_app_setting
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "084_inspection_ops"
down_revision: Union[str, None] = "083_app_setting"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "inspection_template",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False, index=True),
        sa.Column("brand", sa.String(length=128), nullable=True),
        sa.Column("model", sa.String(length=128), nullable=True),
        sa.Column("keywords", sa.JSON(), nullable=False),
        sa.Column("steps", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "inspection_check_item",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("inspection_id", sa.String(length=36), sa.ForeignKey("inspection.id"), nullable=False, index=True),
        sa.Column("template_id", sa.String(length=36), nullable=True),
        sa.Column("template_version", sa.Integer(), nullable=True),
        sa.Column("item_key", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=128), nullable=False),
        sa.Column("guide", sa.Text(), nullable=True),
        sa.Column("need_photo", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("result", sa.String(length=16), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("operator_id", sa.String(length=36), nullable=True),
        sa.Column("checked_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("inspection_id", "item_key", name="uq_inspection_check_item"),
    )
    op.create_table(
        "inspection_evidence",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("inspection_id", sa.String(length=36), sa.ForeignKey("inspection.id"), nullable=False, index=True),
        sa.Column("purchase_order_id", sa.String(length=36), nullable=False, index=True),
        sa.Column("sku_id", sa.String(length=36), nullable=True, index=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("url", sa.String(length=512), nullable=False),
        sa.Column("item_key", sa.String(length=64), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("device_label", sa.String(length=128), nullable=True),
        sa.Column("recorded_by", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "inspection_exception",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("inspection_id", sa.String(length=36), sa.ForeignKey("inspection.id"), nullable=False, index=True),
        sa.Column("purchase_order_id", sa.String(length=36), nullable=False, index=True),
        sa.Column("exception_type", sa.String(length=16), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, index=True),
        sa.Column("raised_by", sa.String(length=36), nullable=False),
        sa.Column("raised_at", sa.DateTime(), nullable=False),
        sa.Column("handler_id", sa.String(length=36), nullable=True),
        sa.Column("purchaser_id", sa.String(length=36), nullable=True),
        sa.Column("due_at", sa.DateTime(), nullable=False, index=True),
        sa.Column("handler_ack_at", sa.DateTime(), nullable=True),
        sa.Column("purchaser_evidence_at", sa.DateTime(), nullable=True),
        sa.Column("purchaser_evidence", sa.JSON(), nullable=False),
        sa.Column("escalated_at", sa.DateTime(), nullable=True),
        sa.Column("reject_status", sa.String(length=16), nullable=False),
        sa.Column("return_tracking_no", sa.String(length=64), nullable=True),
        sa.Column("refund_status", sa.String(length=16), nullable=False),
        sa.Column("refund_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("final_result", sa.Text(), nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "inspection_exception_event",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("exception_id", sa.String(length=36), sa.ForeignKey("inspection_exception.id"), nullable=False, index=True),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("target_staff_id", sa.String(length=36), nullable=True, index=True),
        sa.Column("operator_id", sa.String(length=36), nullable=True),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("read_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "outbound_review",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("sku_id", sa.String(length=36), sa.ForeignKey("sku.id"), nullable=False, index=True),
        sa.Column("reviewer_id", sa.String(length=36), nullable=False),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.Column("outbound_id", sa.String(length=36), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("outbound_review")
    op.drop_table("inspection_exception_event")
    op.drop_table("inspection_exception")
    op.drop_table("inspection_evidence")
    op.drop_table("inspection_check_item")
    op.drop_table("inspection_template")
