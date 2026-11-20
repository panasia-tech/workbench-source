"""不经采购、验货，直接生成一件在库 SKU。手动入库和资产录入共用这一套写法。

Sku.purchase_order_id / inspection_id 都是非空外键，所以每件货配一张占位采购单（IN_STOCK）
和一张已完成的占位验货单（DONE/PASSED）。入库即定价（negotiated_at 直接写），跳过议价。

只 add/flush 不 commit：调用方还要挂上架信息、登记自动上架等，跟入库同一笔事务落库。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from app.enums import (
    InspectionActionType,
    InspectionResult,
    InspectionStatus,
    OrderStatus,
    SkuStatus,
    StockEventType,
)
from app.models import Inspection, PurchaseOrder, Sku, Staff, StockEvent
from app.services.order_no import generate_order_no
from app.services.oss_media import first_non_video_url


def normalize_image_urls(urls: list[str]) -> list[str]:
    """前端回传的可能是带签名 query 的 URL，统一还原成不带签名的公网 URL 再入库。"""
    from app.services.oss import canonical_public_url
    from app.services.oss_media import public_url_to_object_key

    out: list[str] = []
    for u in urls:
        if not isinstance(u, str) or not u.strip():
            continue
        u = u.strip()
        if "aliyuncs.com" in u:
            key = public_url_to_object_key(u)
            if key:
                u = canonical_public_url(key)
        if u not in out:
            out.append(u)
    return out


def create_in_stock_sku(
    db: Session,
    user: Staff,
    *,
    source: str,
    po_prefix: str,
    inspect_prefix: str,
    inspector_id: str | None,
    sku_code: str,
    product_name: str,
    brand: str | None,
    model: str | None,
    spec: str | None,
    serial_number: str,
    barcode: str | None,
    location_code: str | None,
    condition_grade: str,
    product_type: str | None,
    cost_price: Decimal,
    images: list[str],
    location_images: list[str],
    inbound_at: datetime,
    po_remark: str,
    negotiation_remark: str,
    event_payload: dict | None = None,
) -> tuple[Sku, PurchaseOrder]:
    """建占位采购单 + 占位验货单 + 在库 SKU + 入库流水，返回 (sku, 占位采购单)。

    source 同时写进 SKU tags 和入库流水 payload.source（如 MANUAL_INBOUND）。
    inspector_id 为空 = 这件货不算任何人的验货计件。
    images 至少 1 张，第一张非视频的做封面。
    """
    # ① 占位采购单
    po = PurchaseOrder(
        order_no=generate_order_no(db, po_prefix, PurchaseOrder, "order_no"),
        status=OrderStatus.IN_STOCK,
        product_name=product_name,
        brand=brand,
        model=model,
        spec=spec,
        unit_price=cost_price,
        order_time=inbound_at,
        paid_at=inbound_at,
        remark=po_remark,
        product_images=images,
        created_by_id=user.id,
    )
    db.add(po)
    db.flush()

    # ② 占位验货单（DONE/PASSED）
    inspection = Inspection(
        inspect_no=generate_order_no(db, inspect_prefix, Inspection, "inspect_no"),
        purchase_order_id=po.id,
        action_type=InspectionActionType.INBOUND,
        inspection_result=InspectionResult.PASSED,
        listing_images=images,
        location_code=location_code,
        condition_grade=condition_grade,
        status=InspectionStatus.DONE,
        inspector_id=inspector_id,
        inspected_at=inbound_at,
    )
    db.add(inspection)
    db.flush()

    # ③ SKU：免议价（suggest_price=成本价，negotiated_at 直接写），直接进上架待办
    sku = Sku(
        sku_code=sku_code,
        serial_number=serial_number,
        barcode=barcode,
        purchase_order_id=po.id,
        inspection_id=inspection.id,
        product_name=product_name,
        brand=brand,
        model=model,
        spec=spec,
        location_code=location_code,
        condition_grade=condition_grade,
        product_type=product_type,
        cost_price=cost_price,
        suggest_price=cost_price,
        status=SkuStatus.IN_STOCK,
        cover_url=first_non_video_url(images) or images[0],
        images=images,
        location_images=location_images,
        tags=[source],
        inbound_at=inbound_at,
        negotiated_at=inbound_at,
        negotiation_remark=negotiation_remark,
        # 让迁移进来的旧货按原始入库日期排序（与历史迁移脚本口径一致）
        created_at=inbound_at,
    )
    db.add(sku)
    db.flush()

    db.add(
        StockEvent(
            purchase_order_id=po.id,
            sku_id=sku.id,
            event_type=StockEventType.INBOUND,
            ref_no=sku_code,
            operator_id=user.id,
            payload={"source": source, **(event_payload or {})},
        )
    )
    return sku, po
