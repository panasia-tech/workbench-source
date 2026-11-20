"""purchase_orders → purchase_order。复用 itemId 等关键字段到 PurchaseOrder。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.purchase import PurchaseOrder
from scripts.migration.common import (
    IdMapper,
    UniqueGuard,
    fen_to_yuan,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_list,
    safe_str,
)

# 云端 status → 本地 OrderStatus
_STATUS_MAP = {
    "PENDING_INSPECT": "PENDING_INSPECT",
    "WAIT_INBOUND": "PENDING_INSPECT",
    "INSPECTED": "IN_STOCK",
    "IN_STOCK": "IN_STOCK",
    "SHIPPED": "SHIPPED",
    "DELETED": "CANCELLED",
    "CANCELLED": "CANCELLED",
    "LOSS": "LOSS",
}


def _is_test_data(doc: dict) -> bool:
    """云端遗留的联调/压测单,不迁移。"""
    if doc.get("isTestData") or doc.get("testRunId") or doc.get("testSeedReason"):
        return True
    if str(doc.get("purchaseNo") or "").startswith("LPO-TEST"):
        return True
    return str(doc.get("outTradeNo") or "").startswith("E2E")


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    guard = UniqueGuard()
    for doc in iter_jsonl("purchase_orders"):
        if is_soft_deleted(doc) or _is_test_data(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("purchase_orders", cloud_id)
        created_by_cloud = doc.get("creatorUserId") or doc.get("createdByUserId")
        created_by_local = mapper.get("users", created_by_cloud)
        # 现有 dump 中 purchaseNo 100% 非空且唯一,fallback 暂未触发;
        # 但保留 cid[:8] 这种短前缀有生日碰撞风险,统一改成 30 hex + UniqueGuard 兜底。
        raw_order_no = safe_str(doc.get("purchaseNo"), 32) or f"PO{cloud_id[:30]}"
        order_no = guard.ensure("purchase_order.order_no", raw_order_no, max_len=32)
        po = PurchaseOrder(
            id=local_id,
            order_no=order_no,
            status=_STATUS_MAP.get(safe_str(doc.get("status")) or "", "PENDING_INSPECT"),
            product_name=safe_str(doc.get("productName") or (doc.get("inboundDetail") or {}).get("model"), 256)
            or "未命名商品",
            brand=safe_str(doc.get("brand"), 128),
            model=safe_str((doc.get("inboundDetail") or {}).get("model") or doc.get("model"), 128),
            spec=safe_str(doc.get("spec"), 128),
            unit_price=fen_to_yuan(doc.get("amountFen")),
            external_order_no=safe_str(doc.get("outTradeNo"), 64),
            transaction_no=safe_str(doc.get("alipayTxnId"), 64),
            tracking_no=safe_str(doc.get("logisticsTrackingNo"), 64),
            order_time=parse_dt(doc.get("reconcileOrderTime") or doc.get("createdAt")),
            paid_at=parse_dt(doc.get("paidAt")),
            purchase_account=safe_str(doc.get("payAccountAlias"), 64),
            seller_name=safe_str(doc.get("sellerNickname") or doc.get("creatorName"), 128),
            remark=safe_str(doc.get("note") or doc.get("auditNote")),
            product_images=safe_list(_pick_images(doc)),
            attachments=safe_list(doc.get("evidenceFiles")),
            screenshot_url=safe_str((doc.get("imageFiles") or {}).get("orderInfo"), 512),
            screenshot_url_2=safe_str((doc.get("imageFiles") or {}).get("sellerDesc"), 512),
            created_by_id=created_by_local or list(mapper._maps.get("users", {}).values())[0],
        )
        if c := parse_dt(doc.get("createdAt")):
            po.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            po.updated_at = u
        db.merge(po)
        n += 1
    return n


def _pick_images(doc: dict) -> list:
    """商品图优先取 images 列表,再补 mainImage/imageUrl/coverUrl/cover 单图。
    去重、过滤空串。订单信息/卖家描述截图已单独存 screenshot_url(_2),不混进来。"""
    images: list = []
    seen: set = set()

    def _add(v):
        if isinstance(v, str) and v and v not in seen:
            seen.add(v)
            images.append(v)

    for v in doc.get("images") or []:
        _add(v)
    for key in ("mainImage", "imageUrl", "coverUrl", "cover"):
        _add(doc.get(key))
    return images
