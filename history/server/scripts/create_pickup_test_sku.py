"""创建/重置一个用于自提沙箱支付测试的在库 SKU（幂等，可重复运行）。

货号 TESTPICKUP01，售价 ¥0.01，清晰标记为测试数据。
出库后再次运行会把它重置回 IN_STOCK 以便复测。
"""
from datetime import datetime
from decimal import Decimal

from app.database import SessionLocal
from app.enums import InspectionStatus, OrderStatus, SkuStatus, StaffRole
from app.models import Inspection, PurchaseOrder, Sku, Staff

SKU_CODE = "TESTPICKUP01"
PO_NO = "TESTPICKUPPO01"
INS_NO = "TESTPICKUPINS01"
NAME = "沙箱测试自提商品"
PRICE = Decimal("0.01")


def main():
    db = SessionLocal()
    try:
        sku = db.query(Sku).filter(Sku.sku_code == SKU_CODE).first()
        if sku:
            sku.status = SkuStatus.IN_STOCK
            sku.reserve_source = None
            sku.outbound_at = None
            sku.suggest_price = PRICE
            db.commit()
            print(f"已存在并重置为在库: sku_code={SKU_CODE} status={sku.status} 售价={sku.suggest_price}")
            return

        staff = (
            db.query(Staff).filter(Staff.role == StaffRole.ADMIN).first()
            or db.query(Staff).first()
        )
        if not staff:
            print("没有任何 staff，无法创建（created_by_id 必填）")
            return

        po = db.query(PurchaseOrder).filter(PurchaseOrder.order_no == PO_NO).first()
        if not po:
            po = PurchaseOrder(
                order_no=PO_NO,
                status=OrderStatus.IN_STOCK,
                product_name=NAME,
                brand="TEST",
                unit_price=PRICE,
                created_by_id=staff.id,
                remark="自提沙箱支付测试占位单，可删除",
            )
            db.add(po)
            db.flush()

        ins = db.query(Inspection).filter(Inspection.inspect_no == INS_NO).first()
        if not ins:
            ins = Inspection(
                inspect_no=INS_NO,
                purchase_order_id=po.id,
                status=InspectionStatus.DONE,
                inspection_result="PASSED",
                condition_grade="A",
                remark="测试占位",
            )
            db.add(ins)
            db.flush()

        sku = Sku(
            sku_code=SKU_CODE,
            product_name=NAME,
            brand="TEST",
            cost_price=PRICE,
            suggest_price=PRICE,
            status=SkuStatus.IN_STOCK,
            purchase_order_id=po.id,
            inspection_id=ins.id,
            inbound_at=datetime.utcnow(),
            tags=["测试"],
        )
        db.add(sku)
        db.commit()
        print(f"创建成功: sku_code={SKU_CODE} 售价={PRICE} 操作人={staff.name if hasattr(staff,'name') else staff.id}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
