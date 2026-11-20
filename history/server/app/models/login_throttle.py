from datetime import datetime

from sqlalchemy import DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class LoginThrottle(Base):
    """登录失败计数（防暴力尝试），一行 = 一把尺子上的一个对象。规则见 app/services/login_throttle.py。"""

    __tablename__ = "login_throttle"
    __table_args__ = (UniqueConstraint("scope", "subject", name="uq_login_throttle_scope_subject"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # pair = 账号+IP，ip = IP，user = 账号
    scope: Mapped[str] = mapped_column(String(8))
    subject: Mapped[str] = mapped_column(String(128))
    failures: Mapped[int] = mapped_column(Integer, default=0)
    window_start: Mapped[datetime] = mapped_column(DateTime)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 锁过几次：同账号+IP 的锁按它翻倍
    lock_count: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, index=True)
