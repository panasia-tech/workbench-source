"""台账第五步（V2 交付包）：看缺口的目标数、开店教程与进度、密码库

ledger_target 每个法人一份目标数；ledger_tutorial 教程（整棵树存 body）；ledger_case / ledger_case_step / ledger_case_skip
开店进度、一步一交（只增）、跳步申请；ledger_vault 密码库（信封加密），ledger_vault_factor 主人的手机验证器，
ledger_vault_session 解锁后的 15 分钟。台账各层的 status 多了 building（开店中），是字符串列，不用改表。

Revision ID: 131_ledger_step5
Revises: 130_purchase_aftersale
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "131_ledger_step5"
down_revision: Union[str, None] = "130_purchase_aftersale"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts():
    return [sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now())]


def upgrade() -> None:
    op.create_table(
        "ledger_target",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("legal_person_id", sa.String(36), sa.ForeignKey("ledger_legal_person.id"), nullable=False, unique=True),
        sa.Column("targets", sa.JSON(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("updated_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts(),
    )
    op.create_table(
        "ledger_tutorial",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False, index=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("platform", sa.String(16), nullable=True),
        sa.Column("title", sa.String(128), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("body", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, index=True),
        sa.Column("author_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("reviewed_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        *_ts(),
        sa.UniqueConstraint("code", "version", name="uq_ledger_tutorial_version"),
    )
    op.create_table(
        "ledger_case",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("tutorial_id", sa.String(36), sa.ForeignKey("ledger_tutorial.id"), nullable=False, index=True),
        sa.Column("target_type", sa.String(16), nullable=False),
        sa.Column("target_id", sa.String(36), nullable=True, index=True),
        sa.Column("legal_person_id", sa.String(36), nullable=True, index=True),
        sa.Column("link_case_id", sa.String(36), sa.ForeignKey("ledger_case.id"), nullable=True, index=True),
        sa.Column("title", sa.String(128), nullable=False),
        sa.Column("assignee_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False, index=True),
        sa.Column("status", sa.String(16), nullable=False, index=True),
        sa.Column("due_on", sa.Date(), nullable=True),
        sa.Column("done_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        *_ts(),
    )
    op.create_table(
        "ledger_case_step",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("case_id", sa.String(36), sa.ForeignKey("ledger_case.id"), nullable=False, index=True),
        sa.Column("step_code", sa.String(16), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("materials", sa.JSON(), nullable=True),
        sa.Column("confirmed", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("submitted_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("submitted_at", sa.DateTime(), nullable=False),
        sa.Column("reviewed_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.UniqueConstraint("case_id", "step_code", "version_no", name="uq_ledger_case_step"),
    )
    op.create_table(
        "ledger_case_skip",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("case_id", sa.String(36), sa.ForeignKey("ledger_case.id"), nullable=False, index=True),
        sa.Column("step_code", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("requested_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, index=True),
        sa.Column("decided_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("decide_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "ledger_vault",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("category", sa.String(16), nullable=False, index=True),
        sa.Column("title", sa.String(128), nullable=False),
        sa.Column("target_type", sa.String(16), nullable=True),
        sa.Column("target_id", sa.String(36), nullable=True, index=True),
        sa.Column("login_name", sa.String(128), nullable=True),
        sa.Column("secret", sa.Text(), nullable=True),
        sa.Column("has_password", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("has_secondary", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("has_totp", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("assignee_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True, index=True),
        sa.Column("employee_totp", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("ledger_device.id"), nullable=True),
        sa.Column("ads_status", sa.String(16), nullable=False, server_default="none"),
        sa.Column("ads_synced_at", sa.DateTime(), nullable=True),
        sa.Column("ads_error", sa.String(255), nullable=True),
        sa.Column("rotated_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        *_ts(),
    )
    op.create_table(
        "ledger_vault_factor",
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), primary_key=True),
        sa.Column("totp_enc", sa.Text(), nullable=True),
        sa.Column("pending_enc", sa.Text(), nullable=True),
        sa.Column("last_step", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("fails", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("locked_until", sa.DateTime(), nullable=True),
        *_ts(),
    )
    op.create_table(
        "ledger_vault_session",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("staff_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=False, index=True),
        sa.Column("ip", sa.String(64), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    # 密码库的密文删了就没了：回退前先确认不要了（或先备份这几张表）
    for t in ("ledger_vault_session", "ledger_vault_factor", "ledger_vault", "ledger_case_skip", "ledger_case_step",
              "ledger_case", "ledger_tutorial", "ledger_target"):
        op.drop_table(t)
