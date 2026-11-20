"""增强 AssetDevice（采购单关联）+ 新增手机号管理表

Revision ID: 043_asset_enhance_phone
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "043_asset_enhance_phone"
down_revision: Union[str, None] = "042_anonymous_feedback"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # AssetDevice 新增采购单关联字段（asset_device 表由迁移 024 创建）
    op.add_column("asset_device", sa.Column("purchase_order_id", sa.String(length=36), nullable=True))
    op.add_column("asset_device", sa.Column("purchase_order_no", sa.String(length=32), nullable=True))
    op.add_column("asset_device", sa.Column("brand", sa.String(length=128), nullable=True))
    op.add_column("asset_device", sa.Column("model", sa.String(length=128), nullable=True))
    op.add_column("asset_device", sa.Column("spec", sa.String(length=128), nullable=True))
    op.add_column("asset_device", sa.Column("unit_price", sa.Numeric(precision=12, scale=2), nullable=True))
    # MySQL 不允许 JSON 列带字面量 DEFAULT（errno 1101）。沿用项目既有 JSON 列范式：
    # 列可空 + 应用层 default=list；存量行回填空数组，避免读取时拿到 NULL。
    op.add_column("asset_device", sa.Column("product_images", sa.JSON(), nullable=True))
    op.execute("UPDATE asset_device SET product_images = '[]' WHERE product_images IS NULL")

    op.create_index(op.f("ix_asset_device_purchase_order_id"), "asset_device", ["purchase_order_id"], unique=False)
    op.create_index(op.f("ix_asset_device_purchase_order_no"), "asset_device", ["purchase_order_no"], unique=False)
    op.create_foreign_key(
        op.f("fk_asset_device_purchase_order_id"),
        "asset_device", "purchase_order",
        ["purchase_order_id"], ["id"],
    )

    # PhoneNumber 新表
    op.create_table(
        "phone_number",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("activation_date", sa.Date(), nullable=True),
        sa.Column("carrier", sa.String(length=32), nullable=True),
        sa.Column("plan_details", sa.Text(), nullable=True),
        sa.Column("phone_number", sa.String(length=32), nullable=False),
        sa.Column("xianyu_member_name", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(op.f("ix_phone_number_phone_number"), "phone_number", ["phone_number"], unique=True)
    op.create_index(op.f("ix_phone_number_xianyu_member_name"), "phone_number", ["xianyu_member_name"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_phone_number_xianyu_member_name"), table_name="phone_number")
    op.drop_index(op.f("ix_phone_number_phone_number"), table_name="phone_number")
    op.drop_table("phone_number")

    op.drop_constraint(op.f("fk_asset_device_purchase_order_id"), "asset_device", type_="foreignkey")
    op.drop_index(op.f("ix_asset_device_purchase_order_no"), table_name="asset_device")
    op.drop_index(op.f("ix_asset_device_purchase_order_id"), table_name="asset_device")
    op.drop_column("asset_device", "product_images")
    op.drop_column("asset_device", "unit_price")
    op.drop_column("asset_device", "spec")
    op.drop_column("asset_device", "model")
    op.drop_column("asset_device", "brand")
    op.drop_column("asset_device", "purchase_order_no")
    op.drop_column("asset_device", "purchase_order_id")
