from datetime import datetime

from sqlalchemy import DateTime, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class OaPushOutbox(Base):
    """OA/台账 MCP 推送发件箱（本 ERP 作 MCP 客户端向外部 OA 推数据）。

    - 业务事务内 `db.add` 一行（不单独 commit，随业务一起落库），commit 后再投递后台 worker；
      worker 失败重试、指数退避，断网/重启可续推 —— 不阻塞业务。
    - `dedup_key` 唯一：保证同一业务事件只入库一次（尤其 push_finance_record 服务端无防重）。
    - 时间戳走 naive UTC（应用层 datetime.utcnow），与 SalesOutbound/finance 过滤口径一致。
    """

    __tablename__ = "oa_push_outbox"
    __table_args__ = (
        UniqueConstraint("dedup_key", name="uq_oa_push_dedup_key"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # MCP 工具名：push_sale_stat / push_finance_record / sync_staff_user / push_kpi_record / push_reply_record
    tool: Mapped[str] = mapped_column(String(32), index=True)
    # 直接作为 MCP tools/call 的 arguments 原样发送
    arguments: Mapped[dict] = mapped_column(JSON)
    # 幂等键（唯一，可空）：重复入队被唯一约束拦下 → 天然防重推
    dedup_key: Mapped[str | None] = mapped_column(String(191), nullable=True)
    # PENDING / RUNNING / RETRY / SUCCEEDED / FAILED / SKIPPED / BLOCKED_NO_MAPPING
    status: Mapped[str] = mapped_column(String(24), default="PENDING", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_due_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    remote_id: Mapped[str | None] = mapped_column(String(64), nullable=True)  # OA 返回的记录 id
    # 来源业务定位（非外键，backfill 跨多表，故用松引用）
    source_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
