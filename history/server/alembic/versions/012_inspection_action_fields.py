"""inspection action fields

Revision ID: 012_inspection_action_fields
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "012_inspection_action_fields"
down_revision: Union[str, None] = "011_purchase_product_images"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("inspection", sa.Column("action_type", sa.String(32), nullable=True))
    op.add_column("inspection", sa.Column("inspection_result", sa.String(32), nullable=True))
    op.add_column("inspection", sa.Column("defect_videos", sa.JSON(), nullable=True))
    op.add_column("inspection", sa.Column("reject_images", sa.JSON(), nullable=True))
    op.add_column("inspection", sa.Column("mismatch_remark", sa.Text(), nullable=True))
    op.add_column("inspection", sa.Column("actual_amount", sa.Numeric(12, 2), nullable=True))
    op.execute("UPDATE inspection SET defect_videos = '[]' WHERE defect_videos IS NULL")
    op.execute("UPDATE inspection SET reject_images = '[]' WHERE reject_images IS NULL")


def downgrade() -> None:
    op.drop_column("inspection", "actual_amount")
    op.drop_column("inspection", "mismatch_remark")
    op.drop_column("inspection", "reject_images")
    op.drop_column("inspection", "defect_videos")
    op.drop_column("inspection", "inspection_result")
    op.drop_column("inspection", "action_type")
