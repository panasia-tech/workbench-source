"""老板全量台账第二步：法人名下的手机卡、代理 IP、设备（AdsPower 环境 / 手机 / 电脑）、续费充值流水

设备从群控同步过来；店铺挂上跑在哪个设备上，支付宝和店铺记绑定手机号。代理账号密码不存。

Revision ID: 122_ledger_step2
Revises: 121_ledger_step1
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "122_ledger_step2"
down_revision: Union[str, None] = "121_ledger_step1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _entry() -> list:
    return [
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("needs_check", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    ]


def upgrade() -> None:
    op.add_column("ledger_legal_person", sa.Column("personal_cards", sa.JSON(), nullable=True))
    op.add_column("ledger_alipay", sa.Column("phone", sa.String(32), nullable=True))

    op.create_table(
        "ledger_sim",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("legal_person_id", sa.String(36), sa.ForeignKey("ledger_legal_person.id"), nullable=False),
        sa.Column("phone", sa.String(32), nullable=False),
        sa.Column("carrier", sa.String(16), nullable=False),
        sa.Column("category", sa.String(16), nullable=False),
        sa.Column("master_id", sa.String(36), sa.ForeignKey("ledger_sim.id"), nullable=True),
        sa.Column("billing", sa.String(16), nullable=False),
        sa.Column("plan", sa.String(128), nullable=True),
        sa.Column("monthly_rent", sa.Numeric(10, 2), nullable=True),
        sa.Column("balance", sa.Numeric(10, 2), nullable=True),
        sa.Column("balance_on", sa.Date(), nullable=True),
        sa.Column("iccid", sa.String(32), nullable=True),
        sa.Column("holder", sa.String(64), nullable=True),
        sa.Column("vendor", sa.String(128), nullable=True),
        sa.Column("contract_end", sa.Date(), nullable=True),
        sa.Column("custodian", sa.String(64), nullable=True),
        *_entry(),
    )
    op.create_index("ix_ledger_sim_legal_person_id", "ledger_sim", ["legal_person_id"])
    op.create_index("ix_ledger_sim_phone", "ledger_sim", ["phone"], unique=True)
    op.create_index("ix_ledger_sim_master_id", "ledger_sim", ["master_id"])
    op.create_index("ix_ledger_sim_status", "ledger_sim", ["status"])
    op.create_index("ix_ledger_sim_needs_check", "ledger_sim", ["needs_check"])

    op.create_table(
        "ledger_proxy",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("provider", sa.String(64), nullable=True),
        sa.Column("protocol", sa.String(8), nullable=False),
        sa.Column("host", sa.String(128), nullable=True),
        sa.Column("port", sa.Integer(), nullable=True),
        sa.Column("exit_ip", sa.String(64), nullable=True),
        sa.Column("region", sa.String(64), nullable=True),
        sa.Column("monthly_cost", sa.Numeric(10, 2), nullable=True),
        sa.Column("expires_on", sa.Date(), nullable=True),
        *_entry(),
    )
    op.create_index("ix_ledger_proxy_code", "ledger_proxy", ["code"], unique=True)
    op.create_index("ix_ledger_proxy_status", "ledger_proxy", ["status"])
    op.create_index("ix_ledger_proxy_needs_check", "ledger_proxy", ["needs_check"])

    op.create_table(
        "ledger_device",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("gc_device_id", sa.String(36), nullable=True, unique=True),
        sa.Column("ads_user_id", sa.String(32), nullable=True, unique=True),
        sa.Column("gc_nick", sa.String(64), nullable=True),
        sa.Column("last_online_at", sa.DateTime(), nullable=True),
        sa.Column("model", sa.String(64), nullable=True),
        sa.Column("serial", sa.String(64), nullable=True),
        sa.Column("imei1", sa.String(32), nullable=True),
        sa.Column("imei2", sa.String(32), nullable=True),
        sa.Column("host_id", sa.String(36), sa.ForeignKey("ledger_device.id"), nullable=True),
        sa.Column("proxy_id", sa.String(36), sa.ForeignKey("ledger_proxy.id"), nullable=True),
        sa.Column("sim1_id", sa.String(36), sa.ForeignKey("ledger_sim.id"), nullable=True),
        sa.Column("sim2_id", sa.String(36), sa.ForeignKey("ledger_sim.id"), nullable=True),
        sa.Column("custodian", sa.String(64), nullable=True),
        sa.Column("location", sa.String(64), nullable=True),
        *_entry(),
    )
    op.create_index("ix_ledger_device_serial", "ledger_device", ["serial"])
    op.create_index("ix_ledger_device_proxy_id", "ledger_device", ["proxy_id"])
    op.create_index("ix_ledger_device_status", "ledger_device", ["status"])
    op.create_index("ix_ledger_device_needs_check", "ledger_device", ["needs_check"])

    op.create_table(
        "ledger_charge",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("target_id", sa.String(36), nullable=False),
        sa.Column("amount", sa.Numeric(10, 2), nullable=True),
        sa.Column("months", sa.Integer(), nullable=True),
        sa.Column("before", sa.String(32), nullable=True),
        sa.Column("after", sa.String(32), nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_ledger_charge_target_id", "ledger_charge", ["target_id"])
    op.create_index("ix_ledger_charge_created_at", "ledger_charge", ["created_at"])

    with op.batch_alter_table("ledger_shop") as b:
        b.add_column(sa.Column("phone", sa.String(32), nullable=True))
        b.add_column(sa.Column("device_id", sa.String(36), nullable=True))
        b.create_foreign_key("fk_ledger_shop_device_id", "ledger_device", ["device_id"], ["id"])
        b.create_index("ix_ledger_shop_device_id", ["device_id"])


def downgrade() -> None:
    # MySQL：外键在用的索引删不掉，先删外键
    with op.batch_alter_table("ledger_shop") as b:
        b.drop_constraint("fk_ledger_shop_device_id", type_="foreignkey")
        b.drop_index("ix_ledger_shop_device_id")
        b.drop_column("device_id")
        b.drop_column("phone")
    op.drop_table("ledger_charge")
    op.drop_table("ledger_device")
    op.drop_table("ledger_proxy")
    op.drop_table("ledger_sim")
    op.drop_column("ledger_alipay", "phone")
    op.drop_column("ledger_legal_person", "personal_cards")
