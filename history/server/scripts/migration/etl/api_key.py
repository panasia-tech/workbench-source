"""llm_api_keys → api_key。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.api_key import ApiKey
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_dt,
    safe_list,
    safe_str,
)


def run(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("llm_api_keys"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("llm_api_keys", cloud_id)
        k = ApiKey(
            id=local_id,
            name=safe_str(doc.get("name"), 128) or f"key_{cloud_id[:8]}",
            key_hash=safe_str(doc.get("keyHash"), 512) or "",
            scopes=safe_list(doc.get("scopes")),
            status=safe_str(doc.get("status"), 16) or "ACTIVE",
            last_used_at=parse_dt(doc.get("lastUsedAt")),
            created_by_id=mapper.get("users", doc.get("createdByUserId")),
        )
        if c := parse_dt(doc.get("createdAt")):
            k.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            k.updated_at = u
        db.merge(k)
        n += 1
    return n
