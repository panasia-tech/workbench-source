"""老板全量台账第四步：审计报告里另外 12 个模块——通用台账条目、条目流水、谁知道哪些密码；员工实名卡、
支付宝转账证书、主体开票额度、店铺币种

Revision ID: 124_ledger_step4
Revises: 123_ledger_step3
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "124_ledger_step4"
down_revision: Union[str, None] = "123_ledger_step3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ledger_record",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("entity_id", sa.String(36), sa.ForeignKey("ledger_entity.id"), nullable=True),
        sa.Column("legal_person_id", sa.String(36), sa.ForeignKey("ledger_legal_person.id"), nullable=True),
        sa.Column("parent_id", sa.String(36), sa.ForeignKey("ledger_record.id"), nullable=True),
        sa.Column("attrs", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("needs_check", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_ledger_record_kind", "ledger_record", ["kind"])
    op.create_index("ix_ledger_record_entity_id", "ledger_record", ["entity_id"])
    op.create_index("ix_ledger_record_legal_person_id", "ledger_record", ["legal_person_id"])
    op.create_index("ix_ledger_record_parent_id", "ledger_record", ["parent_id"])
    op.create_index("ix_ledger_record_status", "ledger_record", ["status"])
    op.create_index("ix_ledger_record_needs_check", "ledger_record", ["needs_check"])

    op.create_table(
        "ledger_record_event",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("record_id", sa.String(36), sa.ForeignKey("ledger_record.id"), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("data", sa.JSON(), nullable=True),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_ledger_record_event_record_id", "ledger_record_event", ["record_id"])
    op.create_index("ix_ledger_record_event_created_at", "ledger_record_event", ["created_at"])

    op.create_table(
        "ledger_knows",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("target_type", sa.String(16), nullable=False),
        sa.Column("target_id", sa.String(36), nullable=False),
        sa.Column("what", sa.String(16), nullable=False),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("target_type", "target_id", "what", "staff_id", name="uq_ledger_knows"),
    )
    op.create_index("ix_ledger_knows_target_id", "ledger_knows", ["target_id"])
    op.create_index("ix_ledger_knows_staff_id", "ledger_knows", ["staff_id"])

    with op.batch_alter_table("ledger_sim") as b:
        b.add_column(sa.Column("staff_id", sa.String(36), nullable=True))
        b.create_foreign_key("fk_ledger_sim_staff_id", "staff", ["staff_id"], ["id"])
    op.add_column("ledger_alipay", sa.Column("cert_expires_on", sa.Date(), nullable=True))
    op.add_column("ledger_alipay", sa.Column("transfer_scene", sa.String(64), nullable=True))
    op.add_column("ledger_entity", sa.Column("invoice_quota", sa.Numeric(14, 2), nullable=True))
    op.add_column("ledger_shop", sa.Column("currency", sa.String(8), nullable=False, server_default="CNY"))


def downgrade() -> None:
    op.drop_column("ledger_shop", "currency")
    op.drop_column("ledger_entity", "invoice_quota")
    op.drop_column("ledger_alipay", "transfer_scene")
    op.drop_column("ledger_alipay", "cert_expires_on")
    # MySQL：外键在用的索引删不掉，先删外键
    with op.batch_alter_table("ledger_sim") as b:
        b.drop_constraint("fk_ledger_sim_staff_id", type_="foreignkey")
        b.drop_column("staff_id")
    op.drop_table("ledger_knows")
    op.drop_table("ledger_record_event")
    op.drop_table("ledger_record")
