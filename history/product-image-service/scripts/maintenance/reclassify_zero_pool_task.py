"""Move explicitly named completed tasks with no usable image pool to unfinished.

The command is dry-run by default. It requires explicit task IDs and never
deletes images or diagnostics; it only changes the terminal status, reason, and
progress label so the task appears in the batch pending list.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.db import Database, utc_now
from app.models import TaskStatus


def _json_object(value: object) -> dict[str, object]:
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _pool_count(diagnostics: dict[str, object]) -> int:
    pools = diagnostics.get("image_pools")
    if not isinstance(pools, dict):
        return 0
    return sum(
        int((pools.get(name) or {}).get("count") or 0)
        for name in ("formal", "fuzzy", "rejected")
        if isinstance(pools.get(name), dict)
    )


def _reason(row: dict[str, object], diagnostics: dict[str, object]) -> str:
    candidate_count = int(diagnostics.get("candidate_count") or 0)
    reason_labels = {
        "ssrf_blocked": "安全地址校验拦截",
        "download_error": "图片下载失败",
        "invalid_image": "图片格式无法识别",
        "image long edge is below minimum": "图片尺寸不足",
        "insufficient_model_evidence": "型号证据不足",
        "image exceeds pixel limit": "图片尺寸超出限制",
    }
    rejection_reasons = diagnostics.get("rejection_reasons")
    details: list[str] = []
    if isinstance(rejection_reasons, dict):
        for name, count in sorted(
            rejection_reasons.items(),
            key=lambda item: (-int(item[1] or 0), str(item[0])),
        )[:3]:
            details.append(f"{reason_labels.get(str(name), name)} {int(count or 0)} 个")
    suffix = "；" + "、".join(details) if details else ""
    query = str(row.get("query") or row.get("original_query") or "").strip()
    return (
        f"待重试：{query} 未形成可用图片池（原始候选 {candidate_count} 个{suffix}）。"
        "请调整检索名称或稍后重试。"
    )


def reclassify_tasks(
    database: Database, task_ids: list[str], *, apply: bool = False
) -> int:
    targets = []
    for task_id in task_ids:
        row = database.get_task(task_id)
        if not row:
            raise ValueError(f"task not found: {task_id}")
        diagnostics = _json_object(row.get("diagnostics_json"))
        if row.get("status") != TaskStatus.completed:
            print(f"skip task={task_id}: status={row.get('status')}")
            continue
        if int(row.get("count") or 0) != 0 or _pool_count(diagnostics) != 0:
            print(f"skip task={task_id}: task already has a usable image pool")
            continue
        targets.append((row, diagnostics))

    print(f"targets={len(targets)} apply={apply}")
    for row, diagnostics in targets:
        reason = _reason(row, diagnostics)
        print(f"task={row['task_id']} query={row.get('query')} -> failed: {reason}")
        if not apply:
            continue
        diagnostics.update(
            {
                "terminal_reclassification": "zero_usable_image_pool",
                "terminal_reclassification_at": utc_now(),
                "manual_review_required": False,
            }
        )
        progress = _json_object(row.get("progress_json"))
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
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--task-id", action="append", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    database = Database(args.database)
    try:
        reclassify_tasks(database, args.task_id, apply=args.apply)
    finally:
        database._connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
