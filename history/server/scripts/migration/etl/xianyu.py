"""xianyu_listings → sku_listing_info。

注意:云端 listing 不绑定具体 sku,只有 model/title/listingId。这里采用宽松映射:
若云端有 itemId 字段则关联,否则跳过(避免 NOT NULL 错误)。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.listing import SkuListingInfo
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
    for doc in iter_jsonl("xianyu_listings"):
        if is_soft_deleted(doc):
            continue
        item_cloud_id = doc.get("itemId")
        sku_local_id = mapper.get("items", item_cloud_id) if item_cloud_id else None
        if not sku_local_id:
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("xianyu_listings", cloud_id)
        info = SkuListingInfo(
            id=local_id,
            sku_id=sku_local_id,
            title=safe_str(doc.get("title"), 256),
            desc=safe_str(doc.get("note")),
            price=fen_to_yuan_opt(doc.get("priceFen")),
            original_price=None,
            express_fee=None,
            images=safe_list(doc.get("images")),
            stuff_status=None,
            status=safe_str(doc.get("status"), 32) or "DRAFT",
        )
        if c := parse_dt(doc.get("createdAt")):
            info.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            info.updated_at = u
        db.merge(info)
        n += 1
    return n
