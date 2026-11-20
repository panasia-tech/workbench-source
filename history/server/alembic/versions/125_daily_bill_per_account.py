"""每日账单按「户 + 日期」唯一：原来按日期全局唯一，一天只传得了一个户的账单（审计报告第 10 条）

alipay_id 是台账里的支付宝（ledger_alipay.id），空串 = ERP 自提收款那个支付宝，老数据都算它的。

Revision ID: 125_daily_bill_per_account
Revises: 124_ledger_step4
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "125_daily_bill_per_account"
down_revision: Union[str, None] = "124_ledger_step4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("daily_bill", sa.Column("alipay_id", sa.String(36), nullable=False, server_default=""))
    op.drop_constraint("uq_daily_bill_date", "daily_bill", type_="unique")
    op.create_unique_constraint("uq_daily_bill_account_date", "daily_bill", ["alipay_id", "bill_date"])


def downgrade() -> None:
    # 回退前同一天要是已经有了别的户的账单，建回全局唯一会失败：先删掉 alipay_id 不为空的那些
    op.drop_constraint("uq_daily_bill_account_date", "daily_bill", type_="unique")
    op.create_unique_constraint("uq_daily_bill_date", "daily_bill", ["bill_date"])
    op.drop_column("daily_bill", "alipay_id")
