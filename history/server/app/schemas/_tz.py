"""统一时间出口时区。

数据库时间字段（created_at 等）按约定存 naive UTC（datetime.utcnow 写入）。
对外 JSON 输出时统一转为北京时间（UTC+8）的「墙上时间」字符串（不带时区后缀），
使前端/小程序按字面显示即为北京时间，无需各自 +8。

只在 JSON 序列化时转换（when_used="json"）：
- model_dump()（python 模式）仍返回原始 datetime，保证后端内部 model_dump→改字段→
  重建模型 这类回环不会被二次 +8；
- 仅最终响应序列化时转一次。
"""

from datetime import datetime, timedelta, timezone
from typing import Annotated

from pydantic import PlainSerializer

CN_TZ = timezone(timedelta(hours=8))


def utc_to_cn(dt: datetime | None) -> datetime | None:
    """naive-UTC（或带时区）→ 北京时间的 naive datetime。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(CN_TZ).replace(tzinfo=None)


def utc_to_cn_iso(dt: datetime | None) -> str | None:
    cn = utc_to_cn(dt)
    return cn.isoformat() if cn is not None else None


# 用法：把响应 schema 里的 `created_at: datetime` 改成 `created_at: CNDatetime`
CNDatetime = Annotated[
    datetime,
    PlainSerializer(utc_to_cn_iso, return_type=str, when_used="json"),
]
