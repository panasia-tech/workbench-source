from datetime import datetime
from decimal import Decimal

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class PurchaseOrder(Base, TimestampMixin):
    __tablename__ = "purchase_order"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    order_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    product_name: Mapped[str] = mapped_column(String(256))
    brand: Mapped[str | None] = mapped_column(String(128), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    spec: Mapped[str | None] = mapped_column(String(128), nullable=True)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    # 同一件商品买了几件（禅道 WH01-04）：每件一张验货单、入库各一个 SKU，全部验完采购单才算完成；成交金额按件均摊
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    external_order_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # 采购工作台 W10：执行端抓回来的平台订单（一单多件时几张采购单挂同一条）
    platform_order_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("purchase_platform_order.id"), nullable=True, index=True)
    # 采购工作台 W06：下单时锁住的那一版公司价（后来调表不改旧单）
    price_rule_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("purchase_price_rule.id"), nullable=True)
    transaction_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tracking_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tracking_phone_suffix: Mapped[str | None] = mapped_column(String(8), nullable=True)
    order_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    purchase_account: Mapped[str | None] = mapped_column(String(64), nullable=True)
    seller_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    product_images: Mapped[list] = mapped_column(JSON, default=list)
    attachments: Mapped[list] = mapped_column(JSON, default=list)
    screenshot_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    screenshot_url_2: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    # 逾期采购：提交时快件已到浙江省内（提交太晚），不发放基础提成，历史中优先显示该状态
    is_overdue: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0", index=True)
    # 货况警示：实拍图 OCR 命中「全新/几乎全新」字样 → 验货/议价端标红重点核对。后台异步扫描回填。
    condition_warning: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0", index=True)
    condition_warning_text: Mapped[str | None] = mapped_column(String(64), nullable=True)
    condition_scanned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    inspections = relationship("Inspection", back_populates="purchase_order", order_by="Inspection.piece_no")
    skus = relationship("Sku", back_populates="purchase_order")
    asset_device = relationship("AssetDevice", back_populates="purchase_order", uselist=False)
    item_snapshots = relationship(
        "PurchaseItemSnapshot", back_populates="purchase_order",
        order_by="PurchaseItemSnapshot.version.desc()",
    )
