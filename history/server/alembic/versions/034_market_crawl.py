"""新增闲鱼行情爬虫表：crawl_product（待爬商品 watch list）+ crawl_price（每日近7日成交均价）

Revision ID: 034_market_crawl
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "034_market_crawl"
down_revision: Union[str, None] = "033_purchase_overdue"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "crawl_product",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("keyword", sa.String(128), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("last_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("last_price_date", sa.Date(), nullable=True),
        sa.Column("last_crawled_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.String(36), sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        # 外键引用 staff.id（utf8mb4_unicode_ci），字符集/排序规则须一致，否则报 1215
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_unique_constraint("uq_crawl_product_name", "crawl_product", ["name"])
    op.create_index("ix_crawl_product_name", "crawl_product", ["name"])
    op.create_index("ix_crawl_product_enabled", "crawl_product", ["enabled"])

    op.create_table(
        "crawl_price",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "product_id",
            sa.String(36),
            sa.ForeignKey("crawl_product.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("crawl_date", sa.Date(), nullable=False),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("trend_delta", sa.Numeric(12, 2), nullable=True),
        sa.Column("search_heat", sa.Integer(), nullable=True),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_unique_constraint(
        "uq_crawl_price_product_date", "crawl_price", ["product_id", "crawl_date"]
    )
    op.create_index("ix_crawl_price_product_id", "crawl_price", ["product_id"])
    op.create_index("ix_crawl_price_crawl_date", "crawl_price", ["crawl_date"])


def downgrade() -> None:
    op.drop_table("crawl_price")
    op.drop_table("crawl_product")
