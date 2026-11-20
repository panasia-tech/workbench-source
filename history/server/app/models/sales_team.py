"""销售协同：主管加派的任务（带状态）、买家消息转来的协同请求（60 秒没人接往上转）。规矩见 services/sales_team.py。"""
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class SalesTask(Base, TimestampMixin):
    __tablename__ = "sales_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    title: Mapped[str] = mapped_column(String(256))
    # 范围 / 边界：做到哪算完（对象、地区、品牌……），加派必须写
    scope: Mapped[str] = mapped_column(Text)
    due_at: Mapped[datetime] = mapped_column(DateTime)
    sku_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    assignee_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    state: Mapped[str] = mapped_column(String(16), default="待接收", index=True)
    wait_who: Mapped[str | None] = mapped_column(String(64), nullable=True)
    wait_why: Mapped[str | None] = mapped_column(String(256), nullable=True)
    wait_until: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 受阻原因 / 退回意见 / 交上来的结果，最近一次的
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 转交上下文：已做 / 未完成 / 下一步（改派时必写，接手人第一眼看到）
    handoff: Mapped[str | None] = mapped_column(Text, nullable=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 每一步谁在什么时候做了什么：[{at, by, action, note}]
    log: Mapped[list] = mapped_column(JSON, default=list)


class SalesCollab(Base, TimestampMixin):
    __tablename__ = "sales_collab"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    title: Mapped[str] = mapped_column(String(256))
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    sku_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    # 先找谁（会话所在号的负责人），空 = 所有在岗销售
    to_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    state: Mapped[str] = mapped_column(String(16), default="open", index=True)
    taken_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    taken_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SalesReport(Base, TimestampMixin):
    """「遇到没见过的情况」：员工写一句话，主管回复处理办法，可以记成大家都能看的规则。"""

    __tablename__ = "sales_report"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    text: Mapped[str] = mapped_column(Text)
    sku_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    # open 等主管 / answered 主管回了
    state: Mapped[str] = mapped_column(String(16), default="open", index=True)
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    answered_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 记成规则：大家在「没见过的情况」页都能看到
    is_rule: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    # 提的人看过回复没有（没看过在他的「今天」里黄着）
    seen: Mapped[bool] = mapped_column(Boolean, default=False)
