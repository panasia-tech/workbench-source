"""真正删掉 sku.purchase_order_id 的 UNIQUE(修 025 漏)

025 用 try/except 包了 drop_constraint/drop_index 两步,但 MySQL 会因为
FK 依赖拒绝 drop_index('purchase_order_id'),报错被静默吞掉,导致 25 号
被 alembic 标记为已应用但实际索引没动。

本迁移采用正确顺序:用 inspector 找到实际的 FK 约束名 → 先 drop FK →
再 drop 老的 unique index → 重建 FK(此时 MySQL 会自动用 025 已建好的
ix_sku_purchase_order_id 作为 FK 索引)。

幂等:如果 unique index 已不存在(例如新环境直接装到 head 没踩坑),
也能正常跳过。

Revision ID: 026_drop_sku_po_unique_fix
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "026_drop_sku_po_unique_fix"
down_revision: Union[str, None] = "025_drop_sku_po_unique"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _find_unique_index(insp: sa.engine.reflection.Inspector) -> str | None:
    """返回挂在 sku.purchase_order_id 上、且是 unique 的索引名;没有就返回 None。"""
    for idx in insp.get_indexes("sku"):
        if idx.get("unique") and idx.get("column_names") == ["purchase_order_id"]:
            return idx["name"]
    # MySQL 有时 unique 不在 get_indexes 里露出,从 unique_constraints 再找一遍
    for uq in insp.get_unique_constraints("sku"):
        if uq.get("column_names") == ["purchase_order_id"]:
            return uq["name"]
    return None


def _find_fk(insp: sa.engine.reflection.Inspector) -> str | None:
    for fk in insp.get_foreign_keys("sku"):
        if fk.get("constrained_columns") == ["purchase_order_id"]:
            return fk["name"]
    return None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    uniq_idx = _find_unique_index(insp)
    if not uniq_idx:
        # 已经是干净状态,nothing to do
        return

    fk_name = _find_fk(insp)
    if fk_name:
        op.drop_constraint(fk_name, "sku", type_="foreignkey")

    op.drop_index(uniq_idx, table_name="sku")

    # 重建 FK。MySQL 会优先复用 025 已创建的 ix_sku_purchase_order_id 作为 FK 索引,
    # 不会再造一个新的同名 unique index。
    op.create_foreign_key(
        "fk_sku_purchase_order_id",
        "sku",
        "purchase_order",
        ["purchase_order_id"],
        ["id"],
    )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    fk_name = _find_fk(insp)
    if fk_name:
        op.drop_constraint(fk_name, "sku", type_="foreignkey")
    op.create_unique_constraint("purchase_order_id", "sku", ["purchase_order_id"])
    op.create_foreign_key(
        "fk_sku_purchase_order_id",
        "sku",
        "purchase_order",
        ["purchase_order_id"],
        ["id"],
    )
