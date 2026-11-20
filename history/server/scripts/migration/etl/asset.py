"""asset_devices / asset_inventory_tasks / asset_inventory_records / asset_reduction_requests。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.asset import (
    AssetDevice,
    AssetInventoryRecord,
    AssetInventoryTask,
    AssetReductionRequest,
)
from scripts.migration.common import (
    IdMapper,
    fen_to_yuan,
    is_soft_deleted,
    iter_jsonl,
    parse_date,
    parse_dt,
    safe_list,
    safe_str,
)


def run_devices(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("asset_devices"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("asset_devices", cloud_id)
        d = AssetDevice(
            id=local_id,
            asset_no=safe_str(doc.get("assetNo"), 32) or f"AS_{cloud_id[:10]}",
            device_name=safe_str(doc.get("deviceName"), 128) or "未命名",
            device_sn=safe_str(doc.get("deviceSN"), 128),
            sn_normalized=safe_str(doc.get("snNormalized"), 128),
            device_type=safe_str(doc.get("deviceType"), 64),
            owner_id=mapper.get("users", doc.get("ownerUserId")),
            owner_name=safe_str(doc.get("ownerName"), 64),
            owner_account=safe_str(doc.get("ownerAccount"), 64),
            office_site=safe_str(doc.get("officeSite"), 64),
            status=safe_str(doc.get("status"), 16) or "IDLE",
            purpose=safe_str(doc.get("purpose"), 256),
            purchase_date=parse_date(doc.get("purchaseDate")),
            cost=fen_to_yuan(doc.get("costFen")),
            remark=safe_str(doc.get("remark")),
            image_files=safe_list(doc.get("imageFiles")),
        )
        if c := parse_dt(doc.get("createdAt")):
            d.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            d.updated_at = u
        db.merge(d)
        n += 1
    return n


def run_tasks(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("asset_inventory_tasks"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("asset_inventory_tasks", cloud_id)
        t = AssetInventoryTask(
            id=local_id,
            title=safe_str(doc.get("title"), 128) or "盘点任务",
            scope_type=safe_str(doc.get("scopeType"), 16) or "OFFICE",
            office_site=safe_str(doc.get("officeSite"), 64),
            device_type=safe_str(doc.get("deviceType"), 64),
            deadline=parse_dt(doc.get("deadline")),
            status=safe_str(doc.get("status"), 16) or "OPEN",
            total_count=int(doc.get("totalCount") or 0),
            checked_count=int(doc.get("checkedCount") or 0),
            abnormal_count=int(doc.get("abnormalCount") or 0),
            last_check_at=parse_dt(doc.get("lastCheckAt")),
            closed_at=parse_dt(doc.get("closedAt")),
            created_by_id=mapper.get("users", doc.get("createdByUserId")),
        )
        if c := parse_dt(doc.get("createdAt")):
            t.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            t.updated_at = u
        db.merge(t)
        n += 1
    return n


def run_records(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("asset_inventory_records"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("asset_inventory_records", cloud_id)
        r = AssetInventoryRecord(
            id=local_id,
            task_id=safe_str(doc.get("taskId"), 64),
            device_id=mapper.get("asset_devices", doc.get("deviceId")),
            asset_no=safe_str(doc.get("assetNo"), 32),
            device_name=safe_str(doc.get("deviceName"), 128),
            device_sn=safe_str(doc.get("deviceSN"), 128),
            sn_normalized=safe_str(doc.get("snNormalized"), 128),
            office_site=safe_str(doc.get("officeSite"), 64),
            owner_id=mapper.get("users", doc.get("ownerUserId")),
            owner_name=safe_str(doc.get("ownerName"), 64),
            owner_account=safe_str(doc.get("ownerAccount"), 64),
            status=safe_str(doc.get("status"), 16) or "PENDING",
            result=safe_str(doc.get("result"), 16) or "UNSET",
            checked_at=parse_dt(doc.get("checkedAt")),
            checked_by_id=mapper.get("users", doc.get("checkedByUserId")),
            note=safe_str(doc.get("note")),
            cycle_type=safe_str(doc.get("cycleType"), 32),
            due_at=parse_dt(doc.get("dueAt")),
            period_key=safe_str(doc.get("periodKey"), 16),
            period_title=safe_str(doc.get("periodTitle"), 64),
            alipay_trade_no=safe_str(doc.get("alipayTradeNo"), 64),
            order_no=safe_str(doc.get("orderNo"), 64),
        )
        if c := parse_dt(doc.get("createdAt")):
            r.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            r.updated_at = u
        db.merge(r)
        n += 1
    return n


def run_reductions(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("asset_reduction_requests"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("asset_reduction_requests", cloud_id)
        r = AssetReductionRequest(
            id=local_id,
            request_no=safe_str(doc.get("requestNo"), 32) or f"AR_{cloud_id[:10]}",
            asset_no=safe_str(doc.get("assetNo"), 32),
            device_id=mapper.get("asset_devices", doc.get("deviceId")),
            device_name=safe_str(doc.get("deviceName"), 128),
            device_sn=safe_str(doc.get("deviceSN"), 128),
            before_status=safe_str(doc.get("beforeStatus"), 16),
            target_status=safe_str(doc.get("targetStatus"), 16),
            reason=safe_str(doc.get("reason"), 32),
            description=safe_str(doc.get("description")),
            attachments=safe_list(doc.get("attachments")),
            office_site=safe_str(doc.get("officeSite"), 64),
            owner_id=mapper.get("users", doc.get("ownerUserId")),
            owner_name=safe_str(doc.get("ownerName"), 64),
            owner_account=safe_str(doc.get("ownerAccount"), 64),
            requested_at=parse_dt(doc.get("requestedAt")),
            requested_by_id=mapper.get("users", doc.get("requestedByUserId")),
            reviewed_at=parse_dt(doc.get("reviewedAt")),
            reviewed_by_id=mapper.get("users", doc.get("reviewedByUserId")),
            review_note=safe_str(doc.get("reviewNote")),
            status=safe_str(doc.get("status"), 16) or "PENDING",
        )
        if c := parse_dt(doc.get("createdAt")):
            r.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            r.updated_at = u
        db.merge(r)
        n += 1
    return n
