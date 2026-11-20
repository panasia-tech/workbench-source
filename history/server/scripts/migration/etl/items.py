"""items → sku。

注意:
1. 本地 sku.inspection_id 是 NOT NULL,因此为每条 sku 关联一个占位 inspection
   (状态 DONE,result PASSED)。
2. 云端可能一个 purchaseOrderId 对应多条 items;本地 inspection.purchase_order_id
   仍是 UNIQUE,所以**同一个 PO 的多条 items 共享同一个 inspection**。
   通过 `mapper.get_or_new("inspection_for_po", po_local)` 保证幂等。
3. sku.purchase_order_id 的 UNIQUE 已在 025_drop_sku_po_unique 中删除,
   因此多条 sku 可以共享一个 PO。
4. 字段语义(2026-06 修正):云端 `goodsCode` 才是货号;`sn` 大多是序列号但有
   40 条与 goodsCode 相同(录入混用);`serialNo` 是验货时补录的真实序列号;
   `model` 有 431/461 条被灌成了 goodsCode,不能当型号用。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.inspection import Inspection
from app.models.inventory import Sku
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

_STATUS_MAP = {
    "IN_STOCK": "IN_STOCK",
    "RESERVED": "RESERVED",
    "LOCKED": "RESERVED",
    "SHIPPED": "SHIPPED",
    "OUT_STOCK": "SHIPPED",
    "DELETED": "LOSS",
    "LOSS": "LOSS",
}

# 云端遗留的联调/压测数据,不迁移
_TEST_SN_PREFIXES = ("E2ESN", "SN-POC", "SN_CODEX")


def _is_test_data(doc: dict) -> bool:
    if doc.get("testRunTag") or doc.get("isTestData"):
        return True
    return str(doc.get("sn") or "").startswith(_TEST_SN_PREFIXES)


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    guard = UniqueGuard()
    # 已 merge 过的 inspection.id,用于跨循环去重。
    # 同 PO 多 item 时 mapper 给出相同 insp_id,但 db.merge 不会把多次提交的瞬态对象
    # 折叠成一个 INSERT(尤其在没有先 flush 的情况下),会触发主键重复。
    merged_inspections: set[str] = set()
    for doc in iter_jsonl("items"):
        if is_soft_deleted(doc) or _is_test_data(doc):
            continue
        cloud_id = doc["_id"]
        po_local = mapper.get("purchase_orders", doc.get("purchaseOrderId"))
        if not po_local:
            # 没有对应采购单,跳过(数据一致性优先)。
            # 注意:必须在 get_or_new 之前 skip,否则会把不会真正写库的 items
            # 写进 id_map,污染下游 inventory_ledger 等表的 FK 查询。
            continue
        local_sku_id = mapper.get_or_new("items", cloud_id)
        # 同 PO 共享一个 inspection(inspection.purchase_order_id UNIQUE)
        insp_id = mapper.get_or_new("inspection_for_po", po_local)
        if insp_id not in merged_inspections:
            # 验货单号用采购单号拼出来,可读可溯源(原来用本地 UUID 前缀,显示像乱码)
            po_row = db.get(PurchaseOrder, po_local)
            raw_inspect_no = f"IN{po_row.order_no}"[:32] if po_row else f"INMIG{po_local[:14]}"
            insp = Inspection(
                id=insp_id,
                inspect_no=guard.ensure("inspection.inspect_no", raw_inspect_no, max_len=32),
                purchase_order_id=po_local,
                action_type="INBOUND",
                inspection_result="PASSED",
                listing_images=safe_list(doc.get("inboundImages")),
                defect_images=safe_list(doc.get("defectImages")),
                defect_videos=safe_list(doc.get("defectVideos")),
                condition_grade=None,
                location_code=safe_str(doc.get("location"), 32),
                status="DONE",
                inspector_id=mapper.get("users", doc.get("inboundByUserId")),
                inspected_at=parse_dt(doc.get("createdAt")),
            )
            db.merge(insp)
            merged_inspections.add(insp_id)
        # 货号 = goodsCode(仅 10 条空);兜底 sn,再兜底 cloud_id。
        # goodsCode 有少量重复(同款多台),UniqueGuard 加后缀兜底。
        goods_code = safe_str(doc.get("goodsCode"), 64)
        sn_raw = safe_str(doc.get("sn"), 128)
        raw_sku_code = goods_code or sn_raw or cloud_id
        sku_code = guard.ensure("sku.sku_code", raw_sku_code, max_len=64)
        # 序列号优先取验货补录的 serialNo;sn 与货号相同说明录入混用,不当序列号
        serial_number = safe_str(doc.get("serialNo"), 128) or (
            sn_raw if sn_raw and sn_raw != goods_code else None
        )
        # model 大面积被灌成 goodsCode,相同则视为无型号
        model = safe_str(doc.get("model"), 128)
        if model and goods_code and model == goods_code:
            model = None
        images = safe_list(doc.get("images"))
        cover_url = safe_str(
            doc.get("mainImage") or doc.get("imageUrl") or doc.get("cover"), 512
        ) or (images[0] if images and isinstance(images[0], str) else None)
        sku = Sku(
            id=local_sku_id,
            sku_code=sku_code,
            serial_number=serial_number,
            purchase_order_id=po_local,
            inspection_id=insp_id,
            product_name=safe_str(doc.get("productName"), 256) or model or "未命名商品",
            brand=None,
            model=model,
            spec=None,
            location_code=safe_str(doc.get("location"), 32),
            condition_grade=None,
            cost_price=fen_to_yuan(doc.get("purchasePriceFen")),
            suggest_price=None,
            status=_STATUS_MAP.get(safe_str(doc.get("status")) or "", "IN_STOCK"),
            reserve_source=None,
            cover_url=cover_url,
            images=images,
            tags=[],
            inbound_at=parse_dt(doc.get("createdAt")),
            outbound_at=parse_dt(doc.get("outStockAt")),
        )
        if c := parse_dt(doc.get("createdAt")):
            sku.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            sku.updated_at = u
        db.merge(sku)
        n += 1
    return n
