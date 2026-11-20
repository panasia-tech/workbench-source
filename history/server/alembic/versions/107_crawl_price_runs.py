"""行情按次留历史：crawl_price_run（F01-06）

crawl_price 一个型号一天一条，同一天重跑会把上一次的结果盖掉。新表每次上报追加一行，
crawl_price 照旧当「当天最新」，读它的地方都不用动。

Revision ID: 107_crawl_price_runs
Revises: 106_gc_precheck
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "107_crawl_price_runs"
down_revision: Union[str, None] = "106_gc_precheck"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "crawl_price_run",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "product_id", sa.String(36),
            sa.ForeignKey("crawl_product.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("crawl_date", sa.Date(), nullable=False),
        sa.Column("crawled_at", sa.DateTime(), nullable=False),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("trend_delta", sa.Numeric(12, 2), nullable=True),
        sa.Column("search_heat", sa.Integer(), nullable=True),
        sa.Column("source", sa.String(32), nullable=True),
        sa.Column("sample_count", sa.Integer(), nullable=True),
        sa.Column("run_id", sa.String(36), nullable=True),
        sa.Column("local_run_id", sa.String(64), nullable=True),
        sa.Column("device_id", sa.String(64), nullable=True),
        sa.Column("uploader_id", sa.String(36), nullable=True),
        sa.Column("crawl_price_id", sa.String(36), nullable=True),
        sa.Column("summary", sa.JSON(), nullable=True),
    )
    op.create_index("ix_crawl_price_run_product_id", "crawl_price_run", ["product_id"])
    op.create_index("ix_crawl_price_run_crawl_date", "crawl_price_run", ["crawl_date"])
    op.create_index("ix_crawl_price_run_crawled_at", "crawl_price_run", ["crawled_at"])
    op.create_index("ix_crawl_price_run_run_id", "crawl_price_run", ["run_id"])
    op.create_index("ix_crawl_price_run_product_crawled", "crawl_price_run", ["product_id", "crawled_at"])


def downgrade() -> None:
    op.drop_table("crawl_price_run")
