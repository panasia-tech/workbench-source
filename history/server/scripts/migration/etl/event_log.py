"""event_log → event_log。8.4w 条,分批 commit 防止内存爆炸。"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models.event_log import EventLog
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_dict,
    safe_str,
)

logger = logging.getLogger("migration.event_log")
BATCH_SIZE = 2000


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("event_log"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("event_log", cloud_id)
        ev = EventLog(
            id=local_id,
            event_type=safe_str(doc.get("eventType") or doc.get("type"), 64) or "UNKNOWN",
            entity_type=safe_str(doc.get("entityType"), 32),
            entity_id=safe_str(doc.get("entityId"), 64),
            operator_id=mapper.get("users", doc.get("operatorId") or doc.get("userId")),
            payload=safe_dict(doc.get("payload") or doc.get("data")),
            occurred_at=parse_dt(doc.get("at") or doc.get("occurredAt")),
            created_at=parse_dt(doc.get("createdAt")) or parse_dt(doc.get("at")),
        )
        db.merge(ev)
        n += 1
        if n % BATCH_SIZE == 0:
            db.commit()
            logger.info("event_log: 已提交 %d 条", n)
    return n
