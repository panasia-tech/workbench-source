from datetime import datetime
from decimal import Decimal

from sqlalchemy import JSON, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class PriceAdjustment(Base, TimestampMixin):
    __tablename__ = "price_adjustment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    adjustment_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    adjustment_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    biz_type: Mapped[str] = mapped_column(String(16), index=True)
    reason_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reason_text: Mapped[str | None] = mapped_column(String(256), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="pending_review", index=True)
    risk_level: Mapped[str | None] = mapped_column(String(16), nullable=True)
    currency: Mapped[str] = mapped_column(String(8), default="CNY")
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))

    goods_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    item_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    item_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    product_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    product_model: Mapped[str | None] = mapped_column(String(128), nullable=True)

    customer_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sales_order_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    sales_order_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sales_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    purchase_order_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    purchase_order_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    purchase_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)

    alipay_txn_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    out_trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    evidence_files: Mapped[list] = mapped_column(JSON, default=list)
    handling_remark: Mapped[str | None] = mapped_column(Text, nullable=True)

    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    paid_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewed_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancelled_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    cancelled_reason: Mapped[str | None] = mapped_column(String(256), nullable=True)
    failed_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    rejected_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    duplicate_signature: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    legacy_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_summary: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class PriceAdjustmentLog(Base):
    __tablename__ = "price_adjustment_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    adjustment_id: Mapped[str] = mapped_column(String(36), ForeignKey("price_adjustment.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(32))
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    operator_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
