from typing import Any

from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


# ---------- 入站信封（对方 POST body）----------
class PurchaseWebhookIn(BaseModel):
    """外部采购服务推送的通用信封。data 内部结构不校验，整体存档。"""

    event_id: str = Field(min_length=1, max_length=128, description="事件全局唯一 ID，用于幂等")
    event_type: str = Field(default="unknown", max_length=64, description="事件类型，先不约束取值")
    occurred_at: str | None = Field(default=None, description="事件发生时间 ISO8601，可选")
    data: dict[str, Any] | None = Field(default=None, description="业务负载，整体存档")


# ---------- 管理端输出 ----------
class PurchaseWebhookEventOut(BaseModel):
    id: str = Field(description="事件记录 ID")
    event_id: str = Field(description="对方提供的事件唯一 ID（幂等主键）")
    event_type: str = Field(description="事件类型")
    occurred_at: CNDatetime | None = Field(description="对方声明的事件发生时间")
    headers: dict[str, Any] | None = Field(description="存档的关键请求头（签名/时间戳/来源 UA）")
    payload: dict[str, Any] | None = Field(description="存档的完整原始 body")
    status: str = Field(description="处理状态：PENDING=待解析 / PROCESSING=解析中 / DONE=已入采购业务表 / FAILED=解析失败可重试 / IGNORED=人工忽略")
    ref_type: str | None = Field(description="解析后回填的业务实体类型（如 PURCHASE_ORDER）")
    ref_id: str | None = Field(description="解析后回填的业务实体 ID")
    error: str | None = Field(description="解析失败原因")
    retry_count: int = Field(description="重试次数")
    processed_at: CNDatetime | None = Field(description="处理完成时间")
    created_at: CNDatetime = Field(description="收件时间")
    updated_at: CNDatetime = Field(description="更新时间")

    model_config = {"from_attributes": True}
