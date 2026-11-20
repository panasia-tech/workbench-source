from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class Lawsuit(Base, TimestampMixin):
    """起诉单：对某采购单发起的诉讼，按已上传材料反推状态（证据/律师/法院/判决）。

    协作模型=全员：采购与管理员均可查看并接力整理同一张起诉单（员工接手补律师回复等）。
    """

    __tablename__ = "lawsuit"
    # 对齐被引用表 purchase_order/staff 的 utf8mb4_unicode_ci，避免外键 errno 1215
    __table_args__ = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    lawsuit_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    # 一个采购单只能有一张起诉单（DB 级唯一，兜住并发）
    purchase_order_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("purchase_order.id"), unique=True, index=True
    )
    # 四类材料，各自支持多张图片/视频；有内容即视为到达对应状态。建单第一步=证据优先
    evidence_media: Mapped[list] = mapped_column(JSON, default=list)  # 证据材料（建单必填）
    lawyer_media: Mapped[list] = mapped_column(JSON, default=list)  # 律师回复（后补）
    court_media: Mapped[list] = mapped_column(JSON, default=list)  # 法院材料
    judgment_media: Mapped[list] = mapped_column(JSON, default=list)  # 判决结果
    # 由材料反推并落库，便于列表按状态筛选/排序；写入时用 compute_status 重算
    status: Mapped[str] = mapped_column(String(32), default="DRAFT", index=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    # 协作留痕：最后一次整理（补材料）的操作人与时间
    last_action_by_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    last_action_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    def compute_status(self) -> str:
        """优先级：已判决 > 待开庭 > 已提交律师回复 > 已提交证据 > 草稿。"""
        if any(self.judgment_media or []):
            return "JUDGED"
        if any(self.court_media or []):
            return "PENDING_HEARING"
        if any(self.lawyer_media or []):
            return "SUBMITTED_LAWYER"
        if any(self.evidence_media or []):
            return "EVIDENCE_SUBMITTED"
        return "DRAFT"
