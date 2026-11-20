"""slow_moving_restock_records → slow_moving_restock_record。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.slow_moving import SlowMovingRestockRecord
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_str,
)


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("slow_moving_restock_records"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("slow_moving", cloud_id)
        r = SlowMovingRestockRecord(
            id=local_id,
            action_type=safe_str(doc.get("actionType"), 16) or "SKIPPED",
            action_result=safe_str(doc.get("actionResult"), 16),
            status=safe_str(doc.get("status"), 16) or "SKIPPED",
            status_text=safe_str(doc.get("statusText"), 64),
            record_type=safe_str(doc.get("recordType"), 32),
            target_key=safe_str(doc.get("targetKey"), 128),
            task_model_version=int(doc.get("taskModelVersion") or 0) or None,
            days_in_stock=int(doc.get("daysInStock") or 0) or None,
            goods_code=safe_str(doc.get("goodsCode"), 64),
            product_name=safe_str(doc.get("productName"), 256),
            model=safe_str(doc.get("model"), 128),
            location=safe_str(doc.get("location"), 64),
            sn=safe_str(doc.get("sn"), 128),
            cover=safe_str(doc.get("cover"), 512),
            proof_image=safe_str(doc.get("proofImage"), 512),
            note=safe_str(doc.get("note")),
            transition_reason=safe_str(doc.get("transitionReason"), 256),
            item_id=mapper.get("items", doc.get("itemId")) or safe_str(doc.get("itemId"), 36),
            legacy_id=safe_str(doc.get("legacyId"), 64),
            purchase_order_id=safe_str(doc.get("purchaseOrderId"), 64),
            created_by_id=mapper.get("users", doc.get("createdByUserId")),
            updated_by_id=mapper.get("users", doc.get("updatedByUserId")),
        )
        if c := parse_dt(doc.get("createdAt")):
            r.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            r.updated_at = u
        db.merge(r)
        n += 1
    return n
