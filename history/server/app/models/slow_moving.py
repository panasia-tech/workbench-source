from sqlalchemy import JSON, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class SlowMovingRestockRecord(Base, TimestampMixin):
    __tablename__ = "slow_moving_restock_record"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    action_type: Mapped[str] = mapped_column(String(16), index=True)
    action_result: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(16), index=True)
    status_text: Mapped[str | None] = mapped_column(String(64), nullable=True)
    record_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    target_key: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    task_model_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    days_in_stock: Mapped[int | None] = mapped_column(Integer, nullable=True)
    goods_code: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    product_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    location: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sn: Mapped[str | None] = mapped_column(String(128), nullable=True)
    cover: Mapped[str | None] = mapped_column(String(512), nullable=True)
    proof_image: Mapped[str | None] = mapped_column(String(512), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    transition_reason: Mapped[str | None] = mapped_column(String(256), nullable=True)
    item_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    legacy_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    purchase_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    updated_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
