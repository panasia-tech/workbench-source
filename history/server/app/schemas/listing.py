from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field
from app.schemas._tz import CNDatetime


class ListingInfoOut(BaseModel):
    sku_id: str = Field(description="SKU ID")
    sku_code: str = Field(description="SKU 编码")
    short_code: str | None = Field(default=None, description="上架短编码(内部标识,不再嵌入标题)")
    product_name: str = Field(description="商品名称")
    title: str | None = Field(description="闲鱼标题")
    desc: str | None = Field(description="商品描述")
    price: Decimal | None = Field(description="售价")
    original_price: Decimal | None = Field(description="原价/划线价")
    express_fee: Decimal | None = Field(description="运费")
    images: list[str] = Field(description="商品图片 URL 列表")
    stuff_status: int | None = Field(description="成色状态码")
    status: str = Field(description="上架信息状态 DRAFT/READY/CREATED/PUBLISHING/PUBLISHED/FAILED")
    cover_url: str | None = Field(default=None, description="封面图 URL")
    location_images: list = Field(default_factory=list, description="仓库定位图:没有产品图时列表用它兜底显示")
    suggest_price: Decimal | None = Field(default=None, description="按成本估算的建议售价")
    ai_image_unconfirmed: bool = Field(default=False, description="images 是 AI 按型号生成的、待人确认(没有同款实拍图可参考);确认前不自动上架")

    model_config = {"from_attributes": True}


class ListingInfoUpdate(BaseModel):
    title: str = Field(description="闲鱼标题")
    desc: str | None = Field(default=None, description="商品描述")
    price: Decimal = Field(description="售价")
    original_price: Decimal | None = Field(default=None, description="原价/划线价")
    express_fee: Decimal | None = Field(default=None, description="运费")
    images: list[str] = Field(default_factory=list, description="商品图片 URL 列表")
    stuff_status: int | None = Field(default=None, description="成色状态码")


class ListingPendingItem(BaseModel):
    sku_id: str = Field(description="SKU ID")
    sku_code: str = Field(description="SKU 编码")
    short_code: str | None = Field(default=None, description="上架短编码(内部标识,不再嵌入标题)")
    product_name: str = Field(description="商品名称")
    cover_url: str | None = Field(description="封面图 URL")
    location_images: list = Field(default_factory=list, description="仓库定位图:没有产品图时列表用它兜底显示")
    inbound_at: CNDatetime | None = Field(description="入库时间")
    listing_status: str | None = Field(description="上架信息状态 DRAFT/READY/CREATED/PUBLISHING/PUBLISHED/FAILED")


class ShopListingOut(BaseModel):
    shop_id: str = Field(description="店铺 ID")
    shop_code: str = Field(description="店铺编码")
    shop_label: str = Field(description="店铺名称")
    publish_status: str = Field(description="店铺上架状态 PENDING/LISTING/LISTED/SOLD/DELISTED/FAILED")
    sold_at: CNDatetime | None = Field(description="售出时间")
    delisted_at: CNDatetime | None = Field(description="下架时间")
    last_error: str | None = Field(description="最近一次错误信息")
    gc_pending: bool = Field(default=False, description="新群控异步:该店铺行有在途 gc 作业(未收敛);LISTED+gc_pending 即下架处理中,用于小程序区分在架(稳定)与下架中/上架处理中")
    ai_image_pending: bool = Field(default=False, description="货没有商品图,正在 AI 生成主图,出图后自动上架(此时 publish_status=LISTING)")
    ai_image_awaiting_confirm: bool = Field(default=False, description="AI 主图已按型号生成、等人确认;确认后自动上架")
    worry_free_sell: bool = Field(default=False, description="该店铺此商品无忧卖有效值(格子覆盖→账号默认→False),小程序开关回显用")
    device_kind: str | None = Field(default=None, description="店铺绑定群控账号当前激活设备的类型 android(手机)/browser(AdsPower 浏览器);未绑设备或 gc 不可达为 None")


class StockAgeInfo(BaseModel):
    target_days: int = Field(description="目标周转天数")
    clearance_days: int = Field(description="清仓启动天数")
    max_days: int = Field(description="最长库龄天数，超过算滞销")
    inbound_at: str | None = Field(description="入库时间（北京时间）")
    days: int = Field(description="在库天数")
    stage: str = Field(description="normal 正常 / clearance 该清仓 / stale 滞销")
    stage_label: str = Field(description="阶段文字")


class AutoRefreshInfo(BaseModel):
    enabled: bool = Field(description="定时焕新总开关是否开着")
    ledger_ok: bool = Field(description="群控账本查到了没有")
    paused: bool = Field(description="这件货是否暂停")
    not_before: str | None = Field(description="推迟到这天（北京时间）再上架")
    cycle_days: int = Field(description="上架周期（天）")
    last_at: str | None = Field(description="最近一次上架时间")
    last_ago_days: int | None = Field(description="距最近一次上架几天")
    next_at: str | None = Field(description="最早下次上架时间")
    next_in_days: int | None = Field(description="距下次上架几天")


class StockAgeShop(BaseModel):
    shop_id: str = Field(description="店铺 ID")
    last_label: str | None = Field(description="上次上架 / 上次下架 / 旧链接已删")
    last_at: str | None = Field(description="对应时间")
    next_at: str | None = Field(description="最早下次上架时间")
    next_in_days: int | None = Field(description="距下次上架几天")
    note: str | None = Field(description="现在不能重新上架的原因")
    can_refresh: bool = Field(description="现在能不能手动重新上架")


class StockAgeOut(BaseModel):
    stock_age: StockAgeInfo
    auto_refresh: AutoRefreshInfo
    shops: list[StockAgeShop]


class StockAgeThresholdsIn(BaseModel):
    target_days: int = Field(description="目标周转天数")
    clearance_days: int = Field(description="清仓启动天数")
    max_days: int = Field(description="最长库龄天数")


class AutoRefreshSet(BaseModel):
    """只改请求里出现的字段；not_before 传 null 是取消推迟。"""

    paused: bool | None = Field(default=None, description="是否暂停")
    not_before: date | None = Field(default=None, description="推迟到这天（北京时间）")


class RefreshNowRequest(BaseModel):
    shop_ids: list[str] | None = Field(default=None, description="只做这些店铺；不传是全部")


class AiImageRegenerateRequest(BaseModel):
    hint: str = Field(default="", max_length=20, description="补一句品类(如「显示器」),拼在型号前面再生成")


class PublishRequest(BaseModel):
    """不传 sale_shop_ids 或传 null 表示上架全部可上架店铺（非在架、非已售）。"""
    sale_shop_ids: list[str] | None = Field(default=None, description="指定上架的销售店铺 ID 列表;为空/null 表示全部可上架店铺")
    shop_images: dict[str, list[str]] | None = Field(
        default=None, description="员工按店铺挑的图:店铺 ID → 图(取自 image-options);店铺之间不能重复")


class DelistRequest(BaseModel):
    """不传 sale_shop_ids 或传 null 表示下架全部在架店铺。"""
    sale_shop_ids: list[str] | None = Field(default=None, description="指定下架的销售店铺 ID 列表;为空/null 表示全部在架店铺")


class ShopImagesSet(BaseModel):
    images: list[str] = Field(default_factory=list, description="这个号用的图(按顺序,第一张是主图);空 = 回到公用那组")


class ImageMaterialSet(BaseModel):
    """素材分池:把一张候选图标成淘汰(要写原因)或改回可用。"""
    url: str = Field(min_length=1, max_length=1024, description="图的地址(带不带签名都行)")
    status: Literal["usable", "rejected"] = Field(description="usable 可用 / rejected 淘汰")
    reason: str | None = Field(default=None, max_length=200, description="淘汰原因,淘汰时必填")


class WorryFreeSet(BaseModel):
    """设置某(商品×店铺)的无忧卖覆盖。None=清除覆盖,回落账号默认。"""
    worry_free_sell: bool | None = Field(default=None, description="True/False=显式覆盖;None=清除,继承账号默认")
