"""logistics_track_events → logistics_track_event。"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models.logistics import LogisticsTrackEvent
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_dict,
    safe_str,
)

logger = logging.getLogger("migration.logistics")
BATCH_SIZE = 2000


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("logistics_track_events"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("logistics_track_events", cloud_id)
        ev = LogisticsTrackEvent(
            id=local_id,
            tracking_no=safe_str(doc.get("trackingNo") or doc.get("logisticsTrackingNo"), 64) or "",
            carrier=safe_str(doc.get("carrier") or doc.get("expName"), 64),
            event_time=parse_dt(doc.get("eventTime") or doc.get("time") or doc.get("at")),
            status=safe_str(doc.get("status"), 32),
            description=safe_str(doc.get("description") or doc.get("text") or doc.get("context")),
            raw=safe_dict(doc.get("raw")) or {k: v for k, v in doc.items() if k != "_id"},
            created_at=parse_dt(doc.get("createdAt") or doc.get("time")),
        )
        if not ev.tracking_no:
            continue
        db.merge(ev)
        n += 1
        if n % BATCH_SIZE == 0:
            db.commit()
            logger.info("logistics_track_event: 已提交 %d 条", n)
    return n
