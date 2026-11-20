"""检查项不通过时的瑕疵部位、卖家原描述（给采购议价对比）

Revision ID: 097_check_item_defect_detail
Revises: 096_evidence_recording_gap
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "097_check_item_defect_detail"
down_revision: Union[str, None] = "096_evidence_recording_gap"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("inspection_check_item", sa.Column("defect_part", sa.String(64), nullable=True))
    op.add_column("inspection_check_item", sa.Column("seller_claim", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("inspection_check_item", "seller_claim")
    op.drop_column("inspection_check_item", "defect_part")
