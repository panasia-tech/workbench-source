from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class AnonymousFeedback(Base, TimestampMixin):
    """匿名反馈（返工/系统反馈/投诉）。

    匿名口径=方案 B：DB 落 `created_by_id` 供受限审计，但所有对外接口一律不回传提交人。
    """

    __tablename__ = "anonymous_feedback"
    # 含外键 → staff，需与 staff 的 utf8mb4_unicode_ci 对齐，否则外键 errno 1215
    __table_args__ = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    category: Mapped[str] = mapped_column(String(32), index=True)  # REWORK / FEEDBACK / COMPLAINT
    title: Mapped[str] = mapped_column(String(128))
    target: Mapped[str | None] = mapped_column(String(128), nullable=True)  # 涉及模块/对象
    content: Mapped[str] = mapped_column(Text)
    attachments: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="OPEN", index=True)  # OPEN / IN_PROGRESS / CLOSED
    handled_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    handled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    handled_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("staff.id"), nullable=True, index=True
    )
    handled_by_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 方案 B：提交人仅供受限审计，绝不在任何对外接口序列化返回
    created_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("staff.id"), nullable=True, index=True
    )
    source: Mapped[str] = mapped_column(String(32), default="MINIPROGRAM")
