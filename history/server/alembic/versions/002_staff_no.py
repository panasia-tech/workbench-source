"""add staff_no

Revision ID: 002_staff_no
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "002_staff_no"
down_revision: Union[str, None] = "001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("staff", sa.Column("staff_no", sa.String(16), nullable=True))
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id FROM staff ORDER BY created_at ASC")).fetchall()
    for i, (staff_id,) in enumerate(rows, 1):
        conn.execute(
            sa.text("UPDATE staff SET staff_no = :no WHERE id = :id"),
            {"no": f"E{i:03d}", "id": staff_id},
        )
    op.alter_column("staff", "staff_no", existing_type=sa.String(16), nullable=False)
    op.create_index("ix_staff_staff_no", "staff", ["staff_no"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_staff_staff_no", table_name="staff")
    op.drop_column("staff", "staff_no")
