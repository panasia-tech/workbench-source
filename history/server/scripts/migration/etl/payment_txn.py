"""payment_bindings & payment_transactions。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.payment import PaymentBinding, PaymentTransaction
from scripts.migration.common import (
    IdMapper,
    fen_to_yuan,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_dict,
    safe_str,
)


def _resolve_entity_local(mapper: IdMapper, entity_type: str | None, cloud_id: str | None) -> str | None:
    if not entity_type or not cloud_id:
        return cloud_id
    if entity_type == "PURCHASE":
        return mapper.get("purchase_orders", cloud_id) or cloud_id
    if entity_type == "SALES":
        return mapper.get("sales_orders", cloud_id) or cloud_id
    return cloud_id


def run_bindings(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("payment_bindings"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("payment_bindings", cloud_id)
        account_local = mapper.get("payment_accounts", doc.get("accountId"))
        if not account_local:
            continue
        entity_type = safe_str(doc.get("entityType"), 16) or "PURCHASE"
        entity_local = _resolve_entity_local(mapper, entity_type, doc.get("entityId"))
        b = PaymentBinding(
            id=local_id,
            account_id=account_local,
            entity_type=entity_type,
            entity_id=entity_local or doc.get("entityId") or "",
            out_trade_no=safe_str(doc.get("outTradeNo"), 64),
            direction=safe_str(doc.get("direction"), 8) or "OUT",
            expected_amount=fen_to_yuan(doc.get("expectedAmountFen")),
            alipay_trade_no=safe_str(doc.get("alipayTradeNo"), 64),
        )
        if c := parse_dt(doc.get("createdAt")):
            b.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            b.updated_at = u
        db.merge(b)
        n += 1
    return n


def run_transactions(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("payment_transactions"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("payment_transactions", cloud_id)
        account_local = mapper.get("payment_accounts", doc.get("accountId"))
        if not account_local:
            continue
        t = PaymentTransaction(
            id=local_id,
            account_id=account_local,
            channel=safe_str(doc.get("channel"), 16) or "ALIPAY",
            direction=safe_str(doc.get("direction"), 8) or "OUT",
            amount=fen_to_yuan(doc.get("amountFen")),
            counterparty_hint=safe_str(doc.get("counterpartyHint"), 256),
            out_trade_no=safe_str(doc.get("outTradeNo"), 64),
            txn_id=safe_str(doc.get("txnId"), 64),
            status=safe_str(doc.get("status"), 16) or "SUCCESS",
            source=safe_str(doc.get("source"), 16) or "MANUAL",
            trade_time=parse_dt(doc.get("tradeTime")),
            ingested_at=parse_dt(doc.get("ingestedAt")),
            raw=safe_dict(doc.get("raw")),
        )
        if c := parse_dt(doc.get("createdAt")):
            t.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            t.updated_at = u
        db.merge(t)
        n += 1
    return n
