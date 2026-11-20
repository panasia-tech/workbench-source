"""pickup_payment.qr_code 放宽为 Text（手机网站支付模式下存的是带签名的长 URL）

当面付 precreate 返回的 qr_code 只有几十字符，String(512) 够用；
手机网站支付把整个签名请求拼成 GET URL，含 base64 签名后普遍 800~1200 字符，会溢出。

Revision ID: 065_pickup_payment_qr_text
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "065_pickup_payment_qr_text"
down_revision: Union[str, None] = "064_gc_account_profile"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "pickup_payment",
        "qr_code",
        existing_type=sa.String(512),
        type_=sa.Text(),
        existing_nullable=True,
    )


def downgrade() -> None:
    # 回退前需确认没有超过 512 字符的历史行，否则会截断
    op.alter_column(
        "pickup_payment",
        "qr_code",
        existing_type=sa.Text(),
        type_=sa.String(512),
        existing_nullable=True,
    )
