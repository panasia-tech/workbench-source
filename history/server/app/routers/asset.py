from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.enums import StaffRole
from app.models import AssetDevice, PurchaseOrder
from app.schemas.asset import (
    AssetDeviceCreate,
    AssetDeviceOut,
    AssetDeviceUpdate,
    AssetListResponse,
    AssetNoCheckOut,
)
from app.services.order_no import generate_asset_no
from app.services.oss_media import sign_media_payload

router = APIRouter(prefix="/api/asset", tags=["asset"])

# 权限口径：员工各自登记/查看/管理自己的资产(owner_id=本人)，管理员看/管全部。
# 历史数据 owner_id 为空的仅管理员可见。


def _is_admin(staff) -> bool:
    return staff.role == StaffRole.ADMIN


def _get_owned_device(db: Session, staff, device_id: str) -> AssetDevice:
    device = db.query(AssetDevice).filter(AssetDevice.id == device_id).first()
    if not device or (not _is_admin(staff) and device.owner_id != staff.id):
        raise HTTPException(status_code=404, detail="资产不存在")
    return device


def _asset_out(device: AssetDevice) -> dict:
    """序列化资产并对图片字段做 OSS 签名（bucket 私有读，直连会 403）。"""
    data = AssetDeviceOut.model_validate(device).model_dump()
    data["image_files"] = sign_media_payload(data.get("image_files") or [])
    data["product_images"] = sign_media_payload(data.get("product_images") or [])
    return data


@router.get("/devices", summary="资产设备列表", response_model=AssetListResponse)
def list_devices(
    q: str | None = Query(None, description="搜索关键词(资产编号/名称/SN/品牌/型号)"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    query = db.query(AssetDevice)
    if not _is_admin(staff):
        query = query.filter(AssetDevice.owner_id == staff.id)
    if q:
        like = f"%{q}%"
        query = query.filter(
            AssetDevice.asset_no.like(like)
            | AssetDevice.device_name.like(like)
            | AssetDevice.device_sn.like(like)
            | AssetDevice.brand.like(like)
            | AssetDevice.model.like(like)
        )
    total = query.count()
    items = (
        query.order_by(AssetDevice.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    return {"items": [_asset_out(d) for d in items], "total": total, "page": page, "size": size}


# 注意：静态路径必须声明在 /devices/{device_id} 之前，否则会被当成 device_id 匹配
@router.get("/devices/check-no", summary="资产编号查重", response_model=AssetNoCheckOut)
def check_asset_no(
    asset_no: str = Query(..., min_length=1),
    exclude_id: str | None = Query(None, description="编辑时排除自身"),
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    """扫码查重：全库精确匹配（员工列表接口只能看自己的资产，需此全局口径）。"""
    query = db.query(AssetDevice).filter(AssetDevice.asset_no == asset_no.strip())
    if exclude_id:
        query = query.filter(AssetDevice.id != exclude_id)
    device = query.first()
    if not device:
        return AssetNoCheckOut(exists=False)
    return AssetNoCheckOut(
        exists=True,
        device_name=device.device_name,
        owner_name=device.owner_name,
        status=device.status,
        office_site=device.office_site,
        updated_at=device.updated_at,
    )


@router.get("/devices/{device_id}", summary="资产设备详情", response_model=AssetDeviceOut)
def get_device(
    device_id: str,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    device = _get_owned_device(db, staff, device_id)
    return _asset_out(device)


def _apply_purchase_order_fill(db: Session, data: dict) -> None:
    """若提供 purchase_order_id，从采购单回填未填字段（不覆盖已填值），并固定 purchase_order_no。"""
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == data["purchase_order_id"]).first()
    if not po:
        return
    if not data.get("brand"):
        data["brand"] = po.brand
    if not data.get("model"):
        data["model"] = po.model
    if not data.get("spec"):
        data["spec"] = po.spec
    if data.get("unit_price") is None:
        data["unit_price"] = po.unit_price
    if not data.get("product_images"):
        data["product_images"] = po.product_images or []
    data["purchase_order_no"] = po.order_no


@router.post("/devices", summary="登记资产设备", response_model=AssetDeviceOut)
def create_device(
    body: AssetDeviceCreate,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    data = body.model_dump(exclude_unset=True)
    if not _is_admin(staff):
        data["owner_id"] = staff.id
        data["owner_name"] = staff.name or staff.username
        data["owner_account"] = staff.username
    if data.get("purchase_order_id"):
        _apply_purchase_order_fill(db, data)
    # asset_no：留空自动生成，手填则校验唯一
    if not data.get("asset_no"):
        data["asset_no"] = generate_asset_no(db)
    else:
        existing = db.query(AssetDevice).filter(AssetDevice.asset_no == data["asset_no"]).first()
        if existing:
            raise HTTPException(status_code=409, detail=f"资产编号 {data['asset_no']} 已存在")
    device = AssetDevice(**data)
    db.add(device)
    db.commit()
    db.refresh(device)
    return _asset_out(device)


@router.put("/devices/{device_id}", summary="更新资产设备", response_model=AssetDeviceOut)
def update_device(
    device_id: str,
    body: AssetDeviceUpdate,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    device = _get_owned_device(db, staff, device_id)
    updates = body.model_dump(exclude_unset=True)
    if not _is_admin(staff):
        # 员工不能把自己的资产转给别人
        updates.pop("owner_id", None)
        updates.pop("owner_name", None)
        updates.pop("owner_account", None)
    if updates.get("purchase_order_id"):
        _apply_purchase_order_fill(db, updates)
    if updates.get("asset_no"):
        dup = (
            db.query(AssetDevice)
            .filter(AssetDevice.asset_no == updates["asset_no"], AssetDevice.id != device_id)
            .first()
        )
        if dup:
            raise HTTPException(status_code=409, detail=f"资产编号 {updates['asset_no']} 已存在")
    for key, val in updates.items():
        setattr(device, key, val)
    db.commit()
    db.refresh(device)
    return _asset_out(device)


@router.delete("/devices/{device_id}", summary="删除资产设备")
def delete_device(
    device_id: str,
    db: Session = Depends(get_db),
    staff=Depends(get_current_user),
):
    device = _get_owned_device(db, staff, device_id)
    db.delete(device)
    db.commit()
    return {"detail": "ok"}
