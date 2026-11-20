"""SKU 占用：切单 / 平台售出待发货。"""

from sqlalchemy.orm import Session

from app.enums import ReserveSource, SkuStatus
from app.models import Sku


def reserve_sku_for_platform_sold(db: Session, sku: Sku) -> Sku | None:
    """按 SKU 锁定(群控售出同步用),仅当在库且未被切单占用时。"""
    if sku.status == SkuStatus.SHIPPED or sku.status == SkuStatus.LOSS:
        return None
    if sku.status == SkuStatus.RESERVED and sku.reserve_source == ReserveSource.SWITCH:
        return sku
    if sku.status == SkuStatus.IN_STOCK:
        sku.status = SkuStatus.RESERVED
        sku.reserve_source = ReserveSource.PLATFORM_SOLD
    elif sku.status == SkuStatus.RESERVED and sku.reserve_source != ReserveSource.PLATFORM_SOLD:
        sku.reserve_source = ReserveSource.PLATFORM_SOLD
    return sku


def clear_reserve(sku: Sku) -> None:
    if sku.status == SkuStatus.RESERVED:
        sku.status = SkuStatus.IN_STOCK
    sku.reserve_source = None


def clear_reserve_on_ship(sku: Sku) -> None:
    sku.reserve_source = None
