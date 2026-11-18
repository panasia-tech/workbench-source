"""采购商品快照（W04 / PC-047～050）：下单前原文、链接、平台商品 ID 多版本留存。

采购 Copilot / 议价对照依赖这份底座：首份保留、改价后另开版本、下单后可冻结。
"""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class PurchaseItemSnapshot(Base, TimestampMixin):
    __tablename__ = "purchase_item_snapshot"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    purchase_order_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("purchase_order.id"), nullable=True, index=True,
        comment="关联采购单；下单前可先存草稿快照，建单后再绑",
    )
    # 平台商品身份（闲鱼 item_id 等）
    platform: Mapped[str] = mapped_column(String(32), nullable=False, default="xianyu", server_default="xianyu")
    platform_item_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # 原文留存
    title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    condition_text: Mapped[str | None] = mapped_column(String(128), nullable=True, comment="卖家声明成色原文")
    accessories_text: Mapped[str | None] = mapped_column(String(512), nullable=True, comment="配件声明原文")
    listed_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True, comment="页面标价")
    seller_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    images: Mapped[list | None] = mapped_column(JSON, nullable=True, comment="快照时的商品图 URL 列表")
    raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True, comment="扩展字段/采集原文")
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    # 首份保留：同一商品链路的第一版 id；后续版本指向它
    root_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("purchase_item_snapshot.id"), nullable=True)
    frozen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, comment="下单冻结时间，冻结后不可改")
    capture_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="OK", server_default="OK",
        comment="OK / FAILED / PARTIAL：采集失败也要留状态",
    )
    capture_error: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    # 11-16 补（W04 PC-048/049/055/060）：执行端抓回来的挂平台订单；卖家写的型号和规格；什么时候抓的、
    # 是下单前就存的还是下单后补抓的；原图转存到我们图床后的对象名和 SHA-256（卖家删了图也还能看）
    platform_order_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("purchase_platform_order.id"), nullable=True, index=True)
    declared_model: Mapped[str | None] = mapped_column(String(128), nullable=True, comment="卖家写的型号原文")
    specs: Mapped[str | None] = mapped_column(Text, nullable=True, comment="卖家写的规格原文")
    capture_kind: Mapped[str] = mapped_column(String(16), default="manual", server_default="manual",
                                              comment="manual 采购手填 / live 下单前抓 / late 下单后补抓")
    captured_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    media: Mapped[list | None] = mapped_column(JSON, nullable=True,
                                               comment="[{src, type, status: pending/saved/failed, key, sha256, size, error}]")

    purchase_order = relationship("PurchaseOrder", back_populates="item_snapshots")
