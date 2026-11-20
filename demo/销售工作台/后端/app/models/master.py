from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class SaleShop(Base):
    __tablename__ = "sale_shop"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    label: Mapped[str] = mapped_column(String(64))
    xianyu_user_name: Mapped[str] = mapped_column(String(64))
    # 显式绑定的群控账号 id(优先于 xianyu_user_name 按名匹配;群控侧为真源)
    gc_account_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    ship_province: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ship_city: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ship_district: Mapped[int | None] = mapped_column(Integer, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    # 无忧卖账号级默认(店铺=闲鱼账号):发布默认按此加入无忧卖,可被 SkuShopListing.worry_free_sell 覆盖。默认关。
    worry_free_sell: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)
