"""inventory_ledger → stock_event。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.inventory import Sku, StockEvent
from app.models.purchase import PurchaseOrder
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_str,
)


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    # 历史上 items.py 在 skip 检查之前就调过 get_or_new,导致 id_map.json 里
    # 残留若干"映射存在但 sku 行没写库"的孤儿条目。这里以 DB 实际行为准,
    # 解析不到就把 FK 置 None(StockEvent.sku_id / purchase_order_id 都是 nullable)。
    valid_sku_ids = {row[0] for row in db.query(Sku.id).all()}
    valid_po_ids = {row[0] for row in db.query(PurchaseOrder.id).all()}
    for doc in iter_jsonl("inventory_ledger"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("inventory_ledger", cloud_id)
        po_id = mapper.get("purchase_orders", doc.get("purchaseOrderId"))
        sku_id = mapper.get("items", doc.get("itemId"))
        se = StockEvent(
            id=local_id,
            purchase_order_id=po_id if po_id in valid_po_ids else None,
            sku_id=sku_id if sku_id in valid_sku_ids else None,
            event_type=safe_str(doc.get("movementType"), 32) or "INBOUND",
            ref_no=safe_str(doc.get("sn"), 32),
            operator_id=mapper.get("users", doc.get("byUserId")),
            payload={
                "quantity": doc.get("quantity"),
                "fromStatus": doc.get("fromStatus"),
                "toStatus": doc.get("toStatus"),
                "note": doc.get("note"),
                "extra": doc.get("extra"),
                "entityType": doc.get("entityType"),
                "entityId": doc.get("entityId"),
                "salesOrderId": doc.get("salesOrderId"),
            },
            created_at=parse_dt(doc.get("at") or doc.get("createdAt")),
        )
        db.merge(se)
        n += 1
    return n
