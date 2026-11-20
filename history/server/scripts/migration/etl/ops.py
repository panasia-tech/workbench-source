"""ops_tasks → ops_task。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.ops import OpsTask
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_str,
)


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("ops_tasks"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("ops_tasks", cloud_id)
        t = OpsTask(
            id=local_id,
            task_type=safe_str(doc.get("taskType"), 64) or "UNKNOWN",
            source=safe_str(doc.get("source"), 64),
            source_idem_key=safe_str(doc.get("sourceIdemKey"), 128),
            title=safe_str(doc.get("title"), 256) or "(无标题)",
            detail=safe_str(doc.get("detail")),
            priority=safe_str(doc.get("priority"), 16) or "MEDIUM",
            entity_type=safe_str(doc.get("entityType"), 32),
            entity_id=safe_str(doc.get("entityId"), 64),
            assignee_id=mapper.get("users", doc.get("assigneeUserId")),
            created_by_id=mapper.get("users", doc.get("createdByUserId")),
            status=safe_str(doc.get("status"), 16) or "OPEN",
            resolve_note=safe_str(doc.get("resolveNote")),
            resolved_at=parse_dt(doc.get("resolvedAt")),
            resolved_by_id=mapper.get("users", doc.get("resolvedByUserId")),
        )
        if c := parse_dt(doc.get("createdAt")):
            t.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            t.updated_at = u
        db.merge(t)
        n += 1
    return n
