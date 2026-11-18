from datetime import datetime

from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class Inspection(Base, TimestampMixin):
    __tablename__ = "inspection"
    __table_args__ = (UniqueConstraint("purchase_order_id", "piece_no", name="uq_inspection_order_piece"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    inspect_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    purchase_order_id: Mapped[str] = mapped_column(String(36), ForeignKey("purchase_order.id"), index=True)
    # 采购单的第几件（从 1 起）；一单一件的老单都是 1
    piece_no: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    action_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    inspection_result: Mapped[str | None] = mapped_column(String(32), nullable=True)
    listing_images: Mapped[list] = mapped_column(JSON, default=list)
    defect_images: Mapped[list] = mapped_column(JSON, default=list)
    defect_videos: Mapped[list] = mapped_column(JSON, default=list)
    reject_images: Mapped[list] = mapped_column(JSON, default=list)
    condition_grade: Mapped[str | None] = mapped_column(String(16), nullable=True)
    location_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    mismatch_remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    actual_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    inspector_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    inspected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 软删除：旧系统迁移占位验货单等用它隐藏(不物理删，保留行→不影响库存SKU的join)。非空=已删。
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    purchase_order = relationship("PurchaseOrder", back_populates="inspections")
