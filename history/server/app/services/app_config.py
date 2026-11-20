from sqlalchemy.orm import Session

from app.models import PurchaseAccount, SaleShop, WarehouseLocation


def list_enabled_locations(db: Session) -> list[WarehouseLocation]:
    return (
        db.query(WarehouseLocation)
        .filter(WarehouseLocation.enabled.is_(True))
        .order_by(WarehouseLocation.sort_order, WarehouseLocation.code)
        .all()
    )


def list_enabled_sale_shops(db: Session) -> list[SaleShop]:
    return (
        db.query(SaleShop)
        .filter(SaleShop.enabled.is_(True))
        .order_by(SaleShop.sort_order, SaleShop.code)
        .all()
    )


def list_enabled_purchase_accounts(db: Session) -> list[PurchaseAccount]:
    return (
        db.query(PurchaseAccount)
        .filter(PurchaseAccount.enabled.is_(True))
        .order_by(PurchaseAccount.sort_order, PurchaseAccount.code)
        .all()
    )


def is_valid_purchase_account(db: Session, code: str) -> bool:
    name = (code or "").strip()
    if not name:
        return False
    return (
        db.query(PurchaseAccount.id)
        .filter(PurchaseAccount.code == name, PurchaseAccount.enabled.is_(True))
        .first()
        is not None
    )
