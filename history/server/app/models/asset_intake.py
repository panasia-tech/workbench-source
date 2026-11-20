from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class AssetIntake(Base, TimestampMixin):
    """资产录入：员工把别的系统里的电脑、显示器手工录成在库商品，拿来变卖。

    一条录入对应一件 SKU（占位采购单/验货单的写法同手动入库，见 services/manual_sku.py）。
    跟「我的 → 资产管理」(asset_device，员工登记自己在用的设备) 是两回事。
    """

    __tablename__ = "asset_intake"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), unique=True, index=True)
    # 来源系统里的资产编号，对账用；同一编号再录会提醒，确认后放行
    source_asset_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # 内部备注，不给买家看（占位采购单 remark 里也抄一份，后台看采购单时能看到）
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    entered_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
