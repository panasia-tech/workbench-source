"""audit_runs / audit_tasks / audit_issues。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.audit import AuditIssue, AuditRun, AuditTask
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_dict,
    safe_list,
    safe_str,
)


def run_runs(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("audit_runs"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("audit_runs", cloud_id)
        time_range = doc.get("timeRange") or {}
        r = AuditRun(
            id=local_id,
            run_id=safe_str(doc.get("runId"), 64) or cloud_id[:32],
            account_id=mapper.get("payment_accounts", doc.get("accountId")),
            mode=safe_str(doc.get("mode"), 16) or "MANUAL",
            scope=safe_str(doc.get("scope"), 16) or "PURCHASE",
            match_window_hours=int(doc.get("matchWindowHours") or 48),
            time_start=parse_dt(time_range.get("start")),
            time_end=parse_dt(time_range.get("end")),
            status=safe_str(doc.get("status"), 16) or "RUNNING",
            summary=safe_dict(doc.get("summary")),
            started_at=parse_dt(doc.get("startedAt")),
            finished_at=parse_dt(doc.get("finishedAt")),
            created_by_id=mapper.get("users", doc.get("createdByUserId")),
        )
        if c := parse_dt(doc.get("createdAt")):
            r.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            r.updated_at = u
        db.merge(r)
        n += 1
    return n


def run_tasks(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("audit_tasks"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("audit_tasks", cloud_id)
        entity_type = safe_str(doc.get("entityType"), 16) or "PURCHASE"
        t = AuditTask(
            id=local_id,
            account_id=mapper.get("payment_accounts", doc.get("accountId")),
            entity_type=entity_type,
            entity_id=safe_str(doc.get("entityId"), 36) or "",
            idem_key=safe_str(doc.get("idemKey"), 128),
            attempts=int(doc.get("attempts") or 0),
            last_error=safe_str(doc.get("lastError")),
            run_at=parse_dt(doc.get("runAt")),
            status=safe_str(doc.get("status"), 16) or "SCHEDULED",
        )
        if c := parse_dt(doc.get("createdAt")):
            t.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            t.updated_at = u
        db.merge(t)
        n += 1
    return n


def run_issues(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("audit_issues"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("audit_issues", cloud_id)
        i = AuditIssue(
            id=local_id,
            audit_run_id=safe_str(doc.get("auditRunId"), 64),
            run_id=safe_str(doc.get("runId"), 64),
            account_id=mapper.get("payment_accounts", doc.get("accountId")),
            scope=safe_str(doc.get("scope"), 16) or "PURCHASE",
            entity_type=safe_str(doc.get("entityType"), 16) or "purchase_order",
            entity_id=safe_str(doc.get("entityId"), 36) or "",
            audit_status=safe_str(doc.get("auditStatus"), 32) or "MISSING_TXN",
            matched_txn_ids=safe_list(doc.get("matchedTxnIds")),
            matched_txn_refs=safe_list(doc.get("matchedTxnRefs")),
            note=safe_str(doc.get("note")),
        )
        if c := parse_dt(doc.get("createdAt")):
            i.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            i.updated_at = u
        db.merge(i)
        n += 1
    return n
