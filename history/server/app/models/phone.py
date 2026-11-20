from datetime import date

from sqlalchemy import Date, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class PhoneNumber(Base, TimestampMixin):
    """手机号管理：姓名/号码/ICCID/运营商/开通时间/套餐/闲鱼会员名/备注的简单台账。"""

    __tablename__ = "phone_number"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # 归属员工：员工只能看/管自己的号码，管理员看全部；历史数据为 NULL 仅管理员可见
    owner_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(64))
    activation_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    carrier: Mapped[str | None] = mapped_column(String(32), nullable=True)
    plan_details: Mapped[str | None] = mapped_column(Text, nullable=True)
    phone_number: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    iccid: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    xianyu_member_name: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
