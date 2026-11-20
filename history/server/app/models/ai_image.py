from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class AiRedrawJob(Base):
    __tablename__ = "ai_redraw_job"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_code: Mapped[str] = mapped_column(String(64), index=True)
    source_image_url: Mapped[str] = mapped_column(String(512))
    tag_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prompt: Mapped[str] = mapped_column(Text)
    ai_size: Mapped[str | None] = mapped_column(String(16), nullable=True)
    ai_resolution: Mapped[str | None] = mapped_column(String(8), nullable=True)
    alapi_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    result_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    result_object_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    operator_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    poll_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
