from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class PurchaseAccount(Base):
    __tablename__ = "purchase_account"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    label: Mapped[str] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class SaleShop(Base):
    __tablename__ = "sale_shop"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    label: Mapped[str] = mapped_column(String(64))
    xianyu_user_name: Mapped[str] = mapped_column(String(64))
    # 显式绑定的群控账号 id(优先于 xianyu_user_name 按名匹配;群控侧为真源)
    gc_account_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    # 无忧卖账号级默认(店铺=闲鱼账号):发布默认按此加入无忧卖,可被 SkuShopListing.worry_free_sell 覆盖。默认关。
    worry_free_sell: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)


class WarehouseLocation(Base):
    __tablename__ = "warehouse_location"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    zone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class WarehouseTag(Base):
    """仓库筛选标签：入库时打标签；小程序列表按 tags JSON OR 匹配；AI 重绘按 prompt 应用。"""

    __tablename__ = "warehouse_tag"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_size: Mapped[str | None] = mapped_column(String(16), nullable=True)
    ai_resolution: Mapped[str | None] = mapped_column(String(8), nullable=True)


class ProductType(Base):
    """商品种类类型：入库时单选必填；每个类型带一套 AI 生图/重绘提示词。
    上架时小程序按 SKU 的 product_type 默认选中，取该类型 prompt 驱动 gpt-image-2 生图。
    与多选筛选用的 WarehouseTag 是两个概念（这里是单个必填的商品主类型）。"""

    __tablename__ = "product_type"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_size: Mapped[str | None] = mapped_column(String(16), nullable=True)
    ai_resolution: Mapped[str | None] = mapped_column(String(8), nullable=True)
