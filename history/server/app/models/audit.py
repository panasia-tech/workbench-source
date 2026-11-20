from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class AuditRun(Base, TimestampMixin):
    __tablename__ = "audit_run"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    account_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("payment_account.id"), nullable=True, index=True)
    mode: Mapped[str] = mapped_column(String(16))
    scope: Mapped[str] = mapped_column(String(16), index=True)
    match_window_hours: Mapped[int] = mapped_column(Integer, default=48)
    time_start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    time_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="RUNNING", index=True)
    summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class AuditTask(Base, TimestampMixin):
    __tablename__ = "audit_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    account_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("payment_account.id"), nullable=True, index=True)
    entity_type: Mapped[str] = mapped_column(String(16), index=True)
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    idem_key: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), index=True)


class AuditIssue(Base, TimestampMixin):
    __tablename__ = "audit_issue"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    audit_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    account_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("payment_account.id"), nullable=True)
    scope: Mapped[str] = mapped_column(String(16))
    entity_type: Mapped[str] = mapped_column(String(16), index=True)
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    audit_status: Mapped[str] = mapped_column(String(32), index=True)
    matched_txn_ids: Mapped[list] = mapped_column(JSON, default=list)
    matched_txn_refs: Mapped[list] = mapped_column(JSON, default=list)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
