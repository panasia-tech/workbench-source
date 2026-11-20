"""inventory_manual_requests / inventory_listing_tasks。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.inventory_request import InventoryListingTask, InventoryManualRequest
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_dict,
    safe_str,
)


def run_manual(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("inventory_manual_requests"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("inventory_manual_requests", cloud_id)
        req = InventoryManualRequest(
            id=local_id,
            request_no=safe_str(doc.get("requestNo"), 32) or f"MSR_{cloud_id[:10]}",
            request_type=safe_str(doc.get("requestType"), 16) or "INBOUND",
            source=safe_str(doc.get("source"), 64),
            status=safe_str(doc.get("status"), 16) or "PENDING",
            request_payload=safe_dict(doc.get("requestPayload")),
            item_snapshot=safe_dict(doc.get("itemSnapshot")),
            review_decision=safe_str(doc.get("reviewDecision"), 16),
            review_note=safe_str(doc.get("reviewNote")),
            reviewed_at=parse_dt(doc.get("reviewedAt")),
            reviewed_by_id=mapper.get("users", doc.get("reviewedByUserId")),
            executed_result=safe_dict(doc.get("executedResult")),
            ops_task_id=safe_str(doc.get("opsTaskId"), 36),
            closed_at=parse_dt(doc.get("closedAt")),
            created_by_id=mapper.get("users", doc.get("createdByUserId")),
        )
        if c := parse_dt(doc.get("createdAt")):
            req.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            req.updated_at = u
        db.merge(req)
        n += 1
    return n


def run_listing(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("inventory_listing_tasks"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("inventory_listing_tasks", cloud_id)
        snapshot = doc.get("inventorySnapshot") or {}
        t = InventoryListingTask(
            id=local_id,
            listing_id=safe_str(doc.get("listingId"), 64),
            listing_title=safe_str(doc.get("listingTitle"), 256),
            listing_model=safe_str(doc.get("listingModel"), 128),
            listing_status=safe_str(doc.get("listingStatus"), 32),
            model_key=safe_str(doc.get("modelKey"), 128),
            reason_type=safe_str(doc.get("reasonType"), 64),
            status=safe_str(doc.get("status"), 16) or "PENDING",
            in_stock_count=int(snapshot.get("inStockCount") or doc.get("inStockCount") or 0),
            last_detected_at=parse_dt(doc.get("lastDetectedAt")),
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
