from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import exists, not_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import ArchiveBatchStatus, OrderStatus, StaffRole
from app.models import ArchiveBatch, ArchiveOrder, PurchaseOrder, Staff
from app.schemas.archive import (
    ArchiveBatchCreate,
    ArchiveBatchListResponse,
    ArchiveBatchOut,
    ArchiveEligibleListResponse,
    ArchiveEligibleOrderOut,
    ArchiveOrderOut,
)
from app.services.archive_collect import (
    apply_media_unavailable,
    binding_to_dict,
    collect_order_media,
)
from app.services.archive_fc import invoke_archive_pack
from app.services.order_no import generate_order_no
from app.services.oss import delete_object_keys, sign_download_url
from app.services.staff_lookup import map_staff_names

router = APIRouter(prefix="/api/archive", tags=["archive"])

TERMINAL_STATUSES = (OrderStatus.SHIPPED, OrderStatus.LOSS, OrderStatus.CANCELLED)
ARCHIVE_MIN_DAYS = 7
ACTIVE_BATCH_STATUSES = (
    ArchiveBatchStatus.PENDING,
    ArchiveBatchStatus.PACKING,
    ArchiveBatchStatus.READY,
)


def _batch_out(batch: ArchiveBatch, names: dict[str, str], orders: list[ArchiveOrder] | None = None) -> ArchiveBatchOut:
    data = ArchiveBatchOut.model_validate(batch).model_dump()
    data["created_by_name"] = names.get(batch.created_by_id)
    if orders is not None:
        data["orders"] = [ArchiveOrderOut.model_validate(o) for o in orders]
    elif batch.package_object_key and not batch.package_url:
        data["package_url"] = sign_download_url(batch.package_object_key)
    return ArchiveBatchOut(**data)


def _fully_archived_exists():
    return exists().where(
        ArchiveOrder.purchase_order_id == PurchaseOrder.id,
        ArchiveOrder.oss_deleted_at.isnot(None),
    )


def _active_archive_exists():
    return exists().where(
        ArchiveOrder.purchase_order_id == PurchaseOrder.id,
        ArchiveOrder.batch_id == ArchiveBatch.id,
        ArchiveBatch.status.in_(ACTIVE_BATCH_STATUSES),
        ArchiveOrder.oss_deleted_at.is_(None),
    )


def _is_fully_archived(db: Session, purchase_order_id: str) -> bool:
    return (
        db.query(ArchiveOrder)
        .filter(
            ArchiveOrder.purchase_order_id == purchase_order_id,
            ArchiveOrder.oss_deleted_at.isnot(None),
        )
        .first()
        is not None
    )


def _has_active_archive(db: Session, purchase_order_id: str) -> bool:
    return (
        db.query(ArchiveOrder)
        .join(ArchiveBatch, ArchiveOrder.batch_id == ArchiveBatch.id)
        .filter(
            ArchiveOrder.purchase_order_id == purchase_order_id,
            ArchiveBatch.status.in_(ACTIVE_BATCH_STATUSES),
            ArchiveOrder.oss_deleted_at.is_(None),
        )
        .first()
        is not None
    )


@router.get("/eligible", summary="查询可归档采购单", response_model=ArchiveEligibleListResponse)
def list_eligible_orders(
    q: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    cutoff = datetime.utcnow() - timedelta(days=ARCHIVE_MIN_DAYS)
    query = db.query(PurchaseOrder).filter(
        PurchaseOrder.status.in_(TERMINAL_STATUSES),
        PurchaseOrder.updated_at < cutoff,
        not_(_fully_archived_exists()),
        not_(_active_archive_exists()),
    )
    if q:
        like = f"%{q}%"
        query = query.filter(
            (PurchaseOrder.order_no.like(like))
            | (PurchaseOrder.product_name.like(like))
            | (PurchaseOrder.brand.like(like))
            | (PurchaseOrder.model.like(like))
        )
    total = query.count()
    orders = (
        query.order_by(PurchaseOrder.updated_at.asc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    items = []
    for order in orders:
        bundle = collect_order_media(db, order)
        items.append(
            ArchiveEligibleOrderOut(
                id=order.id,
                order_no=order.order_no,
                status=order.status,
                product_name=order.product_name,
                file_count=len(bundle.files),
                ended_at=order.updated_at,
                created_at=order.created_at,
            )
        )
    return ArchiveEligibleListResponse(items=items, total=total, page=page, size=size)


@router.get("/batches", summary="归档批次列表", response_model=ArchiveBatchListResponse)
def list_batches(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    query = db.query(ArchiveBatch)
    total = query.count()
    batches = (
        query.order_by(ArchiveBatch.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    names = map_staff_names(db, {b.created_by_id for b in batches})
    items = [_batch_out(b, names) for b in batches]
    return ArchiveBatchListResponse(items=items, total=total, page=page, size=size)


@router.get("/batches/{batch_id}", summary="归档批次详情", response_model=ArchiveBatchOut)
def get_batch(
    batch_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    batch = db.get(ArchiveBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="归档批次不存在")
    orders = db.query(ArchiveOrder).filter(ArchiveOrder.batch_id == batch_id).all()
    names = map_staff_names(db, {batch.created_by_id})
    out = _batch_out(batch, names, orders)
    if batch.package_object_key:
        out.package_url = sign_download_url(batch.package_object_key)
    return out


@router.post("/batches", summary="创建归档批次", response_model=ArchiveBatchOut)
async def create_batch(
    body: ArchiveBatchCreate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    cutoff = datetime.utcnow() - timedelta(days=ARCHIVE_MIN_DAYS)
    orders = db.query(PurchaseOrder).filter(PurchaseOrder.id.in_(body.purchase_order_ids)).all()
    if len(orders) != len(set(body.purchase_order_ids)):
        raise HTTPException(status_code=400, detail="部分采购订单不存在")

    bundles = []
    bindings_map: dict[str, list] = {}
    keys_map: dict[str, list] = {}
    for order in orders:
        if order.status not in TERMINAL_STATUSES:
            raise HTTPException(status_code=400, detail=f"{order.order_no} 未处于终态，不可归档")
        if order.updated_at >= cutoff:
            raise HTTPException(status_code=400, detail=f"{order.order_no} 结束未满 {ARCHIVE_MIN_DAYS} 天")
        if _is_fully_archived(db, order.id):
            raise HTTPException(status_code=400, detail=f"{order.order_no} 已归档并清理 OSS")
        if _has_active_archive(db, order.id):
            raise HTTPException(status_code=400, detail=f"{order.order_no} 已在进行中的归档批次中")

        bundle = collect_order_media(db, order)
        if not bundle.files:
            raise HTTPException(status_code=400, detail=f"{order.order_no} 无可归档媒体文件")
        bundles.append(bundle)
        bindings_map[order.id] = [binding_to_dict(f.binding) for f in bundle.files]
        keys_map[order.id] = [f.object_key for f in bundle.files]

    batch_no = generate_order_no(db, "AB", ArchiveBatch, "batch_no")
    batch = ArchiveBatch(
        batch_no=batch_no,
        status=ArchiveBatchStatus.PACKING,
        order_count=len(orders),
        file_count=sum(len(b.files) for b in bundles),
        created_by_id=user.id,
    )
    db.add(batch)
    db.flush()

    for order in orders:
        db.add(
            ArchiveOrder(
                batch_id=batch.id,
                purchase_order_id=order.id,
                order_no=order.order_no,
                file_count=len(keys_map[order.id]),
                object_keys=keys_map[order.id],
                media_bindings=bindings_map[order.id],
            )
        )
    db.commit()

    try:
        fc_result = await invoke_archive_pack(batch_no, bundles)
        batch.status = fc_result.get("status", ArchiveBatchStatus.READY)
        batch.fc_request_id = fc_result.get("request_id")
        batch.package_object_key = fc_result.get("package_object_key")
        batch.package_url = fc_result.get("package_url")
        if batch.status == ArchiveBatchStatus.READY:
            batch.packed_at = datetime.utcnow()
        if fc_result.get("message"):
            batch.error_message = fc_result["message"]
    except Exception as exc:
        batch.status = ArchiveBatchStatus.FAILED
        batch.error_message = str(exc)
    db.commit()
    db.refresh(batch)
    archive_orders = db.query(ArchiveOrder).filter(ArchiveOrder.batch_id == batch.id).all()
    names = map_staff_names(db, {user.id})
    return _batch_out(batch, names, archive_orders)


@router.post("/batches/{batch_id}/refresh-package-url", summary="刷新归档包下载链接", response_model=ArchiveBatchOut)
def refresh_package_url(
    batch_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    batch = db.get(ArchiveBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="归档批次不存在")
    if not batch.package_object_key:
        raise HTTPException(status_code=400, detail="批次尚无打包文件")
    batch.package_url = sign_download_url(batch.package_object_key, expires=86400 * 7)
    db.commit()
    db.refresh(batch)
    orders = db.query(ArchiveOrder).filter(ArchiveOrder.batch_id == batch_id).all()
    names = map_staff_names(db, {batch.created_by_id})
    return _batch_out(batch, names, orders)


@router.post("/batches/{batch_id}/delete-oss", summary="删除批次 OSS 文件", response_model=ArchiveBatchOut)
def delete_batch_oss(
    batch_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    batch = db.get(ArchiveBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="归档批次不存在")
    if batch.status != ArchiveBatchStatus.READY:
        raise HTTPException(status_code=400, detail="仅打包完成且未清理的批次可删除 OSS")
    if batch.oss_deleted_at:
        raise HTTPException(status_code=400, detail="OSS 已清理")

    archive_orders = db.query(ArchiveOrder).filter(ArchiveOrder.batch_id == batch_id).all()
    all_keys: list[str] = []
    for item in archive_orders:
        all_keys.extend(item.object_keys or [])
        for binding in item.media_bindings or []:
            apply_media_unavailable(db, binding)
        item.oss_deleted_at = datetime.utcnow()

    if batch.package_object_key:
        all_keys.append(batch.package_object_key)

    result = delete_object_keys(all_keys)
    if result.get("failed"):
        raise HTTPException(
            status_code=502,
            detail=f"部分 OSS 对象删除失败: {', '.join(result['failed'][:5])}",
        )

    now = datetime.utcnow()
    batch.status = ArchiveBatchStatus.OSS_DELETED
    batch.oss_deleted_at = now
    db.commit()
    db.refresh(batch)
    names = map_staff_names(db, {batch.created_by_id})
    return _batch_out(batch, names, archive_orders)
