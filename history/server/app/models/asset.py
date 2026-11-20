from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class AssetDevice(Base, TimestampMixin):
    __tablename__ = "asset_device"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    asset_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    device_name: Mapped[str] = mapped_column(String(128))
    device_sn: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sn_normalized: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    device_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    owner_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True, index=True)
    owner_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    owner_account: Mapped[str | None] = mapped_column(String(64), nullable=True)
    office_site: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default="IDLE", index=True)
    purpose: Mapped[str | None] = mapped_column(String(256), nullable=True)
    purchase_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_files: Mapped[list] = mapped_column(JSON, default=list)
    # 采购单来源：资产可关联采购单，自动带入品牌/型号/规格/单价/图片
    purchase_order_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("purchase_order.id"), nullable=True, index=True
    )
    purchase_order_no: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    brand: Mapped[str | None] = mapped_column(String(128), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    spec: Mapped[str | None] = mapped_column(String(128), nullable=True)
    unit_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    product_images: Mapped[list] = mapped_column(JSON, default=list)

    purchase_order = relationship("PurchaseOrder", back_populates="asset_device", uselist=False)


class AssetInventoryTask(Base, TimestampMixin):
    __tablename__ = "asset_inventory_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    title: Mapped[str] = mapped_column(String(128))
    scope_type: Mapped[str] = mapped_column(String(16))
    office_site: Mapped[str | None] = mapped_column(String(64), nullable=True)
    device_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    deadline: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="OPEN", index=True)
    total_count: Mapped[int] = mapped_column(Integer, default=0)
    checked_count: Mapped[int] = mapped_column(Integer, default=0)
    abnormal_count: Mapped[int] = mapped_column(Integer, default=0)
    last_check_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class AssetInventoryRecord(Base, TimestampMixin):
    __tablename__ = "asset_inventory_record"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    task_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    device_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("asset_device.id"), nullable=True, index=True)
    asset_no: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    device_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    device_sn: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sn_normalized: Mapped[str | None] = mapped_column(String(128), nullable=True)
    office_site: Mapped[str | None] = mapped_column(String(64), nullable=True)
    owner_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    owner_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    owner_account: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    result: Mapped[str] = mapped_column(String(16), default="UNSET")
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    checked_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    cycle_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    period_key: Mapped[str | None] = mapped_column(String(16), nullable=True)
    period_title: Mapped[str | None] = mapped_column(String(64), nullable=True)
    alipay_trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    order_no: Mapped[str | None] = mapped_column(String(64), nullable=True)


class AssetReductionRequest(Base, TimestampMixin):
    __tablename__ = "asset_reduction_request"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    request_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    asset_no: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    device_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("asset_device.id"), nullable=True)
    device_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    device_sn: Mapped[str | None] = mapped_column(String(128), nullable=True)
    before_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    target_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    attachments: Mapped[list] = mapped_column(JSON, default=list)
    office_site: Mapped[str | None] = mapped_column(String(64), nullable=True)
    owner_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    owner_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    owner_account: Mapped[str | None] = mapped_column(String(64), nullable=True)
    requested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    requested_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewed_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
