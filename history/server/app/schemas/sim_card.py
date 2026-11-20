from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


class SimCardWrite(BaseModel):
    """新增 / 编辑卡片入参。三个字段均可空，但整条不可全空（后端 service 校验）。"""

    phone: str | None = Field(default=None, max_length=32, description="手机号码")
    iccid: str | None = Field(default=None, max_length=50, description="ICCID（SIM 卡号）")
    blank_serial: str | None = Field(default=None, max_length=64, description="空卡序列号")


class SimCardOut(BaseModel):
    id: str = Field(description="主键 ID")
    phone: str | None = Field(description="手机号码")
    iccid: str | None = Field(description="ICCID（SIM 卡号）")
    blank_serial: str | None = Field(description="空卡序列号")
    created_at: CNDatetime = Field(description="创建时间")
    updated_at: CNDatetime = Field(description="更新时间")

    model_config = {"from_attributes": True}
