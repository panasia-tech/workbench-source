"""图片爬虫(product-image-service,京东云 panel.panasia.fun)按 SPU 搜的参考图。

一个 SPU 一行:发起过的搜图任务、员工在爬虫审核页给的结论,审核合格后转存到我们图床的那张参考图。
参考图只给 AI 重绘当「这东西长什么样」用,不当实拍、不直接上架(同款他人的图证明不了这一件)。
"""
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class SpuImageSearch(Base, TimestampMixin):
    __tablename__ = "spu_image_search"

    # 状态:SEARCHING 爬取中 / REVIEWING 搜完等员工审 / READY 审过、参考图已转存
    #       REJECTED 员工标了「需处理」/ FAILED 爬虫没搜到或调用出错
    SEARCHING = "SEARCHING"
    REVIEWING = "REVIEWING"
    READY = "READY"
    REJECTED = "REJECTED"
    FAILED = "FAILED"
    OPEN = (SEARCHING, REVIEWING)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    spu_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("warehouse_spu.id", ondelete="CASCADE"), unique=True, index=True
    )
    query: Mapped[str] = mapped_column(String(200))
    task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=SEARCHING, index=True)
    formal_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # 转存后的图床地址(干净 URL,不带签名);source_url 记这张图原本从哪来
    reference_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    reviewer: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 正式池整池转存进图床,上架页给员工按店铺挑:[{url, crawler_url, source_url}];爬虫的图要登录才能看
    pool_images: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # 审核通过后整池写进 warehouse_spu_image 的条数/时间;上架页按档案读,不再只靠这张任务表
    archive_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 爬虫 progress_json 快照:上架页显示“已搜到 N 张 / 当前阶段”
    search_progress: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # 上次发起请求时间,用于“档案太薄时隔冷却自动补搜”
    last_requested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class WarehouseSpuImage(Base, TimestampMixin):
    """SPU 级共享同款图库(2026-11-11)。

    爬虫员工审核“图片合格”后,把整个正式池写进这里;同一「品牌+型号」的所有 SPU 共用。
    和 spu_image_search.pool_images 的区别:那是任务态 JSON(最多几十张、每次覆盖),
    这里是商品档案(可跨重搜保留、按图去重、有主图/排序/淘汰状态)。

    不写进 Sku.images / SkuListingInfo.images:同款图是候选,不是这一件的实拍;
    上架页按“实拍/同款”分开显示,每店铺选图的规则不变。
    """

    __tablename__ = "warehouse_spu_image"
    __table_args__ = (
        UniqueConstraint("spu_id", "url_hash", name="uq_spu_image_spu_url"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    APPROVED = "approved"
    CANDIDATE = "candidate"
    REJECTED = "rejected"

    SOURCE_CRAWLER = "crawler"
    SOURCE_REAL = "real"
    SOURCE_AI = "ai"
    SOURCE_UPLOAD = "upload"
    SOURCE_BACKFILL = "backfill"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    spu_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("warehouse_spu.id", ondelete="CASCADE"), index=True
    )
    # 规范化「品牌+型号」:同款不同 SPU 编码(如盛色 N50PRO6 有 3 个编码)共享同一图库
    model_key: Mapped[str] = mapped_column(String(128), index=True)
    # 图床干净 URL;md5(url) 用于唯一约束和去重
    url: Mapped[str] = mapped_column(String(512))
    url_hash: Mapped[str] = mapped_column(String(32), index=True)
    crawler_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    source: Mapped[str] = mapped_column(String(16), default=SOURCE_CRAWLER, server_default=SOURCE_CRAWLER)
    status: Mapped[str] = mapped_column(
        String(16), default=APPROVED, server_default=APPROVED, index=True
    )
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    watermark: Mapped[str | None] = mapped_column(String(16), nullable=True)
    quality_grade: Mapped[str | None] = mapped_column(String(8), nullable=True)
    quality_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    quality_flags: Mapped[list | None] = mapped_column(JSON, nullable=True)
    product_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    is_cover: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    crawler_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ImageMaterialMark(Base, TimestampMixin):
    """上架候选图的人工结论(2026-11-10 素材分池):可用 / 淘汰(带原因)。

    没有这一行的图按规则算(app/services/image_material.py:爬虫评 bad 的待复核,像头像、表情包、截图的淘汰)。
    按图床干净地址认:一张爬虫同款图标了淘汰,同型号的货都不再拿它当候选。
    """
    __tablename__ = "image_material_mark"

    USABLE = "usable"
    REJECTED = "rejected"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # md5(url):url 太长,不直接建唯一索引
    url_hash: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    url: Mapped[str] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 在哪件货上标的(爬虫图另记型号),只当记录看
    sku_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    spu_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    marked_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
