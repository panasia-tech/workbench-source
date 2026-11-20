"""采购议价会话状态机（W07 / PC-088 / PC-090）：识别 → 报价 → 还价 → 谈妥。

和到货后的 negotiation_task（验货瑕疵议价）分开：这里管下单前跟卖家聊价。
"""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


# IDENTIFY 识别 → QUOTE 报价 → COUNTER 还价 → DEAL 谈妥
# PAUSING 暂停请求待确认 → PAUSED 已暂停 / CLOSED 结束（未成交）
BARGAIN_STATES = ("IDENTIFY", "QUOTE", "COUNTER", "DEAL", "PAUSING", "PAUSED", "CLOSED")

# 必要问题状态（PC-090）：PENDING 待核 / DECLARED 卖家已声明(PC-089 不再追问) / VERIFIED 已核对 / SKIPPED 本次跳过
CHECK_STATUSES = ("PENDING", "DECLARED", "VERIFIED", "SKIPPED")


class BargainSession(Base, TimestampMixin):
    __tablename__ = "bargain_session"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # 会话身份：采购账号 + 卖家 + 平台商品（可先只有 item_id）
    platform: Mapped[str] = mapped_column(String(32), nullable=False, default="xianyu", server_default="xianyu")
    platform_item_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    purchase_account: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    seller_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 群控会话（可选，跨库只记 id）
    gc_conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # 商品快照 / 采购单（谈妥后可绑）
    snapshot_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("purchase_item_snapshot.id"), nullable=True)
    purchase_order_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("purchase_order.id"), nullable=True, index=True)

    state: Mapped[str] = mapped_column(String(16), nullable=False, default="IDENTIFY", server_default="IDENTIFY", index=True)
    # 暂停前状态，恢复时回到这里
    paused_from: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # 当前有效价：我方最新报价 / 卖家最新还价 / 谈妥价
    our_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    their_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    deal_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    listed_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True, comment="开聊时页面标价")
    title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 轮次事件：[{at, from, to, action, price, by, note}]
    events: Mapped[list] = mapped_column(JSON, default=list)
    # 必要问题待核（PC-090）：[{key,title,required,status,note,updated_at,by}]
    checks: Mapped[list | None] = mapped_column(JSON, nullable=True)
    round_no: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    identified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    quoted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    dealt_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    paused_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    assignee_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
