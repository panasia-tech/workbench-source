from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.schemas._tz import CNDatetime

# 账号种类(预设 8 种)
ACCOUNT_TYPES = ["个人1", "个人2", "企业1", "企业2", "企业3", "企业4", "企业5", "企业6"]

# 异常处理策略(多选纯标签)
EXCEPTION_STRATEGIES = {
    "FACE_SCAN": "法人扫脸",
    "BAD_REGISTER": "不当注册",
    "NETWORK_DOWN": "断网(续费软路由和话费充值)",
}


class GcAccountProfileUpdate(BaseModel):
    """员工手填字段 + member_name(App 读不到时的手填兜底)。采集字段(SN/IMEI 等)不允许手改。"""
    member_name: str | None = Field(default=None, description="闲鱼会员名(tb 开头)")
    carrier: str | None = Field(default=None, description="运营商")
    plan_details: str | None = Field(default=None, description="套餐资费")
    legal_person: str | None = Field(default=None, description="法人名称")
    account_type: str | None = Field(default=None, description="账号种类(个人1/个人2/企业1~6)")
    remark: str | None = Field(default=None, description="备注")
    exception_strategies: list[str] | None = Field(default=None, description="异常处理策略多选")

    @field_validator("account_type")
    @classmethod
    def _check_type(cls, v: str | None) -> str | None:
        if v is not None and v not in ACCOUNT_TYPES:
            raise ValueError(f"账号种类必须是:{'/'.join(ACCOUNT_TYPES)}")
        return v

    @field_validator("exception_strategies")
    @classmethod
    def _check_strategies(cls, v: list[str] | None) -> list[str] | None:
        if v is not None:
            bad = [s for s in v if s not in EXCEPTION_STRATEGIES]
            if bad:
                raise ValueError(f"未知异常策略:{bad}")
        return v


class GcAccountProfileOut(BaseModel):
    id: str
    gc_account_id: str = Field(description="gc 账号 ID")
    nick: str = Field(description="闲鱼昵称")
    member_name: str | None = Field(default=None, description="闲鱼会员名(tb 开头)")
    gc_device_id: str | None = Field(default=None, description="当前激活设备(gc 侧)")
    device_serial: str | None = Field(default=None, description="设备序列号")
    imei1: str | None = None
    imei2: str | None = None
    phone_number: str | None = Field(default=None, description="电话号码")
    asset_device_id: str | None = Field(default=None, description="关联资产设备 ID")
    asset_no: str | None = Field(default=None, description="关联资产编号")
    carrier: str | None = Field(default=None, description="运营商")
    plan_details: str | None = Field(default=None, description="套餐资费")
    legal_person: str | None = Field(default=None, description="法人名称")
    account_type: str | None = Field(default=None, description="账号种类")
    remark: str | None = Field(default=None, description="备注")
    exception_strategies: list = Field(default_factory=list, description="异常处理策略")
    status: str = Field(description="PENDING 待完善 / COMPLETE 已初始化")
    completed_at: datetime | None = None
    completed_by_id: str | None = None
    created_at: CNDatetime
    updated_at: CNDatetime

    model_config = {"from_attributes": True}


class GcAccountProfileListResponse(BaseModel):
    items: list[GcAccountProfileOut]
    total: int
    page: int
    size: int
