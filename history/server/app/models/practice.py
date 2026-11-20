"""销售上手练习：每做完一步记一行（同一步重做覆盖），三步都有才算做完。"""
from sqlalchemy import JSON, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class StaffPractice(Base, TimestampMixin):
    __tablename__ = "staff_practice"
    __table_args__ = (UniqueConstraint("staff_id", "practice", "step", name="uq_staff_practice_step"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    practice: Mapped[str] = mapped_column(String(32))
    step: Mapped[int] = mapped_column(Integer)
    # 这一步交上来的答案，留着回看（演练数据，不碰真货）
    answer: Mapped[dict | None] = mapped_column(JSON, nullable=True)
