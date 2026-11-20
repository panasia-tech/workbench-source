"""步入式价格清洗：一次清洗 = 一个任务；任务带着那次采集的原始样本；确认出一个价格版本，管理员生效。"""
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class PriceCleanTask(Base, TimestampMixin):
    __tablename__ = "price_clean_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    # 样本取自哪次采集（crawl_price 一个型号一天一条），日期决定新鲜度
    crawl_product_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    crawl_price_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    crawl_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    query: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="OPEN")  # OPEN 清洗中 / DONE 已出版本 / DROPPED 重新开始时作废
    started_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class PriceSample(Base):
    __tablename__ = "price_sample"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    task_id: Mapped[str] = mapped_column(String(36), ForeignKey("price_clean_task.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 闲鱼商品 ID，按它去重
    title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    query: Mapped[str | None] = mapped_column(String(128), nullable=True)
    item_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # 原页快照在执行端电脑上，这里记路径，回看时去那台机器找
    snapshot_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # LISTING 挂牌 / SOLD_LISTING 已售挂牌 / NEW 新品 / RECYCLE 回收 / AUCTION 拍卖；只有挂牌类算销售有效价
    price_type: Mapped[str] = mapped_column(String(16), default="LISTING")
    kept: Mapped[bool] = mapped_column(Boolean, default=True)
    reject_reason: Mapped[str | None] = mapped_column(String(128), nullable=True)
    auto: Mapped[bool] = mapped_column(Boolean, default=True)  # 剔除/保留是系统按规则判的，还是人改的
    outlier: Mapped[bool] = mapped_column(Boolean, default=False)
    edited_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class PriceVersion(Base):
    __tablename__ = "price_version"
    __table_args__ = (UniqueConstraint("sku_id", "version", name="uq_price_version_sku_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    task_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("price_clean_task.id"), nullable=True)
    version: Mapped[int] = mapped_column(Integer)
    # PENDING 待生效 / ACTIVE 生效中 / SUPERSEDED 被新版本替下 / REJECTED 管理员退回；过期看 expires_on
    status: Mapped[str] = mapped_column(String(16), default="PENDING")
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2))  # 确认的价
    median: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)  # 清洗出的有效价（中位数）
    low: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    high: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    confidence: Mapped[str | None] = mapped_column(String(8), nullable=True)
    crawl_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True)  # 行情日期 + 7 天，过了不能用
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    confirmed_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    activated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    review_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
