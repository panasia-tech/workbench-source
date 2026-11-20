"""采购议价必要问题待核（PC-090）

Revision ID: 113_bargain_necessary_checks
Revises: 112_bargain_session
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "113_bargain_necessary_checks"
down_revision: Union[str, None] = "112_bargain_session"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("bargain_session", sa.Column("checks", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("bargain_session", "checks")
