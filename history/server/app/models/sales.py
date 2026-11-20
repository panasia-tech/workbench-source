from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class SaleOrder(Base, TimestampMixin):
    __tablename__ = "sale_order"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    order_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    platform: Mapped[str | None] = mapped_column(String(32), nullable=True)
    external_order_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    buyer_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    buyer_phone: Mapped[str | None] = mapped_column(String(128), nullable=True)
    amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    screenshot_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    product_title: Mapped[str | None] = mapped_column(String(256), nullable=True)
    product_spec: Mapped[str | None] = mapped_column(String(128), nullable=True)
    product_image_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    shop_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tracking_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tracking_phone_suffix: Mapped[str | None] = mapped_column(String(8), nullable=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))


class SalesOutbound(Base):
    __tablename__ = "sales_outbound"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    outbound_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    sale_order_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("sale_order.id"), nullable=True)
    buyer_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    outbound_type: Mapped[str] = mapped_column(String(32))
    sale_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    cost_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    evidence_urls: Mapped[list] = mapped_column(JSON, default=list)
    payment_screenshot_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    express_fee: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    # 平台手续费档位（仅平台交易用）：None=未标记/历史按无忧2.6%、False=普通1.6%、True=无忧卖2.6%。
    # 自提(outbound_type==PICKUP)恒 0%，不看此字段。
    worry_free: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # 闲鱼订单页上写的实际服务费（软件服务费 + 无忧卖服务费，元）。填了就按它算，
    # 空着才按 worry_free 估（无忧卖按类目和售出时长 1%～17.5%，估不准）。
    platform_fee: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    tracking_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tracking_phone_suffix: Mapped[str | None] = mapped_column(String(8), nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    operator_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ReturnOrder(Base):
    __tablename__ = "return_order"

    # 不用 TimestampMixin：019 建表漏了 server_default，且本库时区 CST 下
    # CURRENT_TIMESTAMP 是北京时间，而本表展示(CNDatetime)/财务筛选按 naive UTC 口径，
    # 由应用层显式写 utcnow（表上生产 0 行，无存量口径问题）。
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    return_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    sku_code: Mapped[str] = mapped_column(String(64), index=True)
    product_name: Mapped[str] = mapped_column(String(256))
    status: Mapped[str] = mapped_column(String(32), index=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    outbound_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("sales_outbound.id"), nullable=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    receiver_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 收货核对（052）：仓库确认收货时强制填写
    reason_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    received_serial: Mapped[str | None] = mapped_column(String(128), nullable=True)
    received_condition: Mapped[str | None] = mapped_column(String(16), nullable=True)
    received_location_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    received_media: Mapped[list | None] = mapped_column(JSON, nullable=True)
    received_remark: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 异常裁决（052）：resolved_by_id 无外键（collation 兼容），名字走 map_staff_names
    abnormal_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    resolution: Mapped[str | None] = mapped_column(String(16), nullable=True)
    resolved_by_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
