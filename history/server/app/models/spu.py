from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class WarehouseSpu(Base, TimestampMixin):
    """仓库 SPU 主表：一条 = 一个「品牌+型号」款式，唯一键是 SPU 编码。

    与 `Sku.spu`（69码查条码库返回的原始 JSON）完全是两回事：那是单件商品查到的
    商品信息快照，这里是人工维护的仓库款式档案，用来把各处零散的 SKU 编码归一到同一款。

    注意「品牌+型号」不唯一：同款不同批次/渠道可能各有 SPU 编码
    （如「盛色 N50PRO6」在清单里有 3 个 SPU 编码），所以唯一约束只加在 spu_code 上。
    """

    __tablename__ = "warehouse_spu"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # SPU 编码：清单里有 69码(EAN-13)、8 位内部码(9000xxxx)两种形态，统一按字符串存
    spu_code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    brand: Mapped[str] = mapped_column(String(64), index=True)
    # 型号：导入时按「品牌+型号」的第一个空格拆分，无空格的（如「音响」）只有品牌、型号为空
    model: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    # 影响报价的配置和地区后缀（如「8+256G 国行」）。同品牌同型号有多个 SPU 时靠它和编码区分，员工匹配时对照着看
    spec: Mapped[str | None] = mapped_column(String(128), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1", nullable=False, index=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    skus: Mapped[list["WarehouseSpuSku"]] = relationship(
        back_populates="spu",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="WarehouseSpuSku.sku_code",
    )

    @property
    def brand_model(self) -> str:
        """清单里的「品牌+型号」展示名（导出/前端展示用，不落库）。"""
        return f"{self.brand} {self.model}" if self.model else self.brand


class WarehouseSpuSku(Base):
    """SPU-SKU 对应：一条 = 一个仓库/WMS 侧的 SKU 编码挂在哪个 SPU 下。

    sku_code 全局唯一——一个 SKU 编码只能属于一个 SPU，这正是这张对照表的意义所在；
    重复挂载就说明清单本身有冲突，宁可导入报错也不能静默产生两条对应。
    编码形态很杂（513211540009 / 69019368 / WMSPOPO2026… / HZKKDN00042 / TMP-012，
    甚至有直接写商品名的），所以不做格式校验，只做去空白与唯一性。

    与 ERP 自己的 `sku.sku_code`（M20260907-001 一物一码）不是一回事，故不设外键。
    """

    __tablename__ = "warehouse_spu_sku"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    spu_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("warehouse_spu.id", ondelete="CASCADE"), index=True
    )
    sku_code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    spu: Mapped["WarehouseSpu"] = relationship(back_populates="skus")
