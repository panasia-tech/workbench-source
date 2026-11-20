"""warehouse_tag.prompt for AI redraw

Revision ID: 022_warehouse_tag_prompt
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "022_warehouse_tag_prompt"
down_revision: Union[str, None] = "021_warehouse_tag"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("warehouse_tag", sa.Column("prompt", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("warehouse_tag", "prompt")
