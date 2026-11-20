"""员工匹配商品：一件货认定属于哪个 SPU（待核实/待验收/退回/通过）+ 变更日志；SPU 加配置；上架审批退回加附件；新员工教程小测成绩

Revision ID: 091_spu_match
Revises: 090_staff_dingtalk
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "091_spu_match"
down_revision: Union[str, None] = "090_staff_dingtalk"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _same_as_sku() -> dict:
    """新表的字符集/排序规则跟 sku 表一致，否则 MySQL 建外键报 3780（列不兼容，067 在旧库上踩过）。"""
    bind = op.get_bind()
    if bind.dialect.name != "mysql":
        return {}
    row = bind.execute(sa.text(
        "SELECT c.character_set_name, c.collation_name FROM information_schema.columns c "
        "WHERE c.table_schema = DATABASE() AND c.table_name = 'sku' AND c.column_name = 'id'"
    )).first()
    return {"mysql_charset": row[0], "mysql_collate": row[1]} if row and row[0] else {}


def upgrade() -> None:
    same = _same_as_sku()
    op.create_table(
        "sku_spu_match",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("spu_id", sa.String(36), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("media", sa.JSON(), nullable=True),
        sa.Column("submitted_by", sa.String(36), nullable=True),
        sa.Column("submitted_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by", sa.String(36), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("return_reason", sa.Text(), nullable=True),
        sa.Column("return_media", sa.JSON(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        **same,
    )
    op.create_index("ix_sku_spu_match_sku_id", "sku_spu_match", ["sku_id"], unique=True)
    op.create_index("ix_sku_spu_match_spu_id", "sku_spu_match", ["spu_id"])
    op.create_index("ix_sku_spu_match_status", "sku_spu_match", ["status"])
    op.create_table(
        "sku_spu_match_log",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sku_id", sa.String(36), sa.ForeignKey("sku.id"), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("from_spu_id", sa.String(36), nullable=True),
        sa.Column("to_spu_id", sa.String(36), nullable=True),
        sa.Column("from_status", sa.String(16), nullable=True),
        sa.Column("to_status", sa.String(16), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("media", sa.JSON(), nullable=True),
        sa.Column("staff_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        **same,
    )
    op.create_index("ix_sku_spu_match_log_sku_id", "sku_spu_match_log", ["sku_id"])
    op.create_table(
        "guide_quiz_result",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("staff_id", sa.String(36), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("answers", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        **same,
    )
    op.create_index("ix_guide_quiz_result_staff_id", "guide_quiz_result", ["staff_id"])
    op.add_column("warehouse_spu", sa.Column("spec", sa.String(128), nullable=True))
    op.add_column("listing_approval", sa.Column("review_media", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("listing_approval", "review_media")
    op.drop_column("warehouse_spu", "spec")
    op.drop_table("guide_quiz_result")
    op.drop_table("sku_spu_match_log")
    op.drop_table("sku_spu_match")
