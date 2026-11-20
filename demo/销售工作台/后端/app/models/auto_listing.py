from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.enums import AutoListingStage
from app.models.staff import TimestampMixin, new_uuid


class SkuAutoListing(Base, TimestampMixin):
    """一件 SKU 的自动上架进度。入库时登记，后台 worker 推着往前走。

    与 SkuListingInfo 的分工：那张表是**上架信息本身**（标题/价/图，人工也在填），
    这张表只记**自动化流水线的状态**。自动化写完信息后 SkuListingInfo 与人工填的
    没有区别，人工上架路径照常可用，两者不冲突。
    """

    __tablename__ = "sku_auto_listing"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # 一件 SKU 一行
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), unique=True, index=True)
    stage: Mapped[str] = mapped_column(
        String(24), default=AutoListingStage.RESOLVING, server_default="RESOLVING", index=True
    )

    # 解析结果（不设外键：SPU 对照表是可维护的主数据，删一款不该拖垮历史流水线记录）
    spu_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    spu_query: Mapped[str | None] = mapped_column(String(128), nullable=True)  # 「品牌 型号」搜索词
    match_how: Mapped[str | None] = mapped_column(String(16), nullable=True)   # barcode/brand_model/model

    # 定价：售价即行情价；行情价低于成本价则不自动发，转人工
    market_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    resolved_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)

    # 图片采集（product-image-service 的任务 id）
    image_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    image_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)

    # 存量回填的行：只补价补图，停在 READY 等人工上架，绝不下发群控（见 services/auto_listing/backfill.py）
    hold_publish: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)

    # 群控发布作业
    gc_job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    # 重试：指数退避，超限转 NEEDS_HUMAN
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 下次可处理时间；也用作 worker 抢占的依据（多 worker 部署时防重复发布）
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    # 停在 COLLECTING 等行情的起点，用于判断等价是否超期
    collecting_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
