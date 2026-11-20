import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class DailyBill(Base):
    __tablename__ = "daily_bill"
    # 一个户一天一份：alipay_id 是台账里的支付宝，空串 = ERP 自提收款那个支付宝（审计报告第 10 条，迁移 125）
    __table_args__ = (UniqueConstraint("alipay_id", "bill_date", name="uq_daily_bill_account_date"),)

    # 不用 TimestampMixin：建表漏了 server_default（迁移054补兜底），且本库时区 CST 下
    # DB 默认值是北京时间，本表展示走 utc_to_cn_iso，应用层显式写 utcnow。
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    bill_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    alipay_id: Mapped[str] = mapped_column(String(36), nullable=False, default="", server_default="")
    file_url: Mapped[str] = mapped_column(String(512), nullable=False)
    file_name: Mapped[str] = mapped_column(String(256), nullable=False)
    uploaded_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), nullable=False)
