"""Restore tasks failed only by the retired fixed-20 rule to reviewable results.

This migration is intentionally explicit: it requires a batch id and ``--apply``
and preserves the old error in diagnostics before changing the terminal state.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.db import Database, utc_now
from app.models import TaskStatus

LEGACY_PREFIX = "待重试：正式图片不足 20 张"


def restore(path: Path, batch_id: str, *, apply: bool = False) -> int:
    database = Database(path)
    rows = database.list_tasks_for_batch(batch_id)
    targets = [
        row
        for row in rows
        if row.get("status") == TaskStatus.failed
        and str(row.get("error") or "").startswith(LEGACY_PREFIX)
    ]
    if not apply:
        print(f"发现 {len(targets)} 条可恢复任务（使用 --apply 执行）")
        database._connection.close()
        return len(targets)
    for row in targets:
        try:
            diagnostics = json.loads(row.get("diagnostics_json") or "{}")
        except (TypeError, json.JSONDecodeError):
            diagnostics = {}
        if not isinstance(diagnostics, dict):
            diagnostics = {}
        diagnostics["legacy_shortfall_error"] = row.get("error")
        diagnostics["legacy_status"] = row.get("status")
        diagnostics["manual_review_required"] = True
        diagnostics["completion_rule"] = "search_finished_then_manual_pool_review"
        try:
            progress = json.loads(row.get("progress_json") or "{}")
        except (TypeError, json.JSONDecodeError):
            progress = {}
        if not isinstance(progress, dict):
            progress = {}
        progress.update(
            {
                "phase": "completed",
                "phase_label": "待人工划分",
                "percent": 100,
                "eta_seconds": 0,
                "eta_at": None,
                "message": "检索已完成，请在正式图片池和备选图片池之间快速划分",
                "updated_at": utc_now(),
            }
        )
        database.update_task(
            row["task_id"],
            status=TaskStatus.completed,
            error=None,
            diagnostics_json=diagnostics,
            progress_json=progress,
        )
    database._connection.close()
    print(f"已恢复 {len(targets)} 条任务为可复核状态")
    return len(targets)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    restore(args.database, args.batch_id, apply=args.apply)


if __name__ == "__main__":
    main()
