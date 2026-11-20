from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, JSON, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class SwitchOrder(Base, TimestampMixin):
    __tablename__ = "switch_order"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    switch_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    deposit_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    deposit_paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deposit_evidence_urls: Mapped[list] = mapped_column(JSON, default=list)
    final_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    final_paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    final_evidence_urls: Mapped[list] = mapped_column(JSON, default=list)
    cutoff_status: Mapped[str] = mapped_column(String(32), default="NONE")
    cutoff_applied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cutoff_reviewed_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    cutoff_remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="ACTIVE", index=True)
    evidence_urls: Mapped[list] = mapped_column(JSON, default=list)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    sales_outbound_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("sales_outbound.id"), nullable=True)
