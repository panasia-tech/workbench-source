"""Move historical shortfall batch tasks into the unfinished/failure list.

The command is intentionally dry-run by default. It changes only completed
tasks below the configured formal-image threshold in one explicitly named
batch; it never deletes images and only augments diagnostics with the
shortfall metadata.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.db import Database, utc_now
from app.models import TaskStatus


def _reason(row: dict[str, object], minimum_formal_images: int = 20) -> str:
    try:
        diagnostics = json.loads(str(row.get("diagnostics_json") or "{}"))
    except json.JSONDecodeError:
        diagnostics = {}
    failures = diagnostics.get("provider_failures") or []
    if failures:
        detail = "；".join(
            f"{item.get('provider', 'provider')}: {item.get('message', '')}" for item in failures
        )
        return (
            f"待重试：正式图片不足 {minimum_formal_images} 张（当前 {row.get('count', 0)} 张）；"
            f"公开来源检索失败。{detail}"
        )
    providers = diagnostics.get("providers") or {}
    degraded = [
        f"{name}: {item.get('message', '')}"
        for name, item in providers.items()
        if isinstance(item, dict) and item.get("state") in {"degraded", "rate_limited"}
    ]
    if degraded:
        return (
            f"待重试：正式图片不足 {minimum_formal_images} 张（当前 {row.get('count', 0)} 张）；"
            f"公开来源检索失败。{'；'.join(degraded)}"
        )
    return (
        f"待重试：正式图片不足 {minimum_formal_images} 张"
        f"（当前 {row.get('count', 0)} 张），未达到任务要求。"
    )


def reclassify_empty_tasks(
    database: Database,
    batch_id: str,
    *,
    apply: bool,
    minimum_formal_images: int = 20,
) -> int:
    batch = database.get_batch(batch_id)
    if not batch:
        raise ValueError(f"batch not found: {batch_id}")
    rows = database.list_tasks_for_batch(batch_id)
    targets = [
        row
        for row in rows
        if row.get("status") in {TaskStatus.completed, TaskStatus.failed}
        and int(row.get("count") or 0) < minimum_formal_images
    ]
    print(
        f"batch={batch_id} total={len(rows)} "
        f"below_{minimum_formal_images}_targets={len(targets)} apply={apply}"
    )
    for row in targets:
        reason = _reason(row, minimum_formal_images)
        print(f"row={row.get('batch_row')} task={row['task_id']} query={row['query']} -> failed: {reason}")
        if not apply:
            continue
        try:
            diagnostics = json.loads(str(row.get("diagnostics_json") or "{}"))
        except json.JSONDecodeError:
            diagnostics = {}
        if not isinstance(diagnostics, dict):
            diagnostics = {}
        diagnostics.update(
            {
                "minimum_formal_images": minimum_formal_images,
                "formal_shortfall": max(
                    0, minimum_formal_images - int(row.get("count") or 0)
                ),
            }
        )
        try:
            progress = json.loads(str(row.get("progress_json") or "{}"))
        except json.JSONDecodeError:
            progress = {}
        progress.update(
            {
                "phase": "failed",
                "phase_label": "未完成 · 待重试",
                "percent": 100,
                "eta_seconds": 0,
                "eta_at": None,
                "message": reason,
                "updated_at": utc_now(),
            }
        )
        database.update_task(
            str(row["task_id"]),
            status=TaskStatus.failed,
            error=reason,
            diagnostics_json=diagnostics,
            progress_json=progress,
        )
    return len(targets)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--database", type=Path, default=Path("data/catalog.sqlite3"))
    parser.add_argument(
        "--apply",
        action="store_true",
        help="apply the reclassification; without this flag only print the targets",
    )
    parser.add_argument(
        "--minimum-formal-images",
        type=int,
        default=20,
        help="mark completed tasks below this formal-image count as unfinished",
    )
    args = parser.parse_args()
    if args.minimum_formal_images < 1:
        parser.error("--minimum-formal-images must be at least 1")
    database = Database(args.database)
    reclassify_empty_tasks(
        database,
        args.batch_id,
        apply=args.apply,
        minimum_formal_images=args.minimum_formal_images,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
