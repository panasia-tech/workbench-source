"""lawsuit 增加 evidence_media（证据优先）+ 协作留痕字段

Revision ID: 044_lawsuit_evidence_media
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "044_lawsuit_evidence_media"
down_revision: Union[str, None] = "043_asset_enhance_phone"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("lawsuit", sa.Column("evidence_media", sa.JSON(), nullable=True))
    op.add_column("lawsuit", sa.Column("last_action_by_id", sa.String(length=36), nullable=True))
    op.add_column("lawsuit", sa.Column("last_action_at", sa.DateTime(), nullable=True))
    op.create_index("ix_lawsuit_last_action_by_id", "lawsuit", ["last_action_by_id"])


def downgrade() -> None:
    op.drop_index("ix_lawsuit_last_action_by_id", table_name="lawsuit")
    op.drop_column("lawsuit", "last_action_at")
    op.drop_column("lawsuit", "last_action_by_id")
    op.drop_column("lawsuit", "evidence_media")
