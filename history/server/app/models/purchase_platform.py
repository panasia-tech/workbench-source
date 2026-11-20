"""采购工作台 W10：平台上的真实采购订单（执行端只读「我买到的」抓回来）。

一条 = 平台 + 买家账号 + 平台订单号，唯一。一单多件时几张采购单挂同一条（purchase_order.platform_order_id）。
交易、付款、退款、物流四种状态分开存，平台原文 raw_status 也留着；每次变化记一条事件，事件按 event_key 去重。
"""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class PurchasePlatformOrder(Base, TimestampMixin):
    __tablename__ = "purchase_platform_order"
    __table_args__ = (UniqueConstraint("platform", "buyer_account", "platform_order_no", name="uq_purchase_platform_order"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    platform: Mapped[str] = mapped_column(String(16), default="xianyu", server_default="xianyu")
    # 执行端报上来的买家账号（闲鱼昵称或登录名），对上 purchase_account.code / label 的记在 purchase_account
    buyer_account: Mapped[str] = mapped_column(String(64))
    purchase_account: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    platform_order_no: Mapped[str] = mapped_column(String(64), index=True)
    # 商品（下单时的原样；完整原文在快照里）
    item_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    item_title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    item_image: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    seller_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    seller_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    quantity: Mapped[int | None] = mapped_column(nullable=True)
    # 金额各记各的，缺了就空着，不填 0
    order_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    paid_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    freight: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    refunded_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    # 状态：见 services/purchase_platform.py 的 TRADE / PAY / REFUND / SHIP
    trade_status: Mapped[str] = mapped_column(String(16), default="unknown", server_default="unknown", index=True)
    pay_status: Mapped[str] = mapped_column(String(16), default="unknown", server_default="unknown")
    refund_status: Mapped[str] = mapped_column(String(16), default="none", server_default="none")
    ship_status: Mapped[str] = mapped_column(String(16), default="unknown", server_default="unknown")
    raw_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tracking_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    logistics_company: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ordered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 平台上这单最后变化的时间（拿来判断谁新谁旧）；没有就靠状态先后
    platform_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 同步
    sync_status: Mapped[str] = mapped_column(String(16), default="ok", server_default="ok")  # ok / partial / failed
    sync_error: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 要人看的：账号对不上、状态看不懂、取消了但采购单还在等收货……
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", index=True)
    review_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class PurchasePlatformEvent(Base):
    """平台订单的一次变化或一次人工处理。event_key 唯一：同一个变化报两遍只记一次。"""

    __tablename__ = "purchase_platform_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("purchase_platform_order.id"), index=True)
    event_key: Mapped[str] = mapped_column(String(128), unique=True)
    kind: Mapped[str] = mapped_column(String(16))  # created / status / stale / bind / unbind / review / note
    text: Mapped[str] = mapped_column(Text)
    data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="rpa")  # rpa / manual
    staff_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
