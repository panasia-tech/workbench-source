import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def new_uuid() -> str:
    return str(uuid.uuid4())


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Staff(Base, TimestampMixin):
    __tablename__ = "staff"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    staff_no: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    openid: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(64), default="")
    role: Mapped[str] = mapped_column(String(32), default="PURCHASER")
    shop: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 企微通讯录里的账号（UserID），验货异常等通知按它推送；没填就只有站内待办
    wecom_userid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 钉钉通讯录里的 userid。钉钉入职建号、离职删号按它认人（services/dingtalk_sync.py）；空=没关联，钉钉那边动不到这个号
    dingtalk_userid: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    # 软删除：员工行永不物理删除(采购单/销售单/出库/盘点等外键指向它，删了历史单据的"制单人"就悬空)。
    # 非空=已删。删除时同时置 status=DISABLED，因此所有按 ACTIVE 过滤的查询天然不会命中已删员工。
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
