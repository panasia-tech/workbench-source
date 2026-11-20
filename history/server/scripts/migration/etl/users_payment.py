"""users → staff,payment_accounts → payment_account。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.payment import PaymentAccount
from app.models.staff import Staff
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    new_local_uuid,
    parse_dt,
    safe_str,
)

# 云端 disabled→DISABLED,正常 → ACTIVE
_STATUS_MAP = {"DISABLED": "DISABLED", "ACTIVE": "ACTIVE", "PENDING": "PENDING"}


def run_users(db: Session, mapper: IdMapper) -> int:
    n = 0
    seq = 0
    for doc in iter_jsonl("users"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("users", cloud_id)
        seq += 1
        s = Staff(
            id=local_id,
            staff_no=safe_str(doc.get("staffNo"), 16) or f"M{seq:05d}",
            username=safe_str(doc.get("account"), 64) or f"user_{cloud_id[:8]}",
            password_hash=safe_str(doc.get("passwordHash"), 256) or "",
            openid=safe_str(doc.get("openid"), 64),
            name=safe_str(doc.get("name"), 64) or "",
            role=safe_str(doc.get("role"), 32) or "PURCHASER",
            shop=safe_str(doc.get("shop"), 64),
            status=_STATUS_MAP.get(safe_str(doc.get("status")) or "", "ACTIVE"),
        )
        created = parse_dt(doc.get("createdAt"))
        updated = parse_dt(doc.get("updatedAt")) or created
        if created:
            s.created_at = created
        if updated:
            s.updated_at = updated
        db.merge(s)
        n += 1
    return n


_CHANNEL_MAP = {"ALIPAY": "ALIPAY", "WECHAT": "WECHAT", "WEIXIN": "WECHAT"}


def run_payment_accounts(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("payment_accounts"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("payment_accounts", cloud_id)
        a = PaymentAccount(
            id=local_id,
            account_alias=safe_str(doc.get("accountAlias"), 64) or "未命名",
            account_hint=safe_str(doc.get("accountHint"), 128),
            channel=_CHANNEL_MAP.get(safe_str(doc.get("channel")) or "", "ALIPAY"),
            usage=safe_str(doc.get("usage"), 16) or "PURCHASE",
            is_system_seed=bool(doc.get("isSystemSeed", False)),
            status=safe_str(doc.get("status"), 16) or "ACTIVE",
        )
        if created := parse_dt(doc.get("createdAt")):
            a.created_at = created
        if updated := parse_dt(doc.get("updatedAt")):
            a.updated_at = updated
        db.merge(a)
        n += 1
    return n
