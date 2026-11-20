from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin


class AppSetting(Base, TimestampMixin):
    """在页面上改的少量配置（键值）。

    改代码才会变的放 config.py / .env；这里放会随人、随时间变、要在界面上改的，
    比如聊天里「发送仓库位置」发出去的那段自提地址（键 pickup_address）。
    """

    __tablename__ = "app_setting"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="", nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
