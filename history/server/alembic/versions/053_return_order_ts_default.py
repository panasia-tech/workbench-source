"""return_order 补 created_at/updated_at 默认值

019 建表漏了 server_default，严格模式(STRICT_TRANS_TABLES)下 ORM 省略该列
INSERT 直接 1364，退货单创建接口自建表以来从未成功写入过。

DB 默认值只是兜底：本服务器 MySQL 时区是 CST，CURRENT_TIMESTAMP 是北京时间，
而 return_order 的展示(CNDatetime)和财务筛选(cn_range_to_utc)都按 naive UTC 口径，
所以应用层由模型显式写 datetime.utcnow（见 models/sales.py ReturnOrder）。

Revision ID: 053_return_order_ts_default
"""
from typing import Sequence, Union

from alembic import op

revision: str = "053_return_order_ts_default"
down_revision: Union[str, None] = "052_return_check_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE return_order "
        "MODIFY created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )
    op.execute(
        "ALTER TABLE return_order "
        "MODIFY updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE return_order MODIFY created_at datetime NOT NULL")
    op.execute("ALTER TABLE return_order MODIFY updated_at datetime NOT NULL")
