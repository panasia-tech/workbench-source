"""老板全量台账第一步：主体的税务、年报；支付宝角色和因公付；店铺挂主体、结算方式、服务费率、保证金；账单流水分类

不走支付宝结算的店铺（微信小店、抖店……）直接挂在主体下面：ledger_shop 加 entity_id（按原来挂的支付宝回填），
alipay_id 改成可空。密码一律不存。

Revision ID: 121_ledger_step1
Revises: 120_outbound_platform_fee
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "121_ledger_step1"
down_revision: Union[str, None] = "120_outbound_platform_fee"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ledger_entity", sa.Column("tax_payer", sa.String(16), nullable=False, server_default="small"))
    op.add_column("ledger_entity", sa.Column("tax_levy", sa.String(16), nullable=False, server_default="audit"))
    op.add_column("ledger_entity", sa.Column("tax_office", sa.String(128), nullable=True))
    op.add_column("ledger_entity", sa.Column("tax_phone", sa.String(32), nullable=True))
    op.add_column("ledger_entity", sa.Column("liaison_phone", sa.String(32), nullable=True))
    op.add_column("ledger_entity", sa.Column("registered_on", sa.Date(), nullable=True))
    op.add_column("ledger_entity", sa.Column("report_year", sa.Integer(), nullable=True))
    op.add_column("ledger_entity", sa.Column("report_filed_on", sa.Date(), nullable=True))

    op.add_column("ledger_alipay", sa.Column("role", sa.String(16), nullable=False, server_default="sales"))
    op.add_column("ledger_alipay", sa.Column("corporate_pay", sa.Boolean(), nullable=False, server_default="0"))

    op.add_column("ledger_shop", sa.Column("entity_id", sa.String(36), nullable=True))
    op.execute(
        "UPDATE ledger_shop s JOIN ledger_alipay a ON a.id = s.alipay_id SET s.entity_id = a.entity_id"
        if op.get_bind().dialect.name == "mysql" else
        "UPDATE ledger_shop SET entity_id = (SELECT entity_id FROM ledger_alipay a WHERE a.id = ledger_shop.alipay_id)"
    )
    op.alter_column("ledger_shop", "entity_id", existing_type=sa.String(36), nullable=False)
    op.create_foreign_key("fk_ledger_shop_entity_id", "ledger_shop", "ledger_entity", ["entity_id"], ["id"])
    op.create_index("ix_ledger_shop_entity_id", "ledger_shop", ["entity_id"])
    op.alter_column("ledger_shop", "alipay_id", existing_type=sa.String(36), nullable=True)
    op.add_column("ledger_shop", sa.Column("channel", sa.String(16), nullable=False, server_default="alipay"))
    op.add_column("ledger_shop", sa.Column("merchant_no", sa.String(64), nullable=True))
    op.add_column("ledger_shop", sa.Column("fee_rate", sa.Numeric(5, 2), nullable=True))
    op.add_column("ledger_shop", sa.Column("deposit", sa.Numeric(12, 2), nullable=True))
    op.add_column("ledger_shop", sa.Column("deposit_from", sa.String(128), nullable=True))

    op.add_column("ledger_bill_row", sa.Column("flow", sa.String(24), nullable=True))
    op.add_column("ledger_bill_row", sa.Column("flow_manual", sa.Boolean(), nullable=False, server_default="0"))
    op.create_index("ix_ledger_bill_row_flow", "ledger_bill_row", ["flow"])


def downgrade() -> None:
    op.drop_index("ix_ledger_bill_row_flow", table_name="ledger_bill_row")
    op.drop_column("ledger_bill_row", "flow_manual")
    op.drop_column("ledger_bill_row", "flow")
    for c in ("deposit_from", "deposit", "fee_rate", "merchant_no", "channel"):
        op.drop_column("ledger_shop", c)
    # 不走支付宝的店铺回不到「必须挂支付宝」，降级前先删掉它们
    op.execute("DELETE FROM ledger_shop WHERE alipay_id IS NULL")
    op.alter_column("ledger_shop", "alipay_id", existing_type=sa.String(36), nullable=False)
    # MySQL 不让删外键还在用的索引：先删外键
    op.drop_constraint("fk_ledger_shop_entity_id", "ledger_shop", type_="foreignkey")
    op.drop_index("ix_ledger_shop_entity_id", table_name="ledger_shop")
    op.drop_column("ledger_shop", "entity_id")
    op.drop_column("ledger_alipay", "corporate_pay")
    op.drop_column("ledger_alipay", "role")
    for c in ("report_filed_on", "report_year", "registered_on", "liaison_phone", "tax_phone", "tax_office", "tax_levy", "tax_payer"):
        op.drop_column("ledger_entity", c)
