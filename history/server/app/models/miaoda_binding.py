from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin


class MiaodaBinding(Base, TimestampMixin):
    """员工工作台账号 → ERP 账号，确认过是本人的那条。

    工作台「我的 → ERP 账号绑定」妙搭时期是员工自己填账号 ID，那边不做任何校验。ERP 要是直接信它，
    谁在工作台填上管理员账号就能免密进来。所以同一个工作台账号第一次进来要输一次这个 ERP
    账号的密码，确认过的记在这里，之后再进就免登录。工作台搬出妙搭后，工作台担保了（verify 回
    erpVerified=true）、工作台用户 ID 就是这个 ERP 员工 ID 的，第一次进来直接记一条，不用输密码。
    见 routers/auth.py 的 miaoda_*。
    """

    __tablename__ = "miaoda_binding"

    # 工作台侧员工 ID（verify 返回的 miaodaUserId）
    miaoda_user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    last_entry_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
