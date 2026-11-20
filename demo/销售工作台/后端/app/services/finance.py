from datetime import datetime, timedelta, timezone

CHINA = timezone(timedelta(hours=8))


def cn_today_start_utc():
    return datetime.now(CHINA).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).replace(tzinfo=None)
