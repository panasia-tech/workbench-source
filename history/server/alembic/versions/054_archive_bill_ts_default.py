"""archive_batch / daily_bill 补 created_at/updated_at 默认值

与 053(return_order) 同款问题的全库排查结果：这两张表建表时也漏了
server_default，模型走 TimestampMixin 不传值，严格模式下 INSERT 1364，
归档打包/日账单上传自建表以来从未成功写入过（两表均 0 行）。

DB 默认值只兜底（本服务器 CURRENT_TIMESTAMP 是北京时间）；两表展示均按
naive UTC 口径(CNDatetime/utc_to_cn_iso)，应用层由模型显式写 utcnow。

Revision ID: 054_archive_bill_ts_default
"""
from typing import Sequence, Union

from alembic import op

revision: str = "054_archive_bill_ts_default"
down_revision: Union[str, None] = "053_return_order_ts_default"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("archive_batch", "daily_bill")


def upgrade() -> None:
    for table in _TABLES:
        op.execute(
            f"ALTER TABLE {table} "
            "MODIFY created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP"
        )
        op.execute(
            f"ALTER TABLE {table} "
            "MODIFY updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        )


def downgrade() -> None:
    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} MODIFY created_at datetime NOT NULL")
        op.execute(f"ALTER TABLE {table} MODIFY updated_at datetime NOT NULL")
