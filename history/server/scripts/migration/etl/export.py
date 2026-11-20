"""export_tasks → export_task。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.export import ExportTask
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_dict,
    safe_str,
)


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("export_tasks"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("export_tasks", cloud_id)
        time_range = doc.get("timeRange") or {}
        e = ExportTask(
            id=local_id,
            type=safe_str(doc.get("type"), 32) or "UNKNOWN",
            status=safe_str(doc.get("status"), 16) or "DONE",
            filters=safe_dict(doc.get("filters")),
            time_start=parse_dt(time_range.get("start")),
            time_end=parse_dt(time_range.get("end")),
            file_path=safe_str(doc.get("filePath"), 512),
            file_id=safe_str(doc.get("fileId"), 512),
            row_count=int(doc.get("rowCount") or 0),
            progress=int(doc.get("progress") or 0),
            include_sensitive=bool(doc.get("includeSensitive", False)),
            truncated=bool(doc.get("truncated", False)),
            error=safe_str(doc.get("error")),
            finished_at=parse_dt(doc.get("finishedAt")),
            created_by_id=mapper.get("users", doc.get("createdBy")),
        )
        if c := parse_dt(doc.get("createdAt")):
            e.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            e.updated_at = u
        db.merge(e)
        n += 1
    return n
