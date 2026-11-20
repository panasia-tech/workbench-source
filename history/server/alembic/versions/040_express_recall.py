"""sku 增加 recalled_at / redispatch_media（议价后「召回快递」补传环节）

议价提交后不再直接进历史，先落「待召回快递」（recalled_at 为空），业务员补传顺丰
改派/再次派件凭证后 recalled_at 置值才闭环进历史。

关键回填：存量已议价记录（negotiated_at 非空）一律视为已完成，recalled_at=negotiated_at，
避免历史记录全部涌进新建的「待召回快递」待办。

Revision ID: 040_express_recall
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "040_express_recall"
down_revision: Union[str, None] = "039_negotiation_task_soft_delete"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sku", sa.Column("recalled_at", sa.DateTime(), nullable=True))
    # MySQL 的 JSON 列不能带字面量 DEFAULT，沿用项目约定：nullable=True，由模型 default=list 兜底
    op.add_column("sku", sa.Column("redispatch_media", sa.JSON(), nullable=True))
    # 存量已议价记录直接算已完成，留在历史议价里，不堵进「待召回快递」新待办
    op.execute(
        "UPDATE sku SET recalled_at = negotiated_at WHERE negotiated_at IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_column("sku", "redispatch_media")
    op.drop_column("sku", "recalled_at")
