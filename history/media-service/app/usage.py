"""播放记录和费用估算：外网流量按「每人每天每个版本看完一遍」估（上限），存储读桶的实际用量。

阿里云的预算告警要费用中心权限，现在的子账号没有，所以在这里自己算、自己提醒（钉钉群机器人）。
单价在 .env 里配（MEDIA_PRICE_*），以实际账单为准。
"""
import base64
import hashlib
import hmac
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

import httpx
from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from app.auth import Viewer
from app.config import Settings
from app.models import AlertLog, MediaItem, MediaVersion, PlayLog
from app.storage import Storage

BEIJING = timezone(timedelta(hours=8))
GB = 1024**3


def beijing_today() -> date:
    return datetime.now(BEIJING).date()


def viewer_key(viewer: Viewer, item_id: str, request: Request) -> str:
    if viewer.staff_id:
        return f"staff:{viewer.staff_id}"
    for p in viewer.passes:
        if item_id in p.item_set:
            return f"pass:{p.id}"
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else "")
    ua = request.headers.get("user-agent", "")
    return "guest:" + hashlib.sha256(f"{ip}\n{ua}".encode()).hexdigest()[:16]


def record_play(db: Session, item_id: str, v: MediaVersion, key: str) -> None:
    stmt = insert(PlayLog).values(day=beijing_today(), item_id=item_id, version_id=v.id, viewer_key=key,
                                  size=v.size, count=1)
    db.execute(stmt.on_conflict_do_update(index_elements=["day", "item_id", "version_id", "viewer_key"],
                                          set_={"count": PlayLog.count + 1}))
    db.commit()


@dataclass
class Usage:
    month: str
    views: int = 0
    viewers: int = 0
    egress_bytes: int = 0
    storage_bytes: int | None = None
    by_item: list[tuple[str, str, int, int]] = field(default_factory=list)  # (ID, 标题, 观看次数, 估算字节)

    def egress_yuan(self, s: Settings) -> float:
        return self.egress_bytes / GB * s.price_egress_per_gb

    def storage_yuan(self, s: Settings) -> float:
        return (self.storage_bytes or 0) / GB * s.price_storage_per_gb_month

    def total_yuan(self, s: Settings) -> float:
        return self.egress_yuan(s) + self.storage_yuan(s)


def month_usage(db: Session, storage: Storage | None, month: str) -> Usage:
    start = date.fromisoformat(month + "-01")
    end = (start + timedelta(days=32)).replace(day=1)
    in_month = (PlayLog.day >= start, PlayLog.day < end)
    u = Usage(month=month)
    u.views, u.viewers, u.egress_bytes = db.execute(
        select(func.count(PlayLog.id), func.count(func.distinct(PlayLog.viewer_key)), func.coalesce(func.sum(PlayLog.size), 0))
        .where(*in_month)
    ).one()
    rows = db.execute(
        select(PlayLog.item_id, MediaItem.title, func.count(PlayLog.id), func.sum(PlayLog.size))
        .join(MediaItem, MediaItem.id == PlayLog.item_id).where(*in_month)
        .group_by(PlayLog.item_id, MediaItem.title).order_by(func.sum(PlayLog.size).desc())
    ).all()
    u.by_item = [tuple(r) for r in rows]
    if storage is not None:
        u.storage_bytes = storage.total_bytes()
    return u


def report_lines(u: Usage, s: Settings) -> list[str]:
    lines = [
        f"{u.month} 截至今天：{u.viewers} 人看了 {u.views} 次（同一人同一天同一版本算一次）",
        f"外网流量估算 ≤ {u.egress_bytes / GB:.2f} GB，约 {u.egress_yuan(s):.2f} 元（{s.price_egress_per_gb} 元/GB）",
    ]
    if u.storage_bytes is not None:
        lines.append(f"桶里存了 {u.storage_bytes / GB:.2f} GB，约 {u.storage_yuan(s):.2f} 元/月"
                     f"（{s.price_storage_per_gb_month} 元/GB/月）")
    lines.append(f"合计约 {u.total_yuan(s):.2f} 元（请求费几分钱，没算；以阿里云账单为准）")
    for item_id, title, views, size in u.by_item[:10]:
        lines.append(f"  {item_id}\t{views} 次\t≤ {size / GB:.2f} GB\t{title}")
    return lines


def _signed_webhook(s: Settings) -> str:
    if not s.alert_webhook_secret:
        return s.alert_webhook
    ts = str(int(time.time() * 1000))
    digest = hmac.new(s.alert_webhook_secret.encode(), f"{ts}\n{s.alert_webhook_secret}".encode(), hashlib.sha256).digest()
    return f"{s.alert_webhook}&timestamp={ts}&sign={quote(base64.b64encode(digest))}"


def maybe_alert(db: Session, u: Usage, s: Settings) -> str:
    """超过 MEDIA_ALERT_MONTHLY_YUAN 就往钉钉群发一条，一个月只发一次。返回给命令行看的一句话。"""
    total = u.total_yuan(s)
    if s.alert_monthly_yuan <= 0:
        return "没开费用提醒（MEDIA_ALERT_MONTHLY_YUAN）"
    if total < s.alert_monthly_yuan:
        return f"没到提醒线 {s.alert_monthly_yuan:.0f} 元"
    if db.get(AlertLog, u.month):
        return f"超过提醒线 {s.alert_monthly_yuan:.0f} 元，本月已经提醒过"
    if not s.alert_webhook:
        return f"超过提醒线 {s.alert_monthly_yuan:.0f} 元，但没配 MEDIA_ALERT_WEBHOOK，发不出去"
    text = "\n".join([f"媒体资料服务费用提醒：本月估算已超过 {s.alert_monthly_yuan:.0f} 元", *report_lines(u, s)])
    r = httpx.post(_signed_webhook(s), json={"msgtype": "text", "text": {"content": text}}, timeout=10)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or body.get("errcode", 0) != 0:
        return f"提醒没发出去：{r.status_code} {body.get('errmsg', '')}"
    db.add(AlertLog(month=u.month, yuan=round(total, 2)))
    db.commit()
    return f"超过提醒线 {s.alert_monthly_yuan:.0f} 元，已发钉钉提醒"
