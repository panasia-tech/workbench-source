"""拒签退回物流（承运方、网点、在途/异常/签收、签收凭证）与退款核对（扣费、差额原因）

Revision ID: 095_exception_return_refund
Revises: 094_outbound_review_result
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "095_exception_return_refund"
down_revision: Union[str, None] = "094_outbound_review_result"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = [
    ("return_carrier", sa.String(32)),
    ("return_station", sa.String(128)),
    ("return_logistics", sa.String(16)),
    ("return_sign_evidence", sa.JSON()),
    ("refund_fee", sa.Numeric(12, 2)),
    ("refund_shortfall_reason", sa.Text()),
]


def upgrade() -> None:
    for name, type_ in COLUMNS:
        op.add_column("inspection_exception", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _ in reversed(COLUMNS):
        op.drop_column("inspection_exception", name)
