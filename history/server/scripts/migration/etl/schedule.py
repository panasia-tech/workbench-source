"""staff_schedule_logs / overrides / holiday_requests。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.schedule import (
    StaffScheduleHolidayRequest,
    StaffScheduleLog,
    StaffScheduleOverride,
)
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_date,
    parse_dt,
    safe_str,
)


def run_logs(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("staff_schedule_logs"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("staff_schedule_logs", cloud_id)
        log = StaffScheduleLog(
            id=local_id,
            log_id=safe_str(doc.get("logId"), 64),
            action=safe_str(doc.get("action"), 32) or "UNKNOWN",
            month=safe_str(doc.get("month"), 8),
            target_date=parse_date(doc.get("date")),
            before_status=safe_str(doc.get("beforeStatus"), 16),
            after_status=safe_str(doc.get("afterStatus"), 16),
            default_status=safe_str(doc.get("defaultStatus"), 16),
            source=safe_str(doc.get("source"), 16),
            note=safe_str(doc.get("note")),
            operator_id=mapper.get("users", doc.get("operatorUserId")),
            operator_mode=safe_str(doc.get("operatorMode"), 16),
            target_id=mapper.get("users", doc.get("targetUserId")),
            created_at=parse_dt(doc.get("createdAt")),
        )
        db.merge(log)
        n += 1
    return n


def run_overrides(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("staff_schedule_overrides"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("staff_schedule_overrides", cloud_id)
        target_local = mapper.get("users", doc.get("targetUserId"))
        if not target_local:
            continue
        o = StaffScheduleOverride(
            id=local_id,
            target_id=target_local,
            target_date=parse_date(doc.get("date")),
            status=safe_str(doc.get("status"), 16) or "OFF",
            source=safe_str(doc.get("source"), 16),
            note=safe_str(doc.get("note")),
            created_by_id=mapper.get("users", doc.get("createdByUserId")),
        )
        if c := parse_dt(doc.get("createdAt")):
            o.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            o.updated_at = u
        db.merge(o)
        n += 1
    return n


def run_holidays(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("staff_schedule_holiday_requests"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("staff_schedule_holiday_requests", cloud_id)
        target_local = mapper.get("users", doc.get("targetUserId"))
        if not target_local:
            continue
        h = StaffScheduleHolidayRequest(
            id=local_id,
            target_id=target_local,
            start_date=parse_date(doc.get("startDate")),
            end_date=parse_date(doc.get("endDate")),
            reason=safe_str(doc.get("reason")),
            status=safe_str(doc.get("status"), 16) or "PENDING",
            reviewed_by_id=mapper.get("users", doc.get("reviewedByUserId")),
            reviewed_at=parse_dt(doc.get("reviewedAt")),
            review_note=safe_str(doc.get("reviewNote")),
            created_by_id=mapper.get("users", doc.get("createdByUserId")),
        )
        if c := parse_dt(doc.get("createdAt")):
            h.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            h.updated_at = u
        db.merge(h)
        n += 1
    return n
