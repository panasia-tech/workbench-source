"""删除自提沙箱测试产生的全部数据（按外键顺序）。"""
from app.database import SessionLocal
from app.models import (
    Inspection,
    PickupPayment,
    PurchaseOrder,
    SalesOutbound,
    Sku,
    StockEvent,
)

SKU_CODE = "TESTPICKUP01"
PO_NO = "TESTPICKUPPO01"
INS_NO = "TESTPICKUPINS01"


def main():
    db = SessionLocal()
    try:
        sku = db.query(Sku).filter(Sku.sku_code == SKU_CODE).first()
        deleted = {}
        if sku:
            deleted["pickup_payment"] = (
                db.query(PickupPayment).filter(PickupPayment.sku_id == sku.id).delete(synchronize_session=False)
            )
            deleted["sales_outbound"] = (
                db.query(SalesOutbound).filter(SalesOutbound.sku_id == sku.id).delete(synchronize_session=False)
            )
            deleted["stock_event"] = (
                db.query(StockEvent).filter(StockEvent.sku_id == sku.id).delete(synchronize_session=False)
            )
            db.delete(sku)
            db.flush()  # 先把 sku 删掉，否则 inspection 仍被 sku.inspection_id 引用
            deleted["sku"] = 1
        ins = db.query(Inspection).filter(Inspection.inspect_no == INS_NO).first()
        if ins:
            db.delete(ins)
            db.flush()
            deleted["inspection"] = 1
        po = db.query(PurchaseOrder).filter(PurchaseOrder.order_no == PO_NO).first()
        if po:
            db.delete(po)
            db.flush()
            deleted["purchase_order"] = 1
        db.commit()
        print("已删除:", deleted or "无数据")
    finally:
        db.close()


if __name__ == "__main__":
    main()
