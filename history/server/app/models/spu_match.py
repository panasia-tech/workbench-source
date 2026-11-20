from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class SkuSpuMatch(Base, TimestampMixin):
    """一件在库货认定属于哪个仓库 SPU：员工对照候选确认、管理员验收。一件货一行，存当前状态。

    系统按 69码 → 品牌+型号 → 型号 现算的结果（services/spu_resolve.py）只是候选；
    验收通过（CONFIRMED）后，现算一律让位于这里认定的 SPU。改挂、退回、补正都记在 SkuSpuMatchLog。
    """

    __tablename__ = "sku_spu_match"

    # CHECKING 待核实（冲突，员工还没定）/ SUBMITTED 待验收 / NO_MATCH 报了找不到，待验收
    # RETURNED 验收退回待补正 / CONFIRMED 验收通过
    CHECKING = "CHECKING"
    SUBMITTED = "SUBMITTED"
    NO_MATCH = "NO_MATCH"
    RETURNED = "RETURNED"
    CONFIRMED = "CONFIRMED"
    WAITING_REVIEW = (SUBMITTED, NO_MATCH)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), unique=True, index=True)
    # 空=报的是「找不到对应商品」。不设外键（同 sku_auto_listing）：SPU 目录是可维护的主数据，
    # 删了一款时这里指向的 SPU 查不到，按「要重新匹配」处理
    spu_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default=CHECKING, index=True)
    # 员工的依据：说明 + 照片（铭牌、配置页、条码）
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    media: Mapped[list] = mapped_column(JSON, default=list)
    submitted_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 退回原因 + 可选附件（标注截图、对照说明），员工按项补正
    return_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    return_media: Mapped[list] = mapped_column(JSON, default=list)
    version: Mapped[int] = mapped_column(Integer, default=1)


class SkuSpuMatchLog(Base):
    """匹配的每一步：提交、报找不到、通过、退回、改挂。记前后 SPU、状态和经办人。"""

    __tablename__ = "sku_spu_match_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    # 同一件货第几步。created_at 只到秒，连着点几下会同秒，排序靠它
    seq: Mapped[int] = mapped_column(Integer, default=1)
    action: Mapped[str] = mapped_column(String(16))  # SUBMIT / REPORT / APPROVE / RETURN / CHANGE
    from_spu_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    to_spu_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    from_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    to_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    media: Mapped[list] = mapped_column(JSON, default=list)
    staff_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)


class GuideQuizResult(Base):
    """新员工教程（panasia.fun/guide/）的复验小测：谁、哪天、对了几题、每题选了什么。判分在服务端。"""

    __tablename__ = "guide_quiz_result"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    staff_id: Mapped[str] = mapped_column(String(36), index=True)
    score: Mapped[int] = mapped_column(Integer)
    total: Mapped[int] = mapped_column(Integer)
    answers: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
