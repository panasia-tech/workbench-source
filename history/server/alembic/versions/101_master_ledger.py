"""大台账：法人 → 主体 → 支付宝 → 店铺，临时开放与查看记录

Revision ID: 101_master_ledger
Revises: 100_auto_listing_hold_publish
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "101_master_ledger"
down_revision: Union[str, None] = "100_auto_listing_hold_publish"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _entry_cols():
    return [
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("needs_check", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    ]


def _entry_indexes(table: str) -> None:
    op.create_index(f"ix_{table}_status", table, ["status"])
    op.create_index(f"ix_{table}_needs_check", table, ["needs_check"])


def upgrade() -> None:
    op.create_table(
        "ledger_legal_person",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("phone", sa.String(32), nullable=True),
        sa.Column("email", sa.String(128), nullable=True),
        *_entry_cols(),
    )
    op.create_index("ix_ledger_legal_person_name", "ledger_legal_person", ["name"])
    _entry_indexes("ledger_legal_person")

    op.create_table(
        "ledger_entity",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("legal_person_id", sa.String(36), sa.ForeignKey("ledger_legal_person.id"), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("entity_type", sa.String(16), nullable=False, server_default="individual"),
        sa.Column("credit_code", sa.String(32), nullable=True),
        *_entry_cols(),
    )
    op.create_index("ix_ledger_entity_legal_person_id", "ledger_entity", ["legal_person_id"])
    op.create_index("ix_ledger_entity_name", "ledger_entity", ["name"])
    op.create_index("ix_ledger_entity_credit_code", "ledger_entity", ["credit_code"])
    _entry_indexes("ledger_entity")

    op.create_table(
        "ledger_alipay",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("entity_id", sa.String(36), sa.ForeignKey("ledger_entity.id"), nullable=False),
        sa.Column("account", sa.String(128), nullable=False),
        sa.Column("alias", sa.String(64), nullable=True),
        sa.Column("alipay_user_id", sa.String(32), nullable=True),
        *_entry_cols(),
    )
    op.create_index("ix_ledger_alipay_entity_id", "ledger_alipay", ["entity_id"])
    op.create_index("ix_ledger_alipay_account", "ledger_alipay", ["account"])
    _entry_indexes("ledger_alipay")

    op.create_table(
        "ledger_shop",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("alipay_id", sa.String(36), sa.ForeignKey("ledger_alipay.id"), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False, server_default="xianyu"),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("sale_shop_id", sa.String(36), sa.ForeignKey("sale_shop.id"), nullable=True),
        *_entry_cols(),
    )
    op.create_index("ix_ledger_shop_alipay_id", "ledger_shop", ["alipay_id"])
    op.create_index("ix_ledger_shop_name", "ledger_shop", ["name"])
    op.create_index("ix_ledger_shop_sale_shop_id", "ledger_shop", ["sale_shop_id"])
    _entry_indexes("ledger_shop")

    op.create_table(
        "ledger_grant",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("legal_person_id", sa.String(36), sa.ForeignKey("ledger_legal_person.id"), nullable=False),
        sa.Column("reason", sa.String(255), nullable=True),
        sa.Column("granted_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("opened_at", sa.DateTime(), nullable=True),
        sa.Column("read_until", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_ledger_grant_staff_id", "ledger_grant", ["staff_id"])
    op.create_index("ix_ledger_grant_legal_person_id", "ledger_grant", ["legal_person_id"])

    op.create_table(
        "ledger_access_log",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("target_type", sa.String(16), nullable=False),
        sa.Column("target_id", sa.String(36), nullable=True),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_ledger_access_log_staff_id", "ledger_access_log", ["staff_id"])
    op.create_index("ix_ledger_access_log_action", "ledger_access_log", ["action"])
    op.create_index("ix_ledger_access_log_target_id", "ledger_access_log", ["target_id"])
    op.create_index("ix_ledger_access_log_created_at", "ledger_access_log", ["created_at"])


def downgrade() -> None:
    for t in ("ledger_access_log", "ledger_grant", "ledger_shop", "ledger_alipay", "ledger_entity", "ledger_legal_person"):
        op.drop_table(t)
