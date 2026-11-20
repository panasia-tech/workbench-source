"""negotiation_tasks → negotiation_task。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.negotiation import NegotiationTask
from scripts.migration.common import (
    IdMapper,
    fen_to_yuan_opt,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_list,
    safe_str,
)


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("negotiation_tasks"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("negotiation_tasks", cloud_id)
        t = NegotiationTask(
            id=local_id,
            order_no=safe_str(doc.get("orderNo"), 64),
            purchase_no=safe_str(doc.get("purchaseNo"), 32),
            trade_no=safe_str(doc.get("tradeNo"), 64),
            purchase_order_id=mapper.get("purchase_orders", doc.get("purchaseOrderId")),
            item_id=mapper.get("items", doc.get("itemId")),
            goods_code=safe_str(doc.get("goodsCode"), 64),
            serial_no=safe_str(doc.get("serialNo"), 128),
            seller_nickname=safe_str(doc.get("sellerNickname"), 128),
            product_name=safe_str(doc.get("productName"), 256),
            location=safe_str(doc.get("location"), 64),
            inspection_result=safe_str(doc.get("inspectionResult"), 32),
            inspection_result_text=safe_str(doc.get("inspectionResultText"), 128),
            inspection_description=safe_str(doc.get("inspectionDescription")),
            purchase_price=fen_to_yuan_opt(doc.get("purchasePriceFen")),
            product_images=safe_list(doc.get("productImages")),
            defect_images=safe_list(doc.get("defectImages")),
            defect_videos=safe_list(doc.get("defectVideos")),
            logistics_tracking_no=safe_str(doc.get("logisticsTrackingNo"), 64),
            inspector_id=mapper.get("users", doc.get("inspectorId")),
            inspector_name=safe_str(doc.get("inspectorName"), 64),
            inspected_at=parse_dt(doc.get("inspectedAt")),
            close_evidence_type=safe_str(doc.get("closeEvidenceType"), 32),
            close_evidence_files=safe_list(doc.get("closeEvidenceFiles")),
            close_note=safe_str(doc.get("closeNote")),
            closed_at=parse_dt(doc.get("closedAt")),
            closed_by_id=mapper.get("users", doc.get("closedBy")),
            closed_by_name=safe_str(doc.get("closedByName"), 64),
            cancel_reason=safe_str(doc.get("cancelReason")),
            cancelled_at=parse_dt(doc.get("cancelledAt")),
            source=safe_str(doc.get("source"), 64),
            source_idem_key=safe_str(doc.get("sourceIdemKey"), 128),
            status=safe_str(doc.get("status"), 16) or "OPEN",
            created_by_id=mapper.get("users", doc.get("createdByUserId")),
        )
        if c := parse_dt(doc.get("createdAt")):
            t.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            t.updated_at = u
        db.merge(t)
        n += 1
    return n
