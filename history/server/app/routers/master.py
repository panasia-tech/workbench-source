from fastapi import APIRouter, Depends, HTTPException

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import StaffRole
from app.models import ProductType, PurchaseAccount, PurchaseOrder, SaleShop, Sku, Staff, WarehouseLocation, WarehouseTag
from app.schemas.common import (
    MasterAccountCreate,
    MasterAccountOut,
    MasterAccountUpdate,
    MasterLocationCreate,
    MasterLocationOut,
    MasterLocationUpdate,
    MasterSaleShopCreate,
    MasterSaleShopOut,
    MasterSaleShopUpdate,
    ProductTypeCreate,
    ProductTypeOut,
    ProductTypeUpdate,
    WarehouseTagCreate,
    WarehouseTagOut,
    WarehouseTagUpdate,
)
from app.services.app_config import list_enabled_locations, list_enabled_sale_shops
from sqlalchemy.orm import Session

router = APIRouter(prefix="/api/master", tags=["master"])


@router.get("/purchase-accounts/enabled", summary="启用采购账号列表", response_model=list[MasterAccountOut])
def enabled_accounts(db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    return (
        db.query(PurchaseAccount)
        .filter(PurchaseAccount.enabled.is_(True))
        .order_by(PurchaseAccount.sort_order)
        .all()
    )


@router.get("/locations/enabled", summary="启用库位列表", response_model=list[MasterLocationOut])
def enabled_locations(db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    return list_enabled_locations(db)


@router.get("/purchase-accounts", summary="采购账号列表", response_model=list[MasterAccountOut])
def list_accounts(_: Staff = Depends(require_roles(StaffRole.ADMIN)), db: Session = Depends(get_db)):
    return db.query(PurchaseAccount).order_by(PurchaseAccount.sort_order).all()


@router.post("/purchase-accounts", summary="创建采购账号", response_model=MasterAccountOut)
def create_account(
    body: MasterAccountCreate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    if db.query(PurchaseAccount).filter(PurchaseAccount.code == body.code).first():
        raise HTTPException(status_code=400, detail="账号编码已存在")
    row = PurchaseAccount(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/purchase-accounts/{account_id}", summary="更新采购账号", response_model=MasterAccountOut)
def update_account(
    account_id: str,
    body: MasterAccountUpdate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(PurchaseAccount, account_id)
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在")
    for key, val in body.model_dump(exclude_unset=True).items():
        setattr(row, key, val)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/purchase-accounts/{account_id}", summary="删除采购账号", status_code=204)
def delete_account(
    account_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(PurchaseAccount, account_id)
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在")
    in_use = db.query(PurchaseOrder.id).filter(PurchaseOrder.purchase_account == row.code).first()
    if in_use:
        raise HTTPException(status_code=400, detail="该账号已有采购订单引用，无法删除，可先停用")
    db.delete(row)
    db.commit()


@router.get("/locations", summary="库位列表", response_model=list[MasterLocationOut])
def list_locations(_: Staff = Depends(require_roles(StaffRole.ADMIN)), db: Session = Depends(get_db)):
    return db.query(WarehouseLocation).order_by(WarehouseLocation.sort_order).all()


@router.post("/locations", summary="创建库位", response_model=MasterLocationOut)
def create_location(
    body: MasterLocationCreate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    if db.query(WarehouseLocation).filter(WarehouseLocation.code == body.code).first():
        raise HTTPException(status_code=400, detail="库位编码已存在")
    row = WarehouseLocation(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/locations/{location_id}", summary="更新库位", response_model=MasterLocationOut)
def update_location(
    location_id: str,
    body: MasterLocationUpdate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(WarehouseLocation, location_id)
    if not row:
        raise HTTPException(status_code=404, detail="库位不存在")
    for key, val in body.model_dump(exclude_unset=True).items():
        setattr(row, key, val)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/locations/{location_id}", summary="删除库位", status_code=204)
def delete_location(
    location_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(WarehouseLocation, location_id)
    if not row:
        raise HTTPException(status_code=404, detail="库位不存在")
    in_use = db.query(Sku.id).filter(Sku.location_code == row.code).first()
    if in_use:
        raise HTTPException(status_code=400, detail="库位已被 SKU 占用，无法删除，可先停用")
    db.delete(row)
    db.commit()


@router.get("/warehouse-tags/enabled", summary="启用仓库标签列表", response_model=list[WarehouseTagOut])
def enabled_warehouse_tags(db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    return (
        db.query(WarehouseTag)
        .filter(WarehouseTag.enabled.is_(True))
        .order_by(WarehouseTag.sort_order, WarehouseTag.name)
        .all()
    )


@router.get("/warehouse-tags", summary="仓库标签列表", response_model=list[WarehouseTagOut])
def list_warehouse_tags(_: Staff = Depends(require_roles(StaffRole.ADMIN)), db: Session = Depends(get_db)):
    return db.query(WarehouseTag).order_by(WarehouseTag.sort_order, WarehouseTag.name).all()


@router.post("/warehouse-tags", summary="创建仓库标签", response_model=WarehouseTagOut)
def create_warehouse_tag(
    body: WarehouseTagCreate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="标签名称不能为空")
    if db.query(WarehouseTag).filter(WarehouseTag.name == name).first():
        raise HTTPException(status_code=400, detail="标签名称已存在")
    row = WarehouseTag(
        name=name,
        enabled=body.enabled,
        sort_order=body.sort_order,
        prompt=body.prompt,
        ai_size=body.ai_size,
        ai_resolution=body.ai_resolution,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/warehouse-tags/{tag_id}", summary="更新仓库标签", response_model=WarehouseTagOut)
def update_warehouse_tag(
    tag_id: str,
    body: WarehouseTagUpdate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(WarehouseTag, tag_id)
    if not row:
        raise HTTPException(status_code=404, detail="标签不存在")
    data = body.model_dump(exclude_unset=True)
    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="标签名称不能为空")
        if new_name != row.name and db.query(WarehouseTag).filter(WarehouseTag.name == new_name).first():
            raise HTTPException(status_code=400, detail="标签名称已存在")
        data["name"] = new_name
    for key, val in data.items():
        setattr(row, key, val)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/warehouse-tags/{tag_id}", summary="删除仓库标签", status_code=204)
def delete_warehouse_tag(
    tag_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(WarehouseTag, tag_id)
    if not row:
        raise HTTPException(status_code=404, detail="标签不存在")
    db.delete(row)
    db.commit()


# ── 商品种类类型（AI 生图）：入库单选必填，每类型带一套 AI 生图/重绘提示词 ──────────────
@router.get("/product-types/enabled", summary="启用商品种类类型列表", response_model=list[ProductTypeOut])
def enabled_product_types(db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    return (
        db.query(ProductType)
        .filter(ProductType.enabled.is_(True))
        .order_by(ProductType.sort_order, ProductType.name)
        .all()
    )


@router.get("/product-types", summary="商品种类类型列表", response_model=list[ProductTypeOut])
def list_product_types(_: Staff = Depends(require_roles(StaffRole.ADMIN)), db: Session = Depends(get_db)):
    return db.query(ProductType).order_by(ProductType.sort_order, ProductType.name).all()


@router.post("/product-types", summary="创建商品种类类型", response_model=ProductTypeOut)
def create_product_type(
    body: ProductTypeCreate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="种类类型名称不能为空")
    if db.query(ProductType).filter(ProductType.name == name).first():
        raise HTTPException(status_code=400, detail="种类类型名称已存在")
    row = ProductType(
        name=name,
        enabled=body.enabled,
        sort_order=body.sort_order,
        prompt=body.prompt,
        ai_size=body.ai_size,
        ai_resolution=body.ai_resolution,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/product-types/{type_id}", summary="更新商品种类类型", response_model=ProductTypeOut)
def update_product_type(
    type_id: str,
    body: ProductTypeUpdate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(ProductType, type_id)
    if not row:
        raise HTTPException(status_code=404, detail="种类类型不存在")
    data = body.model_dump(exclude_unset=True)
    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="种类类型名称不能为空")
        if new_name != row.name and db.query(ProductType).filter(ProductType.name == new_name).first():
            raise HTTPException(status_code=400, detail="种类类型名称已存在")
        data["name"] = new_name
    for key, val in data.items():
        setattr(row, key, val)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/product-types/{type_id}", summary="删除商品种类类型", status_code=204)
def delete_product_type(
    type_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(ProductType, type_id)
    if not row:
        raise HTTPException(status_code=404, detail="种类类型不存在")
    db.delete(row)
    db.commit()


@router.get("/sale-shops/enabled", summary="启用销售店铺列表", response_model=list[MasterSaleShopOut])
def enabled_sale_shops(db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    return list_enabled_sale_shops(db)


@router.get("/sale-shops", summary="销售店铺列表", response_model=list[MasterSaleShopOut])
def list_sale_shops(_: Staff = Depends(require_roles(StaffRole.ADMIN)), db: Session = Depends(get_db)):
    return db.query(SaleShop).order_by(SaleShop.sort_order).all()


@router.post("/sale-shops", summary="创建销售店铺", response_model=MasterSaleShopOut)
def create_sale_shop(
    body: MasterSaleShopCreate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    if db.query(SaleShop).filter(SaleShop.code == body.code).first():
        raise HTTPException(status_code=400, detail="店铺编码已存在")
    row = SaleShop(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/sale-shops/{shop_id}", summary="更新销售店铺", response_model=MasterSaleShopOut)
def update_sale_shop(
    shop_id: str,
    body: MasterSaleShopUpdate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(SaleShop, shop_id)
    if not row:
        raise HTTPException(status_code=404, detail="店铺不存在")
    for key, val in body.model_dump(exclude_unset=True).items():
        setattr(row, key, val)
    db.commit()
    db.refresh(row)
    return row
