from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class InventoryManualRequest(Base, TimestampMixin):
    __tablename__ = "inventory_manual_request"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    request_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    request_type: Mapped[str] = mapped_column(String(16), index=True)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    request_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    item_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    review_decision: Mapped[str | None] = mapped_column(String(16), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewed_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    executed_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ops_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class InventoryListingTask(Base, TimestampMixin):
    __tablename__ = "inventory_listing_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    listing_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    listing_title: Mapped[str | None] = mapped_column(String(256), nullable=True)
    listing_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    listing_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model_key: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    reason_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    in_stock_count: Mapped[int] = mapped_column(Integer, default=0)
    last_detected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolve_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
