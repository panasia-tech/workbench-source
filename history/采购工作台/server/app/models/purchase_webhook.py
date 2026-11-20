"""采购入站 webhook 事件（inbox 模式）。

外部采购服务把采购相关数据 POST 到 /api/purchase-webhook/ingest。
本表只做「可靠收件」：验签通过后把整段原始报文原样落库，保证不丢不重；
业务解析（映射进 PurchaseOrder 等）作为独立下游步骤按 event_type 处理，
成功后回填 ref_type/ref_id/status=DONE。webhook 本身不碰采购业务表。
"""

from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.enums import PurchaseWebhookStatus
from app.models.staff import TimestampMixin, new_uuid


class PurchaseWebhookEvent(Base, TimestampMixin):
    """一次外部采购服务推送的事件。event_id 唯一 → 幂等。"""

    __tablename__ = "purchase_webhook_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # 对方提供的事件唯一 ID，幂等主键（并发下靠此唯一约束兜底）
    event_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    # 通用事件类型，先不做枚举约束（事件类型后配）
    event_type: Mapped[str] = mapped_column(String(64), default="unknown", index=True)
    # 对方声明的事件发生时间（转成 naive UTC 存）
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 存档：关键请求头（签名/时间戳/来源 UA），便于审计与重放核验
    headers: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # 存档：完整原始 body（审计 + 未来重放解析的根本依据）
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), default=PurchaseWebhookStatus.PENDING, index=True
    )
    # 解析后回填的业务实体（如 PURCHASE_ORDER + 采购单 id）
    ref_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ref_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
