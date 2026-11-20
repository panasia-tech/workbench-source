"""密码库填进 AdsPower：工位（装巡航台的电脑）登记公钥、主人批准；条目记填到哪个网站和同步的领取状态

ledger_vault_station 一台电脑一行（id = workbench_device.id），public_key 是 X25519 公钥；ledger_vault 加
ads_domain（AdsPower 自动填的网站）、ads_job_at（什么时候要求填）、ads_station_id / ads_claim_until（哪台在填、
领到什么时候）、ads_ack_hash（回执的哈希，只有解开密文才拿得到回执）。

Revision ID: 132_vault_ads_sync
Revises: 131_ledger_step5
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "132_vault_ads_sync"
down_revision: Union[str, None] = "131_ledger_step5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ledger_vault_station",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("public_key", sa.String(64), nullable=False),
        sa.Column("fingerprint", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, index=True),
        sa.Column("registered_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("approved_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.add_column("ledger_vault", sa.Column("ads_domain", sa.String(128), nullable=True))
    op.add_column("ledger_vault", sa.Column("ads_job_at", sa.DateTime(), nullable=True))
    op.add_column("ledger_vault", sa.Column("ads_station_id", sa.String(64), nullable=True))
    op.add_column("ledger_vault", sa.Column("ads_claim_until", sa.DateTime(), nullable=True))
    op.add_column("ledger_vault", sa.Column("ads_ack_hash", sa.String(64), nullable=True))
    op.create_index("ix_ledger_vault_ads_status", "ledger_vault", ["ads_status"])


def downgrade() -> None:
    op.drop_index("ix_ledger_vault_ads_status", table_name="ledger_vault")
    for c in ("ads_ack_hash", "ads_claim_until", "ads_station_id", "ads_job_at", "ads_domain"):
        op.drop_column("ledger_vault", c)
    op.drop_table("ledger_vault_station")
