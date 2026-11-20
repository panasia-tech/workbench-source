from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field
from app.schemas._tz import CNDatetime


class PickupPaymentCreate(BaseModel):
    sku_code: str = Field(description="商品货号")
    buyer_name: str | None = Field(default=None, description="买家昵称")
    sale_price: Decimal = Field(description="销售价")
    evidence_urls: list[str] = Field(default=[], description="成交凭证URL列表")
    express_fee: Decimal | None = Field(default=None, description="快递费")
    remark: str | None = Field(default=None, description="备注")


class PickupPaymentOut(BaseModel):
    out_trade_no: str = Field(description="商户订单号")
    sku_code: str = Field(description="商品货号")
    sale_price: Decimal = Field(description="销售价")
    subject: str | None = Field(default=None, description="收款单标题（支付宝subject）")
    qr_code: str | None = Field(default=None, description="支付宝收款二维码链接")
    qr_image: str | None = Field(
        default=None, description="收款二维码图片：PNG的base64 data URI，前端直接<image>"
    )
    status: str = Field(
        description="状态：PENDING=待支付 / PAID=已支付 / DONE=已出库 / EXPIRED=已过期 / CANCELLED=已取消"
    )
    alipay_trade_no: str | None = Field(default=None, description="支付宝交易号")
    outbound_id: str | None = Field(default=None, description="出库记录ID（支付成功后自动出库生成）")
    expires_at: CNDatetime = Field(description="二维码过期时间")
    paid_at: CNDatetime | None = Field(default=None, description="支付时间")

    class Config:
        from_attributes = True


class PickupPaymentListItem(BaseModel):
    """对账用行：一行即「一张收款单 ↔ 一笔支付宝交易 ↔ 一张出库单」。"""

    out_trade_no: str = Field(description="商户订单号")
    alipay_trade_no: str | None = Field(default=None, description="支付宝交易号")
    sku_code: str = Field(description="商品货号")
    buyer_name: str | None = Field(default=None, description="买家昵称")
    sale_price: Decimal = Field(description="应收金额")
    status: str = Field(
        description="PENDING=待支付 / PAID=已支付 / DONE=已出库 / EXPIRED=已过期 / "
        "CANCELLED=已取消 / MISMATCH=金额或收款方不符待人工"
    )
    outbound_no: str | None = Field(default=None, description="出库单号")
    operator_name: str | None = Field(default=None, description="操作人")
    remark: str | None = Field(default=None, description="备注（校验不通过时含异常原因）")
    created_at: CNDatetime = Field(description="创建时间")
    paid_at: CNDatetime | None = Field(default=None, description="支付时间")


class PickupPaymentList(BaseModel):
    items: list[PickupPaymentListItem] = Field(description="收款单列表")
    total: int = Field(description="总数")
