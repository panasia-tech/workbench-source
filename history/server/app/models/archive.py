from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class ArchiveBatch(Base):
    __tablename__ = "archive_batch"

    # 不用 TimestampMixin：建表漏了 server_default（迁移054补兜底），且本库时区 CST 下
    # DB 默认值是北京时间，本表展示按 naive UTC 口径(CNDatetime)，应用层显式写 utcnow。
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    batch_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    order_count: Mapped[int] = mapped_column(Integer, default=0)
    file_count: Mapped[int] = mapped_column(Integer, default=0)
    package_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    package_object_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    fc_request_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    packed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    oss_deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ArchiveOrder(Base):
    __tablename__ = "archive_order"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    batch_id: Mapped[str] = mapped_column(String(36), ForeignKey("archive_batch.id"), index=True)
    purchase_order_id: Mapped[str] = mapped_column(String(36), ForeignKey("purchase_order.id"), index=True)
    order_no: Mapped[str] = mapped_column(String(32), index=True)
    file_count: Mapped[int] = mapped_column(Integer, default=0)
    object_keys: Mapped[list] = mapped_column(JSON, default=list)
    media_bindings: Mapped[list] = mapped_column(JSON, default=list)
    oss_deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
