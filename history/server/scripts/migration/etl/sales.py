"""sales_orders → sale_order。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.sales import SaleOrder
from scripts.migration.common import (
    IdMapper,
    UniqueGuard,
    fen_to_yuan_opt,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_str,
)

_STATUS_MAP = {
    "PENDING": "PENDING",
    "CREATED": "PENDING",
    "SHIPPED": "SHIPPED",
    "COMPLETED": "COMPLETED",
    "REVOKED": "COMPLETED",
}


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    users = mapper._maps.get("users", {})
    fallback_user = next(iter(users.values()), None)
    guard = UniqueGuard()
    for doc in iter_jsonl("sales_orders"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("sales_orders", cloud_id)
        created_by_local = mapper.get("users", doc.get("createdByUserId")) or fallback_user
        # 云端 outTradeNo 存在重复(测试值 "1" 5 次、"2701808..." 6 次、44 条空串等),
        # 本地 sale_order.order_no 是 UNIQUE。空串走 cloud_id 兜底(30 hex 字符,
        # 远超生日碰撞阈值),最终再由 UniqueGuard 用 #N 计数器兜底任何剩余冲突。
        raw_no = safe_str(doc.get("outTradeNo"), 32) or f"SO{cloud_id[:30]}"
        order_no = guard.ensure("sale_order.order_no", raw_no, max_len=32)
        so = SaleOrder(
            id=local_id,
            order_no=order_no,
            platform=safe_str(doc.get("payChannel") or "ALIPAY", 32),
            external_order_no=safe_str(doc.get("outTradeNo"), 64),
            buyer_name=safe_str(doc.get("receiveAccountAlias"), 128),
            buyer_phone=None,
            amount=fen_to_yuan_opt(doc.get("salesAmount")),
            screenshot_url=None,
            product_title=safe_str(doc.get("productName"), 256),
            product_spec=None,
            shop_name=safe_str(doc.get("receiveAccountAlias"), 64),
            tracking_no=safe_str(doc.get("logisticsTrackingNo"), 64),
            tracking_phone_suffix=None,
            status=_STATUS_MAP.get(safe_str(doc.get("status")) or "", "PENDING"),
            created_by_id=created_by_local,
        )
        if c := parse_dt(doc.get("createdAt")):
            so.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            so.updated_at = u
        db.merge(so)
        n += 1
    return n
