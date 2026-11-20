from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field
from app.schemas._tz import CNDatetime


class SwitchOrderCreate(BaseModel):
    sku_code: str = Field(description="商品货号")
    unit_price: Decimal = Field(description="换机单价")
    evidence_urls: list[str] = Field(default_factory=list, description="切单证据URL列表")
    remark: str | None = Field(default=None, description="备注")


class SwitchDepositIn(BaseModel):
    deposit_amount: Decimal = Field(description="定金金额")
    evidence_urls: list[str] = Field(default_factory=list, description="定金收款凭证URL列表")


class SwitchFinalPaymentIn(BaseModel):
    final_amount: Decimal = Field(description="尾款金额")
    evidence_urls: list[str] = Field(default_factory=list, description="尾款收款凭证URL列表")


class SwitchCutoffApplyIn(BaseModel):
    remark: str | None = Field(default=None, description="截单申请备注")


class SwitchCutoffReviewIn(BaseModel):
    approved: bool = Field(description="是否通过截单申请")
    remark: str | None = Field(default=None, description="审批备注")


class SwitchOrderUpdate(BaseModel):
    unit_price: Decimal | None = Field(default=None, description="换机单价")
    deposit_amount: Decimal | None = Field(default=None, description="定金金额")
    final_amount: Decimal | None = Field(default=None, description="尾款金额")
    remark: str | None = Field(default=None, description="备注")


class SwitchOrderOut(BaseModel):
    id: str = Field(description="换机单ID")
    switch_no: str = Field(description="换机单号")
    sku_id: str = Field(description="SKU ID")
    sku_code: str | None = Field(default=None, description="商品货号")
    product_name: str | None = Field(default=None, description="商品名称")
    unit_price: Decimal = Field(description="换机单价")
    deposit_amount: Decimal | None = Field(description="定金金额")
    deposit_paid_at: CNDatetime | None = Field(description="定金支付时间")
    deposit_evidence_urls: list = Field(description="定金收款凭证URL列表")
    final_amount: Decimal | None = Field(description="尾款金额")
    final_paid_at: CNDatetime | None = Field(description="尾款支付时间")
    final_evidence_urls: list = Field(description="尾款收款凭证URL列表")
    cutoff_status: str = Field(
        description="截单状态：NONE=无 / PENDING=待审批 / APPROVED=已通过 / REJECTED=已驳回"
    )
    cutoff_applied_at: CNDatetime | None = Field(description="截单申请时间")
    cutoff_remark: str | None = Field(description="截单备注")
    status: str = Field(description="状态：ACTIVE=进行中 / COMPLETED=已完成 / CANCELLED=已取消")
    evidence_urls: list = Field(description="切单证据URL列表")
    remark: str | None = Field(description="备注")
    created_by_id: str = Field(description="创建人ID")
    created_at: CNDatetime = Field(description="创建时间")

    model_config = {"from_attributes": True}
