from datetime import datetime

from sqlalchemy import DateTime, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class ExpressTrackingCache(Base, TimestampMixin):
    __tablename__ = "express_tracking_cache"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    tracking_no: Mapped[str] = mapped_column(String(64), index=True)
    phone_suffix: Mapped[str] = mapped_column(String(8), default="", index=True)
    status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    msg: Mapped[str | None] = mapped_column(String(512), nullable=True)
    traces: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    queried_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
