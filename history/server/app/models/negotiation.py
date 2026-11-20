from datetime import datetime
from decimal import Decimal

from sqlalchemy import JSON, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class NegotiationTask(Base, TimestampMixin):
    __tablename__ = "negotiation_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    order_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    purchase_no: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    purchase_order_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("purchase_order.id"), nullable=True, index=True
    )
    item_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    goods_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    serial_no: Mapped[str | None] = mapped_column(String(128), nullable=True)
    seller_nickname: Mapped[str | None] = mapped_column(String(128), nullable=True)
    product_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    location: Mapped[str | None] = mapped_column(String(64), nullable=True)
    inspection_result: Mapped[str | None] = mapped_column(String(32), nullable=True)
    inspection_result_text: Mapped[str | None] = mapped_column(String(128), nullable=True)
    inspection_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    purchase_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    product_images: Mapped[list] = mapped_column(JSON, default=list)
    defect_images: Mapped[list] = mapped_column(JSON, default=list)
    defect_videos: Mapped[list] = mapped_column(JSON, default=list)
    logistics_tracking_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    inspector_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    inspector_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    inspected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    close_evidence_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    close_evidence_files: Mapped[list] = mapped_column(JSON, default=list)
    close_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    closed_by_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_idem_key: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default="OPEN", index=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    # 软删除：隐藏老系统回填的陈旧议价任务等（不物理删，保留行）。非空=已删。
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
