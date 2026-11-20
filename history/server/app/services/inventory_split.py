"""历史库存拆分：把 1 条 SKU 按金额拆成 N 条独立 SKU。

场景：早期把"一对喇叭"按 1100 元两台录成了 1 条 SKU，需事后拆成各自独立、
可分别上架/销售/盘点的多条 SKU。

做法（方案 B：退役原件、新建 N 条）：
- 复刻采购录入"同一链接多商品"的模型——共用原采购单的凭证字段，循环造
  N 套 PurchaseOrder + Inspection + Sku + StockEvent；
- 金额守恒：各件成本之和必须等于原 SKU 的 cost_price；
- 原 SKU 置为 SkuStatus.SPLIT 退役，若绑了 RFID 先解绑（标签可重新绑到新件）。
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
    ShopListingStatus,
    SkuStatus,
    StockEventType,
)
from app.models import (
    Inspection,
    PurchaseOrder,
    Sku,
    SkuShopListing,
    Staff,
    StockEvent,
)
from app.schemas.inventory import SkuSplitResult
from app.services.auto_listing.pipeline import enqueue_on_inbound
from app.services.order_no import calc_suggest_price, generate_order_no, generate_sku_code

MIN_ITEMS = 2


class SplitError(Exception):
    pass


def _cents(value) -> int:
    return int(round(Decimal(str(value)) * 100))


def _compose_name(brand: str | None, model: str | None, fallback: str) -> str:
    name = " ".join(p for p in [(brand or "").strip(), (model or "").strip()] if p).strip()
    return name or fallback


def split_sku(db: Session, user: Staff, sku_code: str, items: list) -> SkuSplitResult:
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise SplitError("SKU 不存在")
    if sku.status != SkuStatus.IN_STOCK:
        raise SplitError("仅在库商品可拆分")
    listed_count = (
        db.query(SkuShopListing)
        .filter(
            SkuShopListing.sku_id == sku.id,
            SkuShopListing.publish_status == ShopListingStatus.LISTED,
        )
        .count()
    )
    if listed_count > 0:
        raise SplitError(f"商品仍在 {listed_count} 个店铺在架，请先全部下架后再拆分")

    if len(items) < MIN_ITEMS:
        raise SplitError(f"至少拆成 {MIN_ITEMS} 件")
    for idx, it in enumerate(items, 1):
        if it.amount is None or Decimal(it.amount) <= 0:
            raise SplitError(f"第 {idx} 件金额必须大于 0")
    total = sum(_cents(it.amount) for it in items)
    if total != _cents(sku.cost_price):
        raise SplitError(f"各件金额之和须等于原成本 ¥{sku.cost_price}")

    order = db.get(PurchaseOrder, sku.purchase_order_id)
    now = datetime.utcnow()
    images = list(sku.images or [])
    new_codes: list[str] = []

    for it in items:
        product_name = _compose_name(it.brand, it.model, sku.product_name)
        new_po = PurchaseOrder(
            order_no=generate_order_no(db, "PO", PurchaseOrder, "order_no"),
            status=OrderStatus.IN_STOCK,
            product_name=product_name,
            brand=(it.brand or "").strip() or sku.brand,
            model=(it.model or "").strip() or sku.model,
            spec=(it.spec or "").strip() or None,
            unit_price=Decimal(it.amount),
            external_order_no=order.external_order_no if order else None,
            transaction_no=order.transaction_no if order else None,
            tracking_no=order.tracking_no if order else None,
            tracking_phone_suffix=order.tracking_phone_suffix if order else None,
            order_time=order.order_time if order else None,
            paid_at=order.paid_at if order else None,
            purchase_account=order.purchase_account if order else None,
            seller_name=order.seller_name if order else None,
            remark=f"历史库存拆分（源 {sku_code}）",
            product_images=list(order.product_images or []) if order else [],
            screenshot_url=order.screenshot_url if order else None,
            screenshot_url_2=order.screenshot_url_2 if order else None,
            created_by_id=user.id,
        )
        db.add(new_po)
        db.flush()

        inspection = Inspection(
            inspect_no=generate_order_no(db, "IN", Inspection, "inspect_no"),
            purchase_order_id=new_po.id,
            action_type=InspectionActionType.INBOUND,
            inspection_result=InspectionResult.PASSED,
            listing_images=images,
            condition_grade=(it.condition_grade or "").strip() or sku.condition_grade,
            location_code=(it.location_code or "").strip() or sku.location_code,
            remark=f"历史库存拆分（源 {sku_code}）",
            status=InspectionStatus.DONE,
            inspector_id=user.id,
            inspected_at=now,
        )
        db.add(inspection)
        db.flush()

        amount = Decimal(it.amount)
        grade = (it.condition_grade or "").strip() or sku.condition_grade
        new_sku = Sku(
            sku_code=generate_sku_code(db),
            serial_number=(it.serial_number or "").strip() or None,
            purchase_order_id=new_po.id,
            inspection_id=inspection.id,
            product_name=product_name,
            brand=(it.brand or "").strip() or sku.brand,
            model=(it.model or "").strip() or sku.model,
            spec=(it.spec or "").strip() or None,
            location_code=(it.location_code or "").strip() or sku.location_code,
            condition_grade=grade,
            cost_price=amount,
            suggest_price=calc_suggest_price(float(amount), grade),
            status=SkuStatus.IN_STOCK,
            cover_url=sku.cover_url,
            images=images,
            location_images=list(sku.location_images or []),
            tags=list(sku.tags or []),
            inbound_at=now,
            negotiated_at=now,
            negotiation_remark=f"历史库存拆分转入（源 {sku_code}），免议价",
        )
        db.add(new_sku)
        db.flush()
        new_codes.append(new_sku.sku_code)

        # 入库即登记自动上架（开关关着则不登记；跟拆分同一笔事务落库）
        enqueue_on_inbound(db, new_sku)

        for et, ref in [
            (StockEventType.INSPECT, inspection.inspect_no),
            (StockEventType.INBOUND, new_sku.sku_code),
        ]:
            db.add(
                StockEvent(
                    purchase_order_id=new_po.id,
                    sku_id=new_sku.id,
                    event_type=et,
                    ref_no=ref,
                    operator_id=user.id,
                    payload={"source": "split", "from_sku": sku_code},
                )
            )

    # 退役原 SKU：解绑 RFID（标签可重绑到新件）→ 置 SPLIT 留痕
    if sku.rfid_epc:
        db.add(
            StockEvent(
                purchase_order_id=sku.purchase_order_id,
                sku_id=sku.id,
                event_type=StockEventType.RFID_UNBIND,
                ref_no=sku.rfid_epc,
                operator_id=user.id,
                payload={"source": "split", "reason": "split_retire"},
            )
        )
        sku.rfid_epc = None
    sku.status = SkuStatus.SPLIT
    db.add(
        StockEvent(
            purchase_order_id=sku.purchase_order_id,
            sku_id=sku.id,
            event_type=StockEventType.SPLIT,
            ref_no=sku_code,
            operator_id=user.id,
            payload={"source": "split", "into": new_codes},
        )
    )

    db.commit()
    return SkuSplitResult(source_sku_code=sku_code, new_sku_codes=new_codes)
