"""仓库 SPU 对照表:warehouse_spu(品牌+型号+SPU编码) 与 warehouse_spu_sku(SPU 下挂的 SKU 编码)

对照清单「仓库SPU品牌型号_SPUSKU对应清单.xlsx」的落库形态:
  品牌+型号 / SPU编码 → warehouse_spu(一行一款,spu_code 唯一)
  SKU编码            → warehouse_spu_sku(一 SPU 多行,sku_code 全局唯一)
与 sku.spu(69码查条码库的 JSON 快照)无关,亦不与 sku.sku_code 建外键——
后者是 ERP 自己的一物一码,这里存的是仓库/WMS 侧的编码。

Revision ID: 066_warehouse_spu
Revises: 065_pickup_payment_qr_text
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "066_warehouse_spu"
down_revision: Union[str, None] = "065_pickup_payment_qr_text"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "warehouse_spu",
        sa.Column("id", sa.String(length=36), primary_key=True),
        # 69码(EAN-13)与 8 位内部码(9000xxxx)混用,统一按字符串存
        sa.Column("spu_code", sa.String(length=64), nullable=False),
        sa.Column("brand", sa.String(length=64), nullable=False),
        # 「品牌+型号」按首个空格拆分,无空格的(如「音响」)型号为空
        sa.Column("model", sa.String(length=128), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("spu_code", name="uq_warehouse_spu_code"),
    )
    # 「品牌+型号」故意不唯一:同款不同批次可各有 SPU 编码(如盛色 N50PRO6 有 3 个)
    op.create_index("ix_warehouse_spu_brand", "warehouse_spu", ["brand"])
    op.create_index("ix_warehouse_spu_model", "warehouse_spu", ["model"])
    op.create_index("ix_warehouse_spu_enabled", "warehouse_spu", ["enabled"])

    op.create_table(
        "warehouse_spu_sku",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("spu_id", sa.String(length=36), nullable=False),
        sa.Column("sku_code", sa.String(length=64), nullable=False),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["spu_id"], ["warehouse_spu.id"],
            name="fk_warehouse_spu_sku_spu", ondelete="CASCADE",
        ),
        # 一个 SKU 编码只能挂一个 SPU——对照表的核心约束
        sa.UniqueConstraint("sku_code", name="uq_warehouse_spu_sku_code"),
    )
    op.create_index("ix_warehouse_spu_sku_spu_id", "warehouse_spu_sku", ["spu_id"])


def downgrade() -> None:
    op.drop_index("ix_warehouse_spu_sku_spu_id", table_name="warehouse_spu_sku")
    op.drop_table("warehouse_spu_sku")
    op.drop_index("ix_warehouse_spu_enabled", table_name="warehouse_spu")
    op.drop_index("ix_warehouse_spu_model", table_name="warehouse_spu")
    op.drop_index("ix_warehouse_spu_brand", table_name="warehouse_spu")
    op.drop_table("warehouse_spu")
