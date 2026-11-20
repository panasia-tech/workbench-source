"""验货检查项改答案、补测留痕（inspection_check_item_log）

Revision ID: 092_inspection_item_log
Revises: 091_spu_match
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "092_inspection_item_log"
down_revision: Union[str, None] = "091_spu_match"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _same_as_inspection() -> dict:
    """字符集/排序规则跟 inspection 表一致，否则 MySQL 建外键报 3780。"""
    bind = op.get_bind()
    if bind.dialect.name != "mysql":
        return {}
    row = bind.execute(sa.text(
        "SELECT character_set_name, collation_name FROM information_schema.columns "
        "WHERE table_schema = DATABASE() AND table_name = 'inspection' AND column_name = 'id'"
    )).first()
    return {"mysql_charset": row[0], "mysql_collate": row[1]} if row and row[0] else {}


def upgrade() -> None:
    op.create_table(
        "inspection_check_item_log",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("inspection_id", sa.String(36), sa.ForeignKey("inspection.id"), nullable=False),
        sa.Column("item_key", sa.String(64), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("old_result", sa.String(16), nullable=True),
        sa.Column("new_result", sa.String(16), nullable=True),
        sa.Column("old_note", sa.Text(), nullable=True),
        sa.Column("new_note", sa.Text(), nullable=True),
        sa.Column("old_evidence", sa.JSON(), nullable=True),
        sa.Column("operator_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        **_same_as_inspection(),
    )
    op.create_index("ix_inspection_check_item_log_inspection_id", "inspection_check_item_log", ["inspection_id"])


def downgrade() -> None:
    op.drop_table("inspection_check_item_log")
