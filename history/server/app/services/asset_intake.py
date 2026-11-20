"""资产录入的占位单据怎么认出来。

资产录入不是采购，录入人也不拿提成（用户 2026-10-17 定）。可占位采购单必须挂在某个人名下
（created_by_id 非空），挂的是录入人——不排除的话，录入的货会算进他的采购记录、今日采购、
采购提成，财务的采购支出、OA 推送的采购提成也会跟着算。占位验货单不挂验货人，
但管理员和财务看的是全量，所以按单号前缀排除。
"""

from app.models import Inspection, PurchaseOrder

SOURCE = "ASSET_INTAKE"
PO_PREFIX = "POAST"
INSPECT_PREFIX = "INAST"


def is_asset_intake_po(po) -> bool:
    return bool(po is not None and (po.order_no or "").startswith(PO_PREFIX))


def asset_intake_po():
    """查询条件：是资产录入的占位采购单。"""
    return PurchaseOrder.order_no.like(f"{PO_PREFIX}%")


def not_asset_intake_po():
    """查询条件：排除资产录入的占位采购单。"""
    return ~asset_intake_po()


def not_asset_intake_inspection():
    """查询条件：排除资产录入的占位验货单。"""
    return ~Inspection.inspect_no.like(f"{INSPECT_PREFIX}%")
