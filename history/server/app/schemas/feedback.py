from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


class AnonymousFeedbackCreate(BaseModel):
    category: str = Field(..., min_length=1, max_length=32, description="反馈类型 REWORK=返工/FEEDBACK=系统反馈/COMPLAINT=投诉")
    title: str = Field(..., min_length=1, max_length=128, description="标题")
    target: str | None = Field(default=None, max_length=128, description="涉及模块/对象")
    content: str = Field(..., min_length=1, max_length=4000, description="反馈内容")
    attachments: list[str] = Field(default_factory=list, description="附件URL列表")


class AnonymousFeedbackItem(BaseModel):
    """对外序列化模型——方案 B：刻意不包含 created_by_id / 提交人姓名。"""

    id: str = Field(description="反馈ID")
    category: str = Field(description="反馈类型 REWORK=返工/FEEDBACK=系统反馈/COMPLAINT=投诉")
    title: str = Field(description="标题")
    target: str | None = Field(default=None, description="涉及模块/对象")
    content: str = Field(description="反馈内容")
    attachments: list[str] = Field(default_factory=list, description="附件URL列表")
    status: str = Field(description="处理状态 OPEN=待处理/IN_PROGRESS=处理中/CLOSED=已关闭")
    handled_note: str | None = Field(default=None, description="处理备注")
    handled_at: CNDatetime | None = Field(default=None, description="处理时间")
    handled_by_name: str | None = Field(default=None, description="处理人姓名")
    source: str | None = Field(default=None, description="来源 MINIPROGRAM=小程序")
    created_at: CNDatetime | None = Field(default=None, description="创建时间")
    updated_at: CNDatetime | None = Field(default=None, description="更新时间")


class AnonymousFeedbackUpdate(BaseModel):
    status: str = Field(..., min_length=1, max_length=16, description="处理状态 OPEN=待处理/IN_PROGRESS=处理中/CLOSED=已关闭")
    handled_note: str | None = Field(default=None, max_length=2000, description="处理备注")
