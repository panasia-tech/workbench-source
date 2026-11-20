from datetime import datetime

from sqlalchemy import DateTime, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class LegacySnapshot(Base, TimestampMixin):
    """老系统(秦丝)库存快照,只读参考数据。

    用途:仓库搜索兜底——新系统查无在库时,按老货号/序列号/名称附带查本表,
    展示「老系统历史记录」防止仓库误判商品不存在。不参与任何库存逻辑。
    """

    __tablename__ = "legacy_snapshot"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # 快照来源记录 _id,幂等键
    legacy_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # 老系统货号(goodsNo/goodsCode/itemNo 同值,如 69018875)
    goods_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    product_name: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 老系统序列号字段(serialNo)与条码(barCode/sn),两者都可能是实物序列号
    serial_no: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    barcode: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    cover_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    location: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 老系统在库状态:IN_STOCK / OUT_STOCK
    status: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    qty: Mapped[int] = mapped_column(Integer, default=0)
    purchase_price_fen: Mapped[int | None] = mapped_column(Integer, nullable=True)
    inbound_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    source_system: Mapped[str | None] = mapped_column(String(32), nullable=True)
    legacy_tag: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 已迁入新系统的对应 sku_code(导入时按 sku_code/barcode 匹配回填),空=未迁移
    migrated_sku_code: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)
