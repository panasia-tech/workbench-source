from datetime import datetime

from app.services.finance import cn_range_to_utc


def parse_date_range(date_from: str | None, date_to: str | None) -> tuple[datetime | None, datetime | None]:
    """把北京日期区间 YYYY-MM-DD 解析为可与 created_at(naive UTC) 比较的 [start, end) 边界。

    入参按北京时区（UTC+8）理解；end 为 date_to 次日 00:00(北京) 对应的 UTC，左闭右开。
    历史上这里直接 strptime 当 naive UTC，导致按北京日期筛选整体偏 8 小时（北京 0:00–8:00
    的数据被算到前一天），现统一经 cn_range_to_utc 换算。
    """
    df = datetime.strptime(date_from, "%Y-%m-%d").date() if date_from else None
    dt = datetime.strptime(date_to, "%Y-%m-%d").date() if date_to else None
    if df and dt:
        return cn_range_to_utc(df, dt)
    if df:
        return cn_range_to_utc(df, df)
    if dt:
        return None, cn_range_to_utc(dt, dt)[1]
    return None, None
