from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, JSON, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class CrawlProduct(Base, TimestampMixin):
    """待爬商品（行情看板的 watch list）。一条 = 一个要在闲鱼监控行情的商品名。"""

    __tablename__ = "crawl_product"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)  # 展示名（唯一）
    keyword: Mapped[str | None] = mapped_column(String(128), nullable=True)  # 闲鱼实际搜索词，空则用 name
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)  # 是否参与爬取
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # 冗余：最近一次爬到的价格，用于列表快查「最新价」（当天没有则即为最近一次）
    last_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    last_price_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    last_crawled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)

    prices: Mapped[list["CrawlPrice"]] = relationship(
        back_populates="product", cascade="all, delete-orphan", passive_deletes=True
    )


class CrawlPrice(Base):
    """每日行情记录，一个型号一天一条。

    口径看 raw.source：ocr=闲鱼「行情」页的近7日成交均价，cleaned_average=巡航台清洗后的
    平均挂牌价，lowest_listing=旧爬虫第一页最低挂牌价。只有 ocr 那种能叫成交价。
    """

    __tablename__ = "crawl_price"
    __table_args__ = (UniqueConstraint("product_id", "crawl_date", name="uq_crawl_price_product_date"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    product_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("crawl_product.id", ondelete="CASCADE"), index=True
    )
    crawl_date: Mapped[date] = mapped_column(Date, index=True)  # 中国日界的日期
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2))  # 行情价，口径见类注释
    trend_delta: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)  # 较上周涨跌（跌为负）
    search_heat: Mapped[int | None] = mapped_column(Integer, nullable=True)  # X 人在搜
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # 原始截取文本/搜索词/设备号，便于复核
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    product: Mapped["CrawlProduct"] = relationship(back_populates="prices")
