from datetime import date

from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


class PhoneNumberCreate(BaseModel):
    name: str = Field(description="姓名")
    activation_date: date | None = Field(default=None, description="开通时间")
    carrier: str | None = Field(default=None, description="运营商")
    plan_details: str | None = Field(default=None, description="套餐详情")
    phone_number: str = Field(description="手机号码")
    iccid: str | None = Field(default=None, description="ICCID（SIM 卡号）")
    xianyu_member_name: str | None = Field(default=None, description="闲鱼会员名")
    remark: str | None = Field(default=None, description="备注")


class PhoneNumberUpdate(BaseModel):
    name: str | None = Field(default=None, description="姓名")
    activation_date: date | None = Field(default=None, description="开通时间")
    carrier: str | None = Field(default=None, description="运营商")
    plan_details: str | None = Field(default=None, description="套餐详情")
    phone_number: str | None = Field(default=None, description="手机号码")
    iccid: str | None = Field(default=None, description="ICCID（SIM 卡号）")
    xianyu_member_name: str | None = Field(default=None, description="闲鱼会员名")
    remark: str | None = Field(default=None, description="备注")


class PhoneNumberOut(BaseModel):
    id: str = Field(description="主键 ID")
    owner_id: str | None = Field(default=None, description="归属员工 ID")
    name: str = Field(description="姓名")
    activation_date: date | None = Field(default=None, description="开通时间")
    carrier: str | None = Field(default=None, description="运营商")
    plan_details: str | None = Field(default=None, description="套餐详情")
    phone_number: str = Field(description="手机号码")
    iccid: str | None = Field(default=None, description="ICCID（SIM 卡号）")
    xianyu_member_name: str | None = Field(default=None, description="闲鱼会员名")
    remark: str | None = Field(default=None, description="备注")
    created_at: CNDatetime = Field(description="创建时间")
    updated_at: CNDatetime = Field(description="更新时间")

    model_config = {"from_attributes": True}


class PhoneNumberListResponse(BaseModel):
    items: list[PhoneNumberOut] = Field(description="手机号列表")
    total: int = Field(description="总数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页条数")
