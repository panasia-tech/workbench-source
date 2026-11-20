from datetime import datetime

from sqlalchemy import JSON, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class LogisticsTrackEvent(Base):
    __tablename__ = "logistics_track_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    tracking_no: Mapped[str] = mapped_column(String(64), index=True)
    carrier: Mapped[str | None] = mapped_column(String(64), nullable=True)
    event_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
