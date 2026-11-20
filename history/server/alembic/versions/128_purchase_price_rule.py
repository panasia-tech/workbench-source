"""采购工作台 W06：公司内部采购价格表（首报 / 目标 / 最高分栏、按版本）；采购单锁下单时那一版

Revision ID: 128_purchase_price_rule
Revises: 127_purchase_snapshot_media
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "128_purchase_price_rule"
down_revision: Union[str, None] = "127_purchase_snapshot_media"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "purchase_price_rule",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("rule_key", sa.String(255), nullable=False),
        sa.Column("brand", sa.String(64), nullable=False),
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column("spec", sa.String(128), nullable=True),
        sa.Column("accessory", sa.String(32), nullable=False),
        sa.Column("first_offer", sa.Numeric(12, 2), nullable=True),
        sa.Column("target", sa.Numeric(12, 2), nullable=True),
        sa.Column("ceiling", sa.Numeric(12, 2), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("effective_from", sa.DateTime(), nullable=False),
        sa.Column("superseded_at", sa.DateTime(), nullable=True),
        sa.Column("source", sa.String(128), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_purchase_price_rule_rule_key", "purchase_price_rule", ["rule_key"])
    op.create_index("ix_purchase_price_rule_superseded_at", "purchase_price_rule", ["superseded_at"])
    with op.batch_alter_table("purchase_order") as b:
        b.add_column(sa.Column("price_rule_id", sa.String(36), nullable=True))
        b.create_foreign_key("fk_purchase_order_price_rule_id", "purchase_price_rule", ["price_rule_id"], ["id"])


def downgrade() -> None:
    with op.batch_alter_table("purchase_order") as b:
        b.drop_constraint("fk_purchase_order_price_rule_id", type_="foreignkey")
        b.drop_column("price_rule_id")
    op.drop_table("purchase_price_rule")
