from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.enums import AdjustType, OrderStatus, SkuStatus, StockEventType
from app.models import InventoryAdjustment, PurchaseOrder, Sku, Staff, StockEvent
from app.services import purchase_pieces
from app.services.order_no import generate_order_no


def apply_inventory_adjustment(
    db: Session,
    user: Staff,
    sku_code: str,
    adjust_type: str,
    reason: str | None,
    ref_prefix: str = "AD",
) -> str:
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if adjust_type == AdjustType.LOSS:
        if not sku:
            raise HTTPException(status_code=404, detail=f"{sku_code} 不存在")
        if sku.status != SkuStatus.IN_STOCK:
            raise HTTPException(status_code=400, detail=f"{sku_code} 不在库，无法报损")
        order = db.get(PurchaseOrder, sku.purchase_order_id)
        adjust_no = generate_order_no(db, ref_prefix, InventoryAdjustment, "adjust_no")
        db.add(
            InventoryAdjustment(
                adjust_no=adjust_no,
                sku_id=sku.id,
                adjust_type=AdjustType.LOSS,
                reason=reason,
                operator_id=user.id,
            )
        )
        sku.status = SkuStatus.LOSS
        if order:
            order.status = OrderStatus.LOSS
            purchase_pieces.sync_order_status(db, order)  # 一单多件按各件算
        db.add(
            StockEvent(
                purchase_order_id=sku.purchase_order_id,
                sku_id=sku.id,
                event_type=StockEventType.LOSS,
                ref_no=adjust_no,
                operator_id=user.id,
                payload={"reason": reason},
            )
        )
        return adjust_no

    if adjust_type == AdjustType.OVERFLOW:
        if not sku:
            raise HTTPException(status_code=400, detail=f"{sku_code} 系统中无记录，无法盈出入库")
        if sku.status == SkuStatus.IN_STOCK:
            raise HTTPException(status_code=400, detail=f"{sku_code} 已在库，无需盈出入库")
        if sku.status not in (SkuStatus.SHIPPED, SkuStatus.LOSS):
            raise HTTPException(status_code=400, detail=f"{sku_code} 当前状态无法恢复入库")
        previous_status = sku.status
        order = db.get(PurchaseOrder, sku.purchase_order_id)
        adjust_no = generate_order_no(db, ref_prefix, InventoryAdjustment, "adjust_no")
        db.add(
            InventoryAdjustment(
                adjust_no=adjust_no,
                sku_id=sku.id,
                adjust_type=AdjustType.OVERFLOW,
                reason=reason,
                operator_id=user.id,
            )
        )
        sku.status = SkuStatus.IN_STOCK
        sku.outbound_at = None
        if order:
            order.status = OrderStatus.IN_STOCK
            purchase_pieces.sync_order_status(db, order)  # 一单多件按各件算
        db.add(
            StockEvent(
                purchase_order_id=sku.purchase_order_id,
                sku_id=sku.id,
                event_type=StockEventType.OVERFLOW,
                ref_no=adjust_no,
                operator_id=user.id,
                payload={"reason": reason, "restored_from": previous_status},
            )
        )
        return adjust_no

    raise HTTPException(status_code=400, detail="无效的调整类型")
