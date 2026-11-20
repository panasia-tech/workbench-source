from datetime import date, datetime, timedelta, timezone

CN_TZ = timezone(timedelta(hours=8))


def china_today() -> date:
    return datetime.now(CN_TZ).date()


def china_yesterday() -> date:
    return china_today() - timedelta(days=1)


def format_bill_date_label(value: date) -> str:
    return value.strftime("%Y年%m月%d日")


def cn_today_start_utc() -> datetime:
    """北京时区「今日 0 点」对应的 UTC naive 时刻，用于与 created_at(naive UTC) 比较。"""
    d = china_today()
    return cn_range_to_utc(d, d)[0]


def cn_range_to_utc(date_from: date, date_to: date) -> tuple[datetime, datetime]:
    """把中国日历区间 [date_from, date_to]（含首尾）换算成可与 created_at(naive UTC) 比较的
    UTC naive 边界 [start, end)。end 为 date_to 的次日 00:00(中国) 对应的 UTC。"""
    start_cn = datetime.combine(date_from, datetime.min.time(), tzinfo=CN_TZ)
    end_cn = datetime.combine(date_to + timedelta(days=1), datetime.min.time(), tzinfo=CN_TZ)
    start_utc = start_cn.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_cn.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc
