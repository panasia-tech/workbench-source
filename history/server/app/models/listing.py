from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class SkuListingInfo(Base, TimestampMixin):
    __tablename__ = "sku_listing_info"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), unique=True, index=True)
    title: Mapped[str | None] = mapped_column(String(256), nullable=True)
    desc: Mapped[str | None] = mapped_column(Text, nullable=True)
    price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    original_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    express_fee: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    images: Mapped[list] = mapped_column(JSON, default=list)
    # images 是 AI 按型号文生图出来的、还没人确认对不对(没有同款实拍图可参考时会猜错品类,
    # 10-08 把显示器画成了耳机)。为真时不自动上架,等人在小程序确认(见 ai_image_publish.py)。
    ai_image_unconfirmed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)
    stuff_status: Mapped[int | None] = mapped_column(nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="DRAFT", index=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class SkuShopListing(Base):
    __tablename__ = "sku_shop_listing"
    __table_args__ = (UniqueConstraint("sku_id", "sale_shop_id", name="uq_sku_shop"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    sale_shop_id: Mapped[str] = mapped_column(String(36), ForeignKey("sale_shop.id"), index=True)
    # 群控(真机)上下架的引用:发布/下架作业 id + 该店铺对应的 gc 账号 id。
    # gc 上架是异步的,状态由 job 回写。
    gc_job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    gc_account_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 货没有商品图时先 AI 生成主图、出图后再上架:等图期间这一列记着等的是哪个 ai_redraw_job,
    # 行停在 LISTING、还没有 gc_job_id。出图/失败后清空(见 services/gc_bridge/ai_image_publish.py)。
    ai_image_job_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # (商品×店铺=账号)无忧卖覆盖:None=继承账号默认(SaleShop.worry_free_sell);True/False=显式覆盖。
    worry_free_sell: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    publish_status: Mapped[str] = mapped_column(String(32), default="PENDING", index=True)
    sold_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    delisted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 这次发出去用的是哪份上架审批（开了审批才有）：执行端只能发批过的价和图
    listing_approval_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 上架时员工给这个店铺挑的图(干净 URL);有值时发布、链接焕新都用它,不用商品公用的那组
    images: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ListingApproval(Base, TimestampMixin):
    """一件货在一个店铺（= 一个闲鱼号）上发什么价、用哪组图，经管理员批过才能发。

    员工清洗后提交，管理员通过或退回；重新改价改图是新版本，旧版本留着。
    批的时候记下当时的成本、行情和成本比例，发布前拿现在的情况再核一遍：
    成本变了、比例改了、货不在库了，旧的批准都不能接着用。
    """

    __tablename__ = "listing_approval"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    sale_shop_id: Mapped[str] = mapped_column(String(36), ForeignKey("sale_shop.id"), index=True)
    version: Mapped[int] = mapped_column(default=1)
    # DRAFT 草稿 / SUBMITTED 待审批 / APPROVED 已通过 / REJECTED 已退回 / STALE 失效
    status: Mapped[str] = mapped_column(String(16), default="DRAFT", index=True)
    # 整数元，就是群控实际挂出去的价
    price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    images: Mapped[list] = mapped_column(JSON, default=list)
    # 提交时的依据
    cost_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    min_cost_ratio: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    market_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    market_basis: Mapped[str | None] = mapped_column(String(16), nullable=True)
    market_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    edited_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    submitted_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 退回时可附的标注截图、对照说明，员工按项补正
    review_media: Mapped[list | None] = mapped_column(JSON, nullable=True)
    stale_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
