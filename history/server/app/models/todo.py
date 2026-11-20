from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class TodoTaskTemplate(Base, TimestampMixin):
    __tablename__ = "todo_task_template"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    template_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(256))
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    effective_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    remind_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    strong_remind: Mapped[bool] = mapped_column(Boolean, default=False)
    assignee_user_ids: Mapped[list] = mapped_column(JSON, default=list)
    assignee_names: Mapped[list] = mapped_column(JSON, default=list)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class TodoTaskAssignment(Base, TimestampMixin):
    __tablename__ = "todo_task_assignment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    assignment_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    task_template_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True, index=True)
    user_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    title_snapshot: Mapped[str | None] = mapped_column(String(256), nullable=True)
    content_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    remark_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    priority: Mapped[str | None] = mapped_column(String(16), nullable=True)
    effective_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    remind_visible: Mapped[bool] = mapped_column(Boolean, default=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class TodoTaskLog(Base):
    __tablename__ = "todo_task_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    template_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    assignment_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(32))
    operator_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
