"""采购工作台 W06：公司内部采购价格表。

一条 = 一个型号（品牌 + 型号 + 规格）在一种配件组合下的一版价格：首报、目标、最高三栏分开，空着就是「待定」。
改价不改原行，新加一版、旧版记下被谁替掉；采购单下单时锁住当时那一版（purchase_order.price_rule_id），后来调表不影响旧单。
"""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class PurchasePriceRule(Base):
    __tablename__ = "purchase_price_rule"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # 同一个型号 + 配件组合的各版共用一个 key（归一化后的「品牌|型号|规格|配件」）
    rule_key: Mapped[str] = mapped_column(String(255), index=True)
    brand: Mapped[str] = mapped_column(String(64))
    model: Mapped[str] = mapped_column(String(128))
    spec: Mapped[str | None] = mapped_column(String(128), nullable=True)
    accessory: Mapped[str] = mapped_column(String(32), default="unit")
    first_offer: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    target: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    ceiling: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    effective_from: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # 被新一版替掉的时间；空 = 现在生效
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    source: Mapped[str | None] = mapped_column(String(128), nullable=True)  # 依据：老板定的 / 某次行情……
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
