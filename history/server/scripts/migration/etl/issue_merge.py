"""issue_tickets 合并到 inspection.remark。

云端 issue_tickets 数据量很小(2 条),按 purchaseOrderId 关联到对应 inspection,
将 note + resolveAction + resolveNote 追加到 inspection.remark 末尾。
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models.inspection import Inspection
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_str,
)

logger = logging.getLogger("migration.issue_merge")


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("issue_tickets"):
        if is_soft_deleted(doc):
            continue
        po_local = mapper.get("purchase_orders", doc.get("purchaseOrderId"))
        if not po_local:
            logger.warning("issue_tickets[%s] 关联的采购单未迁移,跳过", doc.get("_id"))
            continue
        insp = (
            db.query(Inspection)
            .filter(Inspection.purchase_order_id == po_local)
            .one_or_none()
        )
        if not insp:
            logger.warning("issue_tickets[%s] 对应 inspection 未找到,跳过", doc.get("_id"))
            continue
        snippet = "[迁移自 issue_ticket] "
        snippet += f"type={safe_str(doc.get('issueType'))}; "
        snippet += f"note={safe_str(doc.get('note')) or ''}; "
        snippet += f"resolveAction={safe_str(doc.get('resolveAction')) or ''}; "
        snippet += f"resolveNote={safe_str(doc.get('resolveNote')) or ''}; "
        snippet += f"resolvedAt={parse_dt(doc.get('resolvedAt'))}"
        insp.mismatch_remark = (
            (insp.mismatch_remark or "") + ("\n" if insp.mismatch_remark else "") + snippet
        )
        db.merge(insp)
        n += 1
    return n
