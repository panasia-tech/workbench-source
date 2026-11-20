"""Restore candidate pools cleared by an older retry implementation.

The command is dry-run by default and requires explicit task IDs. It reads
pool data from a read-only SQLite backup, changes only the named current rows,
and preserves their current query, failure reason, retry history, and status.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

from app.db import Database, utc_now


def _json_object(value: object) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _json_list(value: object) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(str(value or "[]"))
    except (TypeError, json.JSONDecodeError):
        return []
    return [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []


def _read_source_rows(path: Path, task_ids: list[str]) -> dict[str, dict[str, Any]]:
    uri = f"file:{path.resolve()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        placeholders = ",".join("?" for _ in task_ids)
        rows = connection.execute(
            f"SELECT * FROM tasks WHERE task_id IN ({placeholders})", task_ids
        ).fetchall()
        return {str(row["task_id"]): dict(row) for row in rows}
    finally:
        connection.close()


def _pool_payload(row: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    images = _json_list(row.get("images_json"))
    diagnostics = _json_object(row.get("diagnostics_json"))
    fuzzy = [item for item in diagnostics.get("fuzzy_previews", []) if isinstance(item, dict)]
    rejected = [item for item in diagnostics.get("rejected_previews", []) if isinstance(item, dict)]
    diagnostics["fuzzy_previews"] = fuzzy
    diagnostics["rejected_previews"] = rejected
    diagnostics["fuzzy_preview_count"] = len(fuzzy)
    diagnostics["rejected_preview_count"] = len(rejected)
    diagnostics["safe_rejected_preview_count"] = len(fuzzy) + len(rejected)
    diagnostics["image_pools"] = {
        "formal": {"count": len(images)},
        "fuzzy": {"count": len(fuzzy)},
        "rejected": {"count": len(rejected)},
    }
    return images, diagnostics


def restore_retry_candidate_pools(
    database: Database,
    source_database: Path,
    task_ids: list[str],
    *,
    apply: bool = False,
) -> int:
    source_rows = _read_source_rows(source_database, task_ids)
    targets: list[
        tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]], dict[str, Any]]
    ] = []
    for task_id in task_ids:
        current = database.get_task(task_id)
        if not current:
            raise ValueError(f"task not found: {task_id}")
        source = source_rows.get(task_id)
        if not source:
            print(f"skip task={task_id}: source row not found")
            continue
        current_images, current_diagnostics = _pool_payload(current)
        source_images, source_diagnostics = _pool_payload(source)
        current_pool_count = len(current_images) + len(current_diagnostics["fuzzy_previews"]) + len(
            current_diagnostics["rejected_previews"]
        )
        source_pool_count = len(source_images) + len(source_diagnostics["fuzzy_previews"]) + len(
            source_diagnostics["rejected_previews"]
        )
        if current_pool_count:
            print(f"skip task={task_id}: current pool is not empty")
            continue
        if not source_pool_count:
            print(f"skip task={task_id}: source pool is empty")
            continue
        targets.append((current, source, source_images, source_diagnostics))

    print(f"targets={len(targets)} apply={apply}")
    for current, _source, source_images, source_diagnostics in targets:
        task_id = str(current["task_id"])
        current_diagnostics = _json_object(current.get("diagnostics_json"))
        merged = dict(source_diagnostics)
        # Current metadata is authoritative after later retries or edited names.
        for key in (
            "retry_history",
            "retry_count",
            "original_query",
            "retry_snapshots",
            "provider_failures",
            "terminal_reclassification",
            "terminal_reclassification_at",
        ):
            if key in current_diagnostics:
                merged[key] = current_diagnostics[key]
        restored_at = utc_now()
        merged.update(
            {
                "restored_from_retry_backup": True,
                "restored_from_retry_backup_at": restored_at,
                "restored_from_retry_backup_query": str(source_diagnostics.get("query") or ""),
            }
        )
        # The restored pool is intentionally active so operators can classify it.
        # It is not duplicated into retry_snapshots; a later retry will snapshot
        # this restored attempt through ImageService.retry_task.
        merged.pop("retry_snapshots", None)
        progress = _json_object(current.get("progress_json"))
        progress.update(
            {
                "phase": "failed",
                "phase_label": "未完成 · 可先复核",
                "percent": 100,
                "eta_seconds": 0,
                "eta_at": None,
                "message": "已恢复上一轮图片池；可预览后再决定是否重新搜索",
                "restored_previous_pool": True,
                "restored_previous_pool_at": restored_at,
            }
        )
        print(
            f"task={task_id} query={current.get('query')} -> "
            f"formal={len(source_images)} fuzzy={len(merged['fuzzy_previews'])} "
            f"rejected={len(merged['rejected_previews'])}"
        )
        if apply:
            database.update_task(
                task_id,
                count=len(source_images),
                images_json=source_images,
                diagnostics_json=merged,
                progress_json=progress,
            )
    return len(targets)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--source-database", type=Path, required=True)
    parser.add_argument("--task-id", action="append", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    database = Database(args.database)
    try:
        restore_retry_candidate_pools(
            database,
            args.source_database,
            args.task_id,
            apply=args.apply,
        )
    finally:
        database._connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
