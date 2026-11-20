from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class StaffScheduleLog(Base):
    __tablename__ = "staff_schedule_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    log_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(32), index=True)
    month: Mapped[str | None] = mapped_column(String(8), nullable=True, index=True)
    target_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    before_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    after_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    default_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    operator_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    operator_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class StaffScheduleOverride(Base, TimestampMixin):
    __tablename__ = "staff_schedule_override"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    target_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    target_date: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(16))
    source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class StaffScheduleHolidayRequest(Base, TimestampMixin):
    __tablename__ = "staff_schedule_holiday_request"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    target_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    reviewed_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
