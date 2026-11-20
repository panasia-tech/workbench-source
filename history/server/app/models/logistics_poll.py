from datetime import datetime

from sqlalchemy import DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class LogisticsPollTask(Base, TimestampMixin):
    """物流轮询任务:已发货单据的轨迹跟踪,签收后自动完结订单。

    state:
      ACTIVE     正常轮询中
      NEED_PHONE 顺丰等需要收件人手机尾号,等待人工补全
      DELIVERED  已签收,任务完结
      EXCEPTION  拒收/退回/异常,进人工核查
      EXPIRED    发货超期未签收,停止轮询,进人工核查
    """

    __tablename__ = "logistics_poll_task"
    __table_args__ = (UniqueConstraint("entity_type", "entity_id", "tracking_no", name="uq_poll_entity_tracking"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    entity_type: Mapped[str] = mapped_column(String(32), index=True)  # SALE_ORDER / PURCHASE_ORDER / SWITCH_ORDER
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    order_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tracking_no: Mapped[str] = mapped_column(String(64), index=True)
    phone_suffix: Mapped[str | None] = mapped_column(String(8), nullable=True)
    state: Mapped[str] = mapped_column(String(16), default="ACTIVE", index=True)
    streak: Mapped[int] = mapped_column(Integer, default=0)
    query_count: Mapped[int] = mapped_column(Integer, default=0)
    next_due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    last_status: Mapped[str | None] = mapped_column(String(512), nullable=True)
    last_event_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(String(256), nullable=True)
