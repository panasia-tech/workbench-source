from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field
from app.schemas._tz import CNDatetime


class SaleOrderCreate(BaseModel):
    platform: str | None = Field(default=None, description="来源平台")
    external_order_no: str | None = Field(default=None, description="外部平台订单号")
    buyer_name: str | None = Field(default=None, description="买家昵称")
    buyer_phone: str | None = Field(default=None, description="买家手机号")
    amount: Decimal | None = Field(default=None, description="订单金额")
    screenshot_url: str | None = Field(default=None, description="订单/付款截图URL")


class ManualDealRequest(BaseModel):
    """销售手动成交：扫码找货 → 填字段 → 一步建单+出库（线下自提/无平台订单场景）。"""

    sku_code: str = Field(description="商品货号")
    sale_price: Decimal = Field(description="销售价")
    buyer_name: str | None = Field(default=None, description="买家昵称")
    buyer_phone: str | None = Field(default=None, description="买家手机号")
    shop_name: str | None = Field(default=None, description="成交店铺名")
    tracking_no: str | None = Field(default=None, description="快递单号")
    express_fee: Decimal | None = Field(default=None, description="快递费")
    remark: str | None = Field(default=None, description="备注")
    evidence_urls: list | None = Field(default=None, description="成交凭证URL列表（图片/视频）")
    payment_screenshot_url: str | None = Field(default=None, description="收款截图URL")
    transaction_type: str | None = Field(
        default=None, description="交易方式：PICKUP=自提(0手续费) / PLATFORM=平台交易(看worry_free分1.6%/2.6%)"
    )
    worry_free: bool = Field(
        default=False, description="平台交易是否无忧卖：True=2.6% / False=普通1.6%；自提忽略"
    )
    platform_fee: Decimal | None = Field(default=None, ge=0, description="闲鱼订单页上的实际服务费（元，软件服务费+无忧卖服务费）；不知道就空着，按档估；自提忽略")


class SaleOrderOut(BaseModel):
    id: str = Field(description="销售单ID")
    order_no: str = Field(description="销售单号")
    platform: str | None = Field(description="来源平台")
    external_order_no: str | None = Field(description="外部平台订单号")
    buyer_name: str | None = Field(description="买家昵称")
    buyer_phone: str | None = Field(description="买家手机号")
    amount: Decimal | None = Field(description="订单金额")
    screenshot_url: str | None = Field(description="订单/付款截图URL")
    product_title: str | None = Field(default=None, description="商品标题")
    product_spec: str | None = Field(default=None, description="商品规格")
    shop_name: str | None = Field(default=None, description="成交店铺名")
    tracking_no: str | None = Field(default=None, description="快递单号")
    tracking_phone_suffix: str | None = Field(default=None, description="收件人手机尾号（后4位）")
    status: str = Field(description="状态：PENDING=待发货 / SHIPPED=已发货 / COMPLETED=已完成")
    created_by_id: str = Field(description="创建人ID")
    created_at: CNDatetime = Field(description="创建时间")
    shipped_at: CNDatetime | None = Field(default=None, description="发货时间")
    operator_name: str | None = Field(default=None, description="操作人姓名")
    sku_code: str | None = Field(default=None, description="商品货号")
    cover_url: str | None = Field(default=None, description="商品封面图URL")
    cover_thumb_url: str | None = Field(default=None, description="商品封面缩略图URL")
    location_images: list = Field(
        default_factory=list, description="仓库定位图：没有产品图时列表用它兜底显示"
    )

    model_config = {"from_attributes": True}


class SaleSkuMatchOut(BaseModel):
    sku_code: str = Field(description="商品货号")
    product_name: str | None = Field(description="商品名称")
    spec: str | None = Field(description="商品规格")
    location_code: str | None = Field(description="仓库定位编码")
    suggest_price: Decimal | None = Field(description="建议售价")


class SaleListResponse(BaseModel):
    items: list[SaleOrderOut] = Field(description="销售单列表")
    total: int = Field(description="总数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页数量")


class OutboundRecordOut(BaseModel):
    id: str = Field(description="出库记录ID")
    outbound_no: str = Field(description="出库单号")
    sku_id: str = Field(description="SKU ID")
    sku_code: str | None = Field(default=None, description="商品货号")
    product_name: str | None = Field(default=None, description="商品名称")
    product_spec: str | None = Field(default=None, description="商品规格")
    cover_url: str | None = Field(default=None, description="商品封面图URL")
    cover_thumb_url: str | None = Field(default=None, description="商品封面缩略图URL")
    location_images: list = Field(
        default_factory=list, description="仓库定位图：没有产品图时列表用它兜底显示"
    )
    buyer_name: str | None = Field(default=None, description="买家昵称")
    outbound_type: str = Field(
        description="出库类型：ORDER_SHIP=订单发货 / PICKUP=自提 / SWITCH=换机 / MANUAL=手动成交"
    )
    sale_price: Decimal = Field(description="销售价")
    cost_price: Decimal | None = Field(default=None, description="成本价（销售角色不可见）")
    express_fee: Decimal | None = Field(default=None, description="快递费")
    platform_fee: Decimal | None = Field(default=None, description="填过的实际服务费（没填为空）")
    fee_editable: bool = Field(default=False, description="当前用户能不能补填/改服务费")
    tracking_no: str | None = Field(default=None, description="快递单号")
    operator_name: str | None = Field(default=None, description="操作人姓名")
    has_return: bool = Field(
        default=False, description="是否已有未取消退货单（列表用于隐藏「商品退回」入口）"
    )
    created_at: CNDatetime = Field(description="出库时间")

    model_config = {"from_attributes": True}


class OutboundFeeIn(BaseModel):
    platform_fee: Decimal | None = Field(default=None, ge=0, description="闲鱼订单页上的实际服务费（元，软件服务费+无忧卖服务费）；不知道就空着，按档估；传空清掉")


class OutboundListResponse(BaseModel):
    items: list[OutboundRecordOut] = Field(description="出库记录列表")
    total: int = Field(description="总数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页数量")
