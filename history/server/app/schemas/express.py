from datetime import datetime

from pydantic import BaseModel, Field
from app.schemas._tz import CNDatetime


class ExpressTraceItem(BaseModel):
    time: str = Field(default="", description="轨迹时间")
    context: str = Field(default="", description="轨迹描述")


class ExpressTrackingOut(BaseModel):
    tracking_no: str = Field(description="快递单号")
    status: str = Field(default="", description="快递状态")
    msg: str = Field(default="", description="查询消息")
    traces: list[ExpressTraceItem] = Field(default=[], description="物流轨迹列表")
    ok: bool = Field(default=False, description="查询是否成功")
    cached: bool = Field(default=False, description="是否来自缓存")
    queried_at: CNDatetime | None = Field(default=None, description="查询时间")
