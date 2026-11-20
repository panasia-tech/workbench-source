"""sales_outbound 增加 worry_free（平台手续费档位：自提0/普通1.6%/无忧2.6%）

worry_free 三态：NULL=未标记(历史/闲管家自动同步，沿用无忧 2.6% 现状)、False=普通(1.6%)、
True=无忧卖(2.6%)。自提走 outbound_type==PICKUP 恒 0%，不看此字段。NULL 默认保持现状，
故无需回填。

Revision ID: 041_outbound_worry_free
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "041_outbound_worry_free"
down_revision: Union[str, None] = "040_express_recall"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sales_outbound", sa.Column("worry_free", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("sales_outbound", "worry_free")
