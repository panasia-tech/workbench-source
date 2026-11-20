"""采购入站 webhook 幂等落库。"""

import logging
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.enums import PurchaseWebhookStatus
from app.models import PurchaseWebhookEvent
from app.models.staff import new_uuid

logger = logging.getLogger(__name__)

# 只存档这些关键请求头（避免把 Authorization 等敏感头整体落库）
_KEEP_HEADERS = ("x-webhook-timestamp", "x-webhook-signature", "user-agent", "content-type")


def _parse_occurred_at(value: str | None) -> datetime | None:
    """把对方声明的 ISO8601 时间转成 naive UTC（对齐全项目「DB 存 naive UTC」约定）。

    带时区偏移的 → 转 UTC 去时区；本身 naive 的 → 原样当作 UTC。解析失败返回 None。
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _pick_headers(headers) -> dict:
    """从请求头里挑出要存档的键（headers 为 Starlette Headers，键不区分大小写）。"""
    out = {}
    for k in _KEEP_HEADERS:
        v = headers.get(k)
        if v is not None:
            out[k] = v
    return out


def ingest_event(
    db: Session,
    event_id: str | None,
    payload,
    headers,
) -> tuple[PurchaseWebhookEvent, bool]:
    """原样落库，来者不拒。返回 (记录, 是否新建)。

    - event_id 有值：按它去重（已存在则返回旧记录 + False）。
    - event_id 为空：自动生成一个（满足非空唯一约束），每次推送都当新记录存。
    - payload 可为任意 JSON 结构（dict/其它已被上层包装成 dict），全量存档，不校验字段。
    """
    if event_id:
        exist = db.query(PurchaseWebhookEvent).filter_by(event_id=event_id).first()
        if exist:
            return exist, False
    else:
        event_id = new_uuid()

    meta = payload if isinstance(payload, dict) else {}
    event_type = str(meta.get("event_type") or "unknown")[:64]

    rec = PurchaseWebhookEvent(
        event_id=event_id,
        event_type=event_type,
        occurred_at=_parse_occurred_at(meta.get("occurred_at")),
        headers=_pick_headers(headers),
        payload=payload,
        status=PurchaseWebhookStatus.PENDING,
    )
    db.add(rec)
    try:
        db.commit()
    except IntegrityError:
        # 并发下另一个请求先插了同 event_id，唯一约束兜底幂等
        db.rollback()
        again = db.query(PurchaseWebhookEvent).filter_by(event_id=event_id).first()
        if again is not None:
            return again, False
        raise
    db.refresh(rec)
    return rec, True
