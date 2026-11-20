from pydantic import BaseModel, Field


class SlotItemOut(BaseModel):
    sku_id: str
    sku_code: str
    short_code: str | None = Field(default=None, description="上架编码")
    grade: str = Field(description="成色文案；没填为空")
    location_code: str | None = None
    cover: str | None = Field(default=None, description="首张实拍缩略图（签名 URL）")


class SlotOut(BaseModel):
    key: str = Field(description="new / 9 / 8 / 7 / 6 / none（未定级）")
    label: str
    count: int
    cover: str | None = None
    items: list[SlotItemOut] = []


class SpuBriefOut(BaseModel):
    id: str
    name: str


class ChatItemFactsOut(BaseModel):
    """会话那件货给商品卡用的：成色和几个标签。"""
    sku_code: str
    grade: str
    tags: list[str] = []


class SkuSlotsOut(BaseModel):
    spu: SpuBriefOut | None = None
    item: ChatItemFactsOut | None = None
    slots: list[SlotOut]


class MediaOut(BaseModel):
    type: str = Field(description="image / video")
    url: str = Field(description="原图 / 原视频（签名 URL，24 小时）")
    thumb: str | None = Field(default=None, description="缩略图；视频是截帧封面")
    duration: int | None = Field(default=None, description="视频秒数，不知道为空")


class SkuMediaOut(BaseModel):
    sku_code: str
    product_name: str
    grade: str
    location_code: str | None = None
    short_code: str | None = None
    price: str | None = Field(default=None, description="上架信息里的售价，发商品时带给买家；没填为空")
    media: list[MediaOut]
    # 聊天商品卡/站内商品详情用：同一货号下的完整展示字段
    brand: str | None = None
    model: str | None = None
    sku_status: str | None = Field(default=None, description="SKU 状态 IN_STOCK / RESERVED / ...")
    state_label: str | None = Field(default=None, description="给员工看的在售状态：在售 / 在库 / 锁单 ...")
    on_sale: bool = Field(default=False, description="是否有已上架 LISTED 的店铺")
    on_shelf_count: int = Field(default=0, description="在架店铺数")
    listing_status: str | None = None
    description: str | None = Field(default=None, description="上架信息里的商品描述")
    config: str | None = Field(default=None, description="规格/电脑配置")
    remark: str | None = Field(default=None, description="备注")
    missing: list[str] = Field(default_factory=list, description="缺失字段：image/name/price/grade/location/description/config/remark")


class PickupAddressIn(BaseModel):
    text: str = Field(max_length=300, description="发给买家的自提地址原文；空字符串 = 清掉")


class PickupAddressOut(BaseModel):
    pickup_address: str
