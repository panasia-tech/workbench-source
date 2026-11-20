"""大台账对账：支付宝第三方应用授权、每日账务明细、和 ERP 销售单的匹配

Revision ID: 102_ledger_alipay_bills
Revises: 101_master_ledger
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "102_ledger_alipay_bills"
down_revision: Union[str, None] = "101_master_ledger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ledger_alipay", sa.Column("auth_status", sa.String(16), nullable=False, server_default="none"))
    op.add_column("ledger_alipay", sa.Column("app_auth_token_enc", sa.Text(), nullable=True))
    op.add_column("ledger_alipay", sa.Column("app_refresh_token_enc", sa.Text(), nullable=True))
    op.add_column("ledger_alipay", sa.Column("authorized_at", sa.DateTime(), nullable=True))
    op.add_column("ledger_alipay", sa.Column("auth_expires_at", sa.DateTime(), nullable=True))
    op.add_column("ledger_alipay", sa.Column("auth_error", sa.String(255), nullable=True))

    op.create_table(
        "ledger_auth_state",
        sa.Column("state", sa.String(64), primary_key=True),
        sa.Column("alipay_id", sa.String(36), sa.ForeignKey("ledger_alipay.id"), nullable=False),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("used_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_ledger_auth_state_alipay_id", "ledger_auth_state", ["alipay_id"])

    op.create_table(
        "ledger_bill_fetch",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("alipay_id", sa.String(36), sa.ForeignKey("ledger_alipay.id"), nullable=False),
        sa.Column("bill_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("rows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("alipay_id", "bill_date", name="uq_ledger_bill_fetch"),
    )
    op.create_index("ix_ledger_bill_fetch_alipay_id", "ledger_bill_fetch", ["alipay_id"])
    op.create_index("ix_ledger_bill_fetch_bill_date", "ledger_bill_fetch", ["bill_date"])

    op.create_table(
        "ledger_bill_row",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("alipay_id", sa.String(36), sa.ForeignKey("ledger_alipay.id"), nullable=False),
        sa.Column("bill_date", sa.Date(), nullable=False),
        sa.Column("flow_no", sa.String(64), nullable=False),
        sa.Column("biz_no", sa.String(64), nullable=True),
        sa.Column("merchant_order_no", sa.String(128), nullable=True),
        sa.Column("item_name", sa.String(256), nullable=True),
        sa.Column("occurred_at", sa.DateTime(), nullable=True),
        sa.Column("counterparty", sa.String(128), nullable=True),
        sa.Column("income", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("expense", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("balance", sa.Numeric(14, 2), nullable=True),
        sa.Column("channel", sa.String(64), nullable=True),
        sa.Column("biz_type", sa.String(64), nullable=True),
        sa.Column("remark", sa.String(512), nullable=True),
        sa.Column("sale_order_id", sa.String(36), sa.ForeignKey("sale_order.id"), nullable=True),
        sa.Column("match_how", sa.String(16), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("alipay_id", "flow_no", name="uq_ledger_bill_row_flow"),
    )
    op.create_index("ix_ledger_bill_row_alipay_id", "ledger_bill_row", ["alipay_id"])
    op.create_index("ix_ledger_bill_row_bill_date", "ledger_bill_row", ["bill_date"])
    op.create_index("ix_ledger_bill_row_merchant_order_no", "ledger_bill_row", ["merchant_order_no"])
    op.create_index("ix_ledger_bill_row_sale_order_id", "ledger_bill_row", ["sale_order_id"])


def downgrade() -> None:
    op.drop_table("ledger_bill_row")
    op.drop_table("ledger_bill_fetch")
    op.drop_table("ledger_auth_state")
    for c in ("auth_error", "auth_expires_at", "authorized_at", "app_refresh_token_enc", "app_auth_token_enc", "auth_status"):
        op.drop_column("ledger_alipay", c)
