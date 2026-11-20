"""price_adjustments + price_adjustment_logs。"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models.price_adjustment import PriceAdjustment, PriceAdjustmentLog
from scripts.migration.common import (
    IdMapper,
    fen_to_yuan,
    fen_to_yuan_opt,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_dict,
    safe_list,
    safe_str,
)

logger = logging.getLogger("migration.price_adjustment")


def run_adjustments(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("price_adjustments"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("price_adjustments", cloud_id)
        a = PriceAdjustment(
            id=local_id,
            adjustment_no=safe_str(doc.get("adjustmentNo"), 32) or f"PA_{cloud_id[:10]}",
            adjustment_id=safe_str(doc.get("adjustmentId"), 64),
            biz_type=safe_str(doc.get("adjustmentBizType") or doc.get("bizType"), 16) or "sales",
            reason_type=safe_str(doc.get("reasonType"), 32),
            reason_text=safe_str(doc.get("reasonText"), 256),
            status=safe_str(doc.get("status"), 32) or "pending_review",
            risk_level=safe_str(doc.get("riskLevel"), 16),
            currency=safe_str(doc.get("currency"), 8) or "CNY",
            amount=fen_to_yuan(doc.get("amountFen")),
            goods_code=safe_str(doc.get("goodsCode"), 64),
            item_id=safe_str(doc.get("itemId"), 64),
            item_snapshot=safe_dict(doc.get("itemSnapshot")),
            product_name=safe_str(doc.get("productName"), 256),
            product_model=safe_str(doc.get("productModel"), 128),
            customer_name=safe_str(doc.get("customerName") or doc.get("customerIdOrName"), 128),
            sales_order_id=mapper.get("sales_orders", doc.get("salesOrderId")),
            sales_order_no=safe_str(doc.get("salesOrderNo"), 64),
            sales_amount=fen_to_yuan_opt(doc.get("salesAmountFen")),
            purchase_order_id=mapper.get("purchase_orders", doc.get("purchaseOrderId")),
            purchase_order_no=safe_str(doc.get("purchaseOrderNo"), 64),
            purchase_amount=fen_to_yuan_opt(doc.get("purchaseAmountFen")),
            alipay_txn_id=safe_str(doc.get("alipayTxnId"), 64),
            out_trade_no=safe_str(doc.get("outTradeNo"), 64),
            evidence_files=safe_list(doc.get("evidenceFiles")),
            handling_remark=safe_str(doc.get("handlingRemark")),
            paid_at=parse_dt(doc.get("paidAt")),
            paid_by_id=mapper.get("users", doc.get("paidBy")),
            reviewed_at=parse_dt(doc.get("reviewedAt")),
            reviewed_by_id=mapper.get("users", doc.get("reviewedBy")),
            cancelled_at=parse_dt(doc.get("cancelledAt")),
            cancelled_by_id=mapper.get("users", doc.get("cancelledBy")),
            cancelled_reason=safe_str(doc.get("cancelledReason"), 256),
            failed_reason=safe_str(doc.get("failedReason")),
            rejected_reason=safe_str(doc.get("rejectedReason")),
            duplicate_signature=safe_str(doc.get("duplicateSignature"), 256),
            legacy_ref=safe_str(doc.get("legacyRef"), 64),
            source_summary=safe_str(doc.get("sourceSummary"), 256),
            created_by_id=mapper.get("users", doc.get("createdBy")),
        )
        if c := parse_dt(doc.get("createdAt")):
            a.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            a.updated_at = u
        db.merge(a)
        n += 1
    return n


def run_logs(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("price_adjustment_logs"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("price_adjustment_logs", cloud_id)
        adj_local = mapper.get("price_adjustments", doc.get("adjustmentId"))
        if not adj_local:
            logger.warning("price_adjustment_logs[%s] 对应主单未迁移,跳过", cloud_id)
            continue
        log = PriceAdjustmentLog(
            id=local_id,
            adjustment_id=adj_local,
            event_type=safe_str(doc.get("eventType") or doc.get("action"), 32) or "EVENT",
            note=safe_str(doc.get("note")),
            operator_id=mapper.get("users", doc.get("operatorId") or doc.get("createdBy")),
            payload=safe_dict(doc.get("payload")),
            created_at=parse_dt(doc.get("createdAt")) or parse_dt(doc.get("updatedAt")),
        )
        db.merge(log)
        n += 1
    return n
