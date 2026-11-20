"""老板全量台账第三步：店铺分销售店 / 采购号 / 引流号；支付宝限额和财务科目；店铺冻结款、开票口径、财务科目；
法人代持协议到期日、刷脸响应时效；主体经营范围

Revision ID: 123_ledger_step3
Revises: 122_ledger_step2
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "123_ledger_step3"
down_revision: Union[str, None] = "122_ledger_step2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ledger_legal_person", sa.Column("face_sla", sa.String(64), nullable=True))
    op.add_column("ledger_legal_person", sa.Column("agreement_end", sa.Date(), nullable=True))
    op.add_column("ledger_entity", sa.Column("business_scope", sa.Text(), nullable=True))
    op.add_column("ledger_alipay", sa.Column("daily_limit", sa.Numeric(14, 2), nullable=True))
    op.add_column("ledger_alipay", sa.Column("single_limit", sa.Numeric(14, 2), nullable=True))
    op.add_column("ledger_alipay", sa.Column("frozen_reserve", sa.Numeric(14, 2), nullable=True))
    op.add_column("ledger_alipay", sa.Column("book_code", sa.String(64), nullable=True))
    with op.batch_alter_table("ledger_shop") as b:
        b.add_column(sa.Column("role", sa.String(16), nullable=False, server_default="sales"))
        b.add_column(sa.Column("lead_shop_id", sa.String(36), nullable=True))
        b.add_column(sa.Column("frozen", sa.Numeric(12, 2), nullable=True))
        b.add_column(sa.Column("invoice_mode", sa.String(16), nullable=True))
        b.add_column(sa.Column("book_code", sa.String(64), nullable=True))
        b.create_foreign_key("fk_ledger_shop_lead_shop_id", "ledger_shop", ["lead_shop_id"], ["id"])


def downgrade() -> None:
    with op.batch_alter_table("ledger_shop") as b:
        b.drop_constraint("fk_ledger_shop_lead_shop_id", type_="foreignkey")
        b.drop_column("book_code")
        b.drop_column("invoice_mode")
        b.drop_column("frozen")
        b.drop_column("lead_shop_id")
        b.drop_column("role")
    for c in ("book_code", "frozen_reserve", "single_limit", "daily_limit"):
        op.drop_column("ledger_alipay", c)
    op.drop_column("ledger_entity", "business_scope")
    op.drop_column("ledger_legal_person", "agreement_end")
    op.drop_column("ledger_legal_person", "face_sla")
