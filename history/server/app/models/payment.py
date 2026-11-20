from datetime import datetime
from decimal import Decimal

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class PaymentAccount(Base, TimestampMixin):
    __tablename__ = "payment_account"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    account_alias: Mapped[str] = mapped_column(String(64), index=True)
    account_hint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    channel: Mapped[str] = mapped_column(String(16), index=True)
    usage: Mapped[str] = mapped_column(String(16), index=True)
    is_system_seed: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="ACTIVE", index=True)


class PaymentBinding(Base, TimestampMixin):
    __tablename__ = "payment_binding"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    account_id: Mapped[str] = mapped_column(String(36), ForeignKey("payment_account.id"), index=True)
    entity_type: Mapped[str] = mapped_column(String(16), index=True)
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    out_trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    direction: Mapped[str] = mapped_column(String(8))
    expected_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    alipay_trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True)


class PickupPayment(Base, TimestampMixin):
    """自提扫码收款单：暂存出库草稿，支付成功后自动出库。"""

    __tablename__ = "pickup_payment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    out_trade_no: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    sku_code: Mapped[str] = mapped_column(String(64), index=True)
    buyer_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sale_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    evidence_urls: Mapped[list] = mapped_column(JSON, default=list)
    express_fee: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    operator_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    subject: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # 当面付存 qr_code 串（短）；手机网站支付存整条带签名的 GET URL（可达千余字符）
    qr_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    # PENDING / PAID / DONE / EXPIRED / CANCELLED
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    alipay_trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    outbound_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("sales_outbound.id"), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PaymentTransaction(Base, TimestampMixin):
    __tablename__ = "payment_transaction"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    account_id: Mapped[str] = mapped_column(String(36), ForeignKey("payment_account.id"), index=True)
    channel: Mapped[str] = mapped_column(String(16))
    direction: Mapped[str] = mapped_column(String(8), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    counterparty_hint: Mapped[str | None] = mapped_column(String(256), nullable=True)
    out_trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    txn_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), index=True)
    source: Mapped[str] = mapped_column(String(16), default="MANUAL")
    trade_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    ingested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)
