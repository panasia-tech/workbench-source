from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
from collections import Counter
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import httpx
from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import HTMLResponse, JSONResponse

from .adapters import AdapterRegistry
from .config import Settings, get_settings
from .db import Database, utc_now
from .excel_import import ExcelImportError, read_xlsx_rows
from .models import (
    BatchItemSummary,
    BatchListResponse,
    BatchResponse,
    BatchSummary,
    BlockedDomainRequest,
    CredentialUpdate,
    EmployeeReviewRequest,
    EmployeeTaskSummary,
    EmployeeWorkbenchResponse,
    LoginRequest,
    OrchestrationToggle,
    PoolDecisionRequest,
    ReviewStatus,
    SearchAccepted,
    SearchPolicyUpdate,
    SearchRequest,
    SearchTier,
    TaskQueueResponse,
    TaskResponse,
    TaskRetryRequest,
    TaskStatus,
    TaskSummary,
    resolve_task_lane,
)
from .pipeline import ImageService
from .security import AdminSession

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


PROVIDER_SCHEMAS = {
    "official": {
        "fields": [],
        "description": "Known official domain pages; no credential required.",
    },
    "bing_public": {
        "fields": [],
        "description": "Public Bing Images HTML fallback; may degrade if rate limited.",
    },
    "brave": {"fields": ["api_key"], "description": "Brave Image Search API token."},
    "google": {
        "fields": ["api_key", "cx"],
        "description": "Google API key and Programmable Search Engine ID.",
    },
    "searxng": {
        "fields": ["url"],
        "description": "Self-hosted or trusted SearXNG endpoint with JSON format enabled.",
    },
    "reddit": {
        "fields": ["client_id", "client_secret", "user_agent"],
        "description": "Reddit OAuth application credentials and descriptive User-Agent.",
    },
    "douyin": {
        "fields": ["access_token", "device_id"],
        "description": "Official Douyin search access token and device ID.",
    },
    "xiaohongshu": {
        "fields": ["adapter_url", "cookie"],
        "description": "A legal, user-controlled adapter and login state; no private bypass.",
    },
    "gallery_dl": {
        "fields": ["binary"],
        "description": "Optional gallery-dl executable for explicit public URLs.",
    },
    "playwright": {
        "fields": ["enabled"],
        "description": "Last-resort browser fallback; disabled by default.",
    },
}
MAX_BATCH_UPLOAD_BYTES = 10 * 1024 * 1024
WALLPAPER_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
EMPLOYEE_TIMEZONE = ZoneInfo("Asia/Shanghai")


def _wallpaper_runner_processes(script: Path) -> list[dict[str, object]]:
    """Return processes running the configured Wallpaper runner.

    The runner is intentionally discovered by its exact configured path so a
    status page cannot accidentally report an unrelated Python process.
    """
    if not script:
        return []
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    needle = str(script)
    processes: list[dict[str, object]] = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(maxsplit=1)
        if len(parts) != 2:
            continue
        command = parts[1]
        # Match the script as an argv token, not as text inside a shell/rg
        # command that happens to mention the path while diagnostics run.
        padded_command = f" {command} "
        if f" {needle} " not in padded_command and not command.endswith(needle):
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        if pid == os.getpid():
            continue
        processes.append({"pid": pid, "command": command[:240]})
    return processes


def _wallpaper_image_records(
    directory: Path, *, query: str = "", limit: int = 40, offset: int = 0
) -> tuple[int, int, list[dict[str, object]]]:
    """Read the flat image output folder without recursing into staging data."""
    if not directory.is_dir():
        return 0, 0, []
    query_value = query.strip().casefold()
    matched: list[tuple[float, Path, int]] = []
    total_bytes = 0
    total_count = 0
    try:
        entries = directory.iterdir()
        for entry in entries:
            if not entry.is_file() or entry.suffix.casefold() not in WALLPAPER_IMAGE_EXTENSIONS:
                continue
            try:
                info = entry.stat()
            except OSError:
                continue
            total_count += 1
            total_bytes += int(info.st_size)
            if query_value and query_value not in entry.name.casefold():
                continue
            matched.append((float(info.st_mtime), entry, int(info.st_size)))
    except OSError:
        return total_count, total_bytes, []
    matched.sort(key=lambda item: item[0], reverse=True)
    page = matched[max(offset, 0) : max(offset, 0) + max(limit, 1)]
    records = [
        {
            "name": entry.name,
            "size_bytes": size,
            "url": f"/v1/wallpaper/files/{entry.name}",
            "updated_at": datetime.fromtimestamp(mtime, UTC).isoformat(),
        }
        for mtime, entry, size in page
    ]
    return total_count, total_bytes, records


def _wallpaper_player_records(
    directory: Path, *, query: str = "", length: int = 100, offset: int = 0
) -> tuple[int, int, list[dict[str, object]]]:
    """Return a fixed-length frame sequence for the 10-second player.

    The player has a strict 100-slot contract. When a narrow filename filter
    returns fewer than 100 files, cycling those safe records keeps the timing
    contract intact without inventing or copying files on disk.
    """
    safe_length = max(1, min(int(length), 100))
    safe_offset = max(int(offset), 0)
    total, total_bytes, records = _wallpaper_image_records(
        directory, query=query, limit=safe_length, offset=safe_offset
    )
    if not records and safe_offset:
        total, total_bytes, records = _wallpaper_image_records(
            directory, query=query, limit=safe_length, offset=0
        )
    if not records:
        return total, total_bytes, []
    sequence = []
    for index in range(safe_length):
        record = dict(records[index % len(records)])
        record["frame_index"] = index + 1
        record["player_url"] = f"/v1/wallpaper/player/files/{record['name']}"
        sequence.append(record)
    return total, total_bytes, sequence


def _wallpaper_status(settings: Settings) -> dict[str, object]:
    root = settings.wallpaper_root.expanduser()
    output = settings.wallpaper_output_dir.expanduser()
    disk_target = root if root.exists() else output
    try:
        usage = shutil.disk_usage(disk_target)
        total_bytes = int(usage.total)
        free_bytes = int(usage.free)
    except OSError:
        total_bytes = free_bytes = 0
    image_count, image_bytes, _ = _wallpaper_image_records(output, limit=1)
    runner_path = settings.wallpaper_runner_script.expanduser()
    processes = _wallpaper_runner_processes(runner_path)
    api_key_configured = bool(os.environ.get("STEAM_API_KEY", "").strip())
    try:
        worker_limit = max(1, min(int(os.environ.get("WALLPAPER_WORKERS", "5")), 32))
    except ValueError:
        worker_limit = 5
    try:
        login_interval = max(0.0, float(os.environ.get("WALLPAPER_LOGIN_INTERVAL", "1")))
    except ValueError:
        login_interval = 1.0
    if processes:
        status = "running"
    elif not output.is_dir() or not runner_path.is_file():
        status = "unavailable"
    elif not api_key_configured:
        status = "auth_required"
    else:
        status = "ready"
    free_percent = round((free_bytes / total_bytes) * 100, 2) if total_bytes else None
    margin_bytes = (
        int(total_bytes * settings.wallpaper_free_margin_percent / 100) if total_bytes else 0
    )
    return {
        "status": status,
        "runner": {
            "configured": runner_path.is_file(),
            "path": str(runner_path),
            "api_key_configured": api_key_configured,
            "worker_limit": worker_limit,
            "login_interval_seconds": login_interval,
            "pids": [item["pid"] for item in processes],
        },
        "output_dir": str(output),
        "images": {"count": image_count, "bytes": image_bytes},
        "disk": {
            "mount": str(disk_target),
            "total_bytes": total_bytes,
            "free_bytes": free_bytes,
            "free_percent": free_percent,
            "stop_margin_percent": settings.wallpaper_free_margin_percent,
            "stop_margin_bytes": margin_bytes,
        },
        "policy": {
            "image_extensions": sorted(WALLPAPER_IMAGE_EXTENSIONS),
            "skip_video": True,
            "max_source_file_bytes": 10 * 1024 * 1024,
        },
        "last_updated_at": utc_now(),
    }


def _json_object(value: object, default: dict[str, object] | None = None) -> dict[str, object]:
    if isinstance(value, dict):
        return dict(value)
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, json.JSONDecodeError):
        return dict(default or {})
    return parsed if isinstance(parsed, dict) else dict(default or {})


def _normalise_file_url(value: object, public_base_url: str) -> object:
    """Rewrite persisted local file URLs for the current deployment.

    Older tasks can contain URLs generated with a previous ``PUBLIC_BASE_URL``
    (including ``127.0.0.1``).  The file name is still valid after migration;
    only the origin is stale.  Restrict the rewrite to the service's own
    ``/files/<filename>`` route so external source URLs are left untouched.
    """
    if not isinstance(value, str) or not value:
        return value
    parsed = urlsplit(value)
    path = parsed.path or ""
    prefix = "/files/"
    filename = path.removeprefix(prefix)
    if not path.startswith(prefix) or not filename or "/" in filename:
        return value
    if not filename.replace(".", "").isalnum():
        return value
    if not parsed.netloc:
        return value
    base = public_base_url.rstrip("/")
    return f"{base}{path}" if base else path


def _normalise_file_urls(value: object, public_base_url: str) -> object:
    """Recursively normalise internal file URLs in result payloads."""
    if isinstance(value, list):
        return [_normalise_file_urls(item, public_base_url) for item in value]
    if isinstance(value, dict):
        return {
            key: (
                _normalise_file_url(item, public_base_url)
                if key == "url"
                else _normalise_file_urls(item, public_base_url)
            )
            for key, item in value.items()
        }
    return value


def _elapsed_seconds(started_at: str | None, finished_at: str | None = None) -> float:
    if not started_at:
        return 0.0
    try:
        started = datetime.fromisoformat(started_at)
        ended = datetime.fromisoformat(finished_at) if finished_at else datetime.now(UTC)
        return max(0.0, (ended - started).total_seconds())
    except (TypeError, ValueError):
        return 0.0


def _task_progress(row: dict[str, object], queue_position: int | None = None) -> dict[str, object]:
    progress = _json_object(row.get("progress_json"))
    status = str(row.get("status", ""))
    if status == TaskStatus.queued:
        estimate = max(
            1.0,
            float(
                progress.get("estimated_seconds")
                or ImageService.estimate_task_seconds(int(row.get("result_limit", 20) or 20))
            ),
        )
        progress.update(
            {
                "phase": progress.get("phase", "queued"),
                "phase_label": progress.get("phase_label", "排队等待"),
                "percent": float(progress.get("percent", 0) or 0),
                "elapsed_seconds": 0,
                "estimated_seconds": estimate,
                "eta_seconds": estimate,
                "eta_at": None,
                "message": progress.get("message", "等待前面的任务完成"),
            }
        )
    elif status == TaskStatus.processing:
        elapsed = _elapsed_seconds(row.get("started_at"))
        percent = max(0.0, min(99.0, float(progress.get("percent", 0) or 0)))
        estimate = max(1.0, float(progress.get("estimated_seconds", 0) or 0))
        if percent >= 5 and elapsed > 0:
            estimate = max(estimate, elapsed / (percent / 100.0))
        eta = max(0.0, estimate - elapsed)
        progress.update(
            {
                "elapsed_seconds": round(elapsed, 1),
                "estimated_seconds": round(estimate, 1),
                "eta_seconds": round(eta, 1),
                "eta_at": (
                    (datetime.now(UTC) + timedelta(seconds=eta)).isoformat()
                    if eta > 0
                    else None
                ),
            }
        )
    elif status in {TaskStatus.completed, TaskStatus.failed, TaskStatus.cancelled}:
        progress["elapsed_seconds"] = round(
            _elapsed_seconds(row.get("started_at"), row.get("finished_at")), 1
        )
        progress["eta_seconds"] = 0
        progress["eta_at"] = None
    if queue_position is not None:
        progress["queue_position"] = queue_position
    return progress


def _query_history(
    row: dict[str, object], diagnostics: dict[str, object] | None = None
) -> list[str]:
    current = str(row.get("query") or "").strip()
    original = str(row.get("original_query") or current).strip()
    if diagnostics is None:
        try:
            diagnostics = json.loads(str(row.get("diagnostics_json") or "{}"))
        except json.JSONDecodeError:
            diagnostics = {}
    values = [original] if original else []
    retry_history = diagnostics.get("retry_history") if isinstance(diagnostics, dict) else []
    if isinstance(retry_history, list):
        for item in retry_history:
            if isinstance(item, dict):
                next_query = str(item.get("next_query") or "").strip()
                if next_query:
                    values.append(next_query)
    if current:
        values.append(current)
    return list(dict.fromkeys(values))


def _pool_key(item: object) -> str:
    if not isinstance(item, dict):
        return ""
    return str(item.get("image_key") or item.get("url") or item.get("source_url") or "").strip()


def _preview_as_image(item: dict[str, object]) -> dict[str, object]:
    """Fill the formal-image shape when an operator promotes a preview."""
    return {
        "url": item.get("url", ""),
        "source_url": item.get("source_url", ""),
        "source_domain": item.get("source_domain", ""),
        "source_type": item.get("source_type", "web"),
        "width": int(item.get("width", 0) or 0),
        "height": int(item.get("height", 0) or 0),
        "watermark": item.get("watermark", "unknown"),
        "product_confidence": float(item.get("product_confidence", 0.0) or 0.0),
        "score": float(item.get("score", 0.0) or 0.0),
        "provider": item.get("provider", ""),
        "platform": item.get("platform", ""),
        "media_origin": item.get("media_origin", "unknown"),
        "image_class": item.get("image_class", "unknown"),
        "real_photo_confidence": float(item.get("real_photo_confidence", 0.0) or 0.0),
        "review_url": item.get("review_url", ""),
        "review_id": item.get("review_id", ""),
        "quality_score": float(item.get("quality_score", 0.0) or 0.0),
        "quality_grade": str(item.get("quality_grade") or ""),
        "quality_flags": list(item.get("quality_flags") or []),
    }


def _merge_image_pools(
    images: object, diagnostics: dict[str, object], decisions: dict[str, object]
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    formal = [dict(item) for item in images if isinstance(item, dict)] if isinstance(images, list) else []
    fuzzy = diagnostics.get("fuzzy_previews", [])
    rejected = diagnostics.get("rejected_previews", [])
    out_formal: list[dict[str, object]] = []
    out_candidates: list[dict[str, object]] = []
    decision_map = {str(key): str(value) for key, value in decisions.items() if str(value) in {"formal", "candidate"}}
    # 淘汰图(多是搜索词跑偏搜出来的无关图)不再给员工看,只在管理后台回看;
    # 以前被人工提升过的淘汰图照旧按人工决定放。
    candidates = [dict(item) for item in (fuzzy if isinstance(fuzzy, list) else []) if isinstance(item, dict)]
    candidates += [
        dict(item)
        for item in (rejected if isinstance(rejected, list) else [])
        if isinstance(item, dict) and _pool_key(item) in decision_map
    ]
    for item in formal:
        key = _pool_key(item)
        if decision_map.get(key) == "candidate":
            moved = dict(item)
            moved["pool"] = "candidate"
            moved["manual_decision"] = "candidate"
            out_candidates.append(moved)
        else:
            out_formal.append(_preview_as_image(item))
    for item in candidates:
        key = _pool_key(item)
        if decision_map.get(key) == "formal":
            promoted = _preview_as_image(item)
            promoted["manual_decision"] = "formal"
            out_formal.append(promoted)
        else:
            item["pool"] = "candidate"
            if decision_map.get(key):
                item["manual_decision"] = decision_map[key]
            out_candidates.append(item)
    return out_formal, out_candidates


def _task_response(row: dict[str, object], public_base_url: str = "") -> TaskResponse:
    images = _normalise_file_urls(json.loads(row["images_json"]), public_base_url)
    diagnostics = _normalise_file_urls(json.loads(row["diagnostics_json"]), public_base_url)
    decisions = _json_object(row.get("pool_decisions_json"))
    formal_images, candidate_images = _merge_image_pools(images, diagnostics, decisions)
    retry_snapshots = diagnostics.get("retry_snapshots", []) if isinstance(diagnostics, dict) else []
    if not isinstance(retry_snapshots, list):
        retry_snapshots = []
    return TaskResponse(
        task_id=row["task_id"],
        query=row["query"],
        original_query=str(row.get("original_query") or row["query"]),
        query_history=_query_history(row, diagnostics),
        brand=row["brand"],
        model=row["model"],
        image_mode=row.get("image_mode", "all"),
        search_tier=row.get("search_tier", SearchTier.balanced.value),
        locale=row.get("locale"),
        limit=row.get("result_limit", 20),
        profile=str(row.get("profile") or "auto"),
        min_results=int(row.get("min_results") or 0),
        recall_version=int(row.get("recall_version") or 1),
        status=row["status"],
        lane=resolve_task_lane(row["status"], row.get("review_status") or ReviewStatus.pending),
        count=len(formal_images),
        images=formal_images,
        candidate_images=candidate_images,
        retry_snapshots=retry_snapshots,
        pool_decisions=decisions,
        diagnostics=diagnostics,
        error=row["error"],
        progress=_task_progress(row),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        started_at=row.get("started_at"),
        finished_at=row.get("finished_at"),
        assignee=str(row.get("assignee") or ""),
        review_status=row.get("review_status") or ReviewStatus.pending,
        reviewer=str(row.get("reviewer") or ""),
        review_note=str(row.get("review_note") or ""),
        reviewed_at=row.get("reviewed_at"),
    )


def _task_summary(row: dict[str, object], queue_position: int | None = None) -> TaskSummary:
    return TaskSummary(
        task_id=row["task_id"],
        query=row["query"],
        original_query=str(row.get("original_query") or row["query"]),
        query_history=_query_history(row),
        brand=row["brand"],
        model=row["model"],
        image_mode=row.get("image_mode", "all"),
        search_tier=row.get("search_tier", SearchTier.balanced.value),
        locale=row.get("locale"),
        limit=row.get("result_limit", 20),
        profile=str(row.get("profile") or "auto"),
        min_results=int(row.get("min_results") or 0),
        recall_version=int(row.get("recall_version") or 1),
        status=row["status"],
        lane=resolve_task_lane(row["status"], row.get("review_status") or ReviewStatus.pending),
        count=row["count"],
        progress=_task_progress(row, queue_position),
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        started_at=row.get("started_at"),
        finished_at=row.get("finished_at"),
        assignee=str(row.get("assignee") or ""),
        review_status=row.get("review_status") or ReviewStatus.pending,
        reviewer=str(row.get("reviewer") or ""),
        review_note=str(row.get("review_note") or ""),
        reviewed_at=row.get("reviewed_at"),
    )


def _employee_task_summary(
    row: dict[str, object], queue_position: int | None = None
) -> EmployeeTaskSummary:
    summary = _task_summary(row, queue_position)
    return EmployeeTaskSummary(
        **summary.model_dump(),
        batch_id=row.get("batch_id"),
        batch_row=row.get("batch_row"),
        batch_spu=str(row.get("batch_spu") or ""),
    )


def _normalise_employee(value: str | None) -> str:
    employee = " ".join(str(value or "").split())[:80]
    return employee


def _normalise_blocked_domain(value: str) -> str:
    raw = " ".join(str(value or "").split()).strip().lower()
    try:
        parsed = urlsplit(raw if "://" in raw else f"//{raw}")
        host = (parsed.hostname or "").strip().lower().removeprefix("www.").rstrip(".")
    except ValueError as exc:
        raise ValueError("请输入有效的网站域名，例如 example.com") from exc
    if not host or "." not in host or any(char in host for char in " /\\:@"):
        raise ValueError("请输入有效的网站域名，例如 example.com")
    return host


def _batch_summary(
    batch: dict[str, object], task_rows: list[dict[str, object]]
) -> BatchSummary:
    counts = Counter(str(row.get("status", "")) for row in task_rows)
    total = int(batch.get("total", len(task_rows)) or 0)
    completed = counts.get(TaskStatus.completed, 0)
    processing = counts.get(TaskStatus.processing, 0)
    queued = counts.get(TaskStatus.queued, 0)
    failed = counts.get(TaskStatus.failed, 0)
    needs_changes = sum(
        1
        for row in task_rows
        if row.get("status") == TaskStatus.completed
        and row.get("review_status") == ReviewStatus.needs_changes
    )
    cancelled = counts.get(TaskStatus.cancelled, 0)
    settled = completed + failed + cancelled
    if total <= 0:
        status = "failed"
    elif completed == total:
        status = "completed_with_issues" if needs_changes else "completed"
    elif settled == total:
        if cancelled == total:
            status = "cancelled"
        elif failed == total:
            status = "failed"
        else:
            status = "completed_with_issues"
    elif processing or completed:
        status = "processing"
    elif queued:
        status = "queued"
    else:
        status = "processing"
    percent = round(completed * 100 / total, 1) if total else 0.0
    settled_percent = round(settled * 100 / total, 1) if total else 0.0
    elapsed_seconds = 0.0
    eta_seconds = 0.0
    for row in task_rows:
        progress = _task_progress(row)
        elapsed_seconds += float(progress.get("elapsed_seconds", 0) or 0)
        if str(row.get("status", "")) in {TaskStatus.queued, TaskStatus.processing}:
            eta_seconds += float(
                progress.get("eta_seconds")
                or progress.get("estimated_seconds")
                or 0
            )
    elapsed_seconds = round(elapsed_seconds, 1)
    eta_seconds = round(max(0.0, eta_seconds), 1)
    estimated_seconds = round(elapsed_seconds + eta_seconds, 1)
    updated_values = [str(row["updated_at"]) for row in task_rows if row.get("updated_at")]
    if batch.get("updated_at"):
        updated_values.append(str(batch["updated_at"]))
    return BatchSummary(
        batch_id=str(batch["batch_id"]),
        filename=str(batch.get("filename") or "导入表格"),
        total=total,
        completed=completed,
        processing=processing,
        queued=queued,
        failed=failed,
        needs_changes=needs_changes,
        cancelled=cancelled,
        percent=percent,
        settled_percent=settled_percent,
        elapsed_seconds=elapsed_seconds,
        estimated_seconds=estimated_seconds,
        eta_seconds=eta_seconds,
        eta_at=(
            (datetime.now(UTC) + timedelta(seconds=eta_seconds)).isoformat()
            if eta_seconds > 0
            else None
        ),
        status=status,
        result_limit=int(batch.get("result_limit", 20) or 20),
        image_mode=str(batch.get("image_mode") or "all"),
        search_tier=batch.get("search_tier", SearchTier.balanced.value),
        locale=batch.get("locale"),
        created_at=batch.get("created_at"),
        updated_at=max(updated_values) if updated_values else batch.get("updated_at"),
    )


def _batch_response(
    batch: dict[str, object], task_rows: list[dict[str, object]]
) -> BatchResponse:
    summary = _batch_summary(batch, task_rows)
    items = [
        BatchItemSummary(
            task_id=str(row["task_id"]),
            row_number=int(row.get("batch_row") or 0),
            spu=str(row.get("batch_spu") or ""),
            query=str(row.get("query") or ""),
            original_query=str(row.get("original_query") or row.get("query") or ""),
            query_history=_query_history(row),
            search_tier=row.get("search_tier", SearchTier.balanced.value),
            status=row["status"],
            lane=resolve_task_lane(row["status"], row.get("review_status") or ReviewStatus.pending),
            count=int(row.get("count", 0) or 0),
            progress=_task_progress(row),
            error=row.get("error"),
            review_status=row.get("review_status") or ReviewStatus.pending,
            review_note=str(row.get("review_note") or ""),
            updated_at=row.get("updated_at"),
        )
        for row in task_rows
    ]
    return BatchResponse(**summary.model_dump(), items=items)


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app_settings.prepare_directories()
        database = Database(app_settings.database_path)
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(20.0, connect=8.0),
            headers={"User-Agent": "product-image-service/0.1"},
        )
        # 重启(发版)时正在跑的任务会停在 processing、永远没人接:放回队列重跑
        database.requeue_interrupted_tasks()
        service = ImageService(app_settings, database, client)
        app.state.settings = app_settings
        app.state.database = database
        app.state.client = client
        app.state.service = service
        app.state.admin = AdminSession(app_settings)
        await service.start()
        try:
            yield
        finally:
            await service.stop()
            await client.aclose()
            database._connection.close()

    app = FastAPI(title="Product Image Retrieval Service", version="0.2.0", lifespan=lifespan)
    app.state.player_sessions = {}

    @app.middleware("http")
    async def public_access_guard(request: Request, call_next):
        """Keep general image/data APIs behind the same token when tunneled publicly."""
        token = getattr(request.app.state.settings, "employee_access_token", "")
        protected = (
            request.url.path.startswith("/v1/images")
            or request.url.path.startswith("/v1/wallpaper")
            or request.url.path.startswith("/files/")
            or request.url.path in {"/docs", "/redoc", "/openapi.json"}
        )
        if token and protected:
            # 本机 local_dev 管理页没有 admin/employee cookie；它和 8090 同机，
            # 不该被“公网隧道令牌”挡在门外。生产 host 不是 127.0.0.1，不受影响。
            if local_dev_access(request):
                return await call_next(request)
            employee_cookie = request.cookies.get("employee_access")
            admin_cookie = request.cookies.get("admin_session")
            if employee_cookie != token and not request.app.state.admin.valid(admin_cookie):
                return JSONResponse(
                    {"detail": "public access token required"}, status_code=401
                )
        return await call_next(request)

    def get_service(request: Request) -> ImageService:
        return request.app.state.service

    def local_dev_access(request: Request) -> bool:
        settings: Settings = request.app.state.settings
        client_host = request.client.host if request.client else ""
        return (
            settings.admin_auth_mode == "local_dev"
            and settings.host in {"127.0.0.1", "localhost"}
            and client_host in {"127.0.0.1", "::1", "localhost", "testclient"}
        )

    def require_admin(request: Request, admin_session: str | None = Cookie(default=None)) -> None:
        if local_dev_access(request):
            return
        if not request.app.state.admin.valid(admin_session):
            raise HTTPException(status_code=401, detail="admin authentication required")

    def require_employee_access(
        request: Request,
        employee_access: str | None = Cookie(default=None),
    ) -> None:
        token = request.app.state.settings.employee_access_token
        if token and employee_access != token:
            raise HTTPException(status_code=401, detail="employee access token required")

    def require_player_access(
        request: Request,
        admin_session: str | None = Cookie(default=None),
        employee_access: str | None = Cookie(default=None),
    ) -> None:
        """Allow the mobile capture page for local, admin, or employee sessions."""
        if local_dev_access(request) or request.app.state.admin.valid(admin_session):
            return
        token = request.app.state.settings.employee_access_token
        if token and employee_access == token:
            return
        raise HTTPException(status_code=401, detail="player access token required")

    def create_player_session() -> dict[str, object]:
        sessions: dict[str, dict[str, object]] = app.state.player_sessions
        while True:
            pairing_code = f"{secrets.randbelow(1_000_000):06d}"
            if pairing_code not in sessions:
                break
        session = {
            "pairing_code": pairing_code,
            "display": None,
            "remote": None,
            "created_at": time.time(),
        }
        sessions[pairing_code] = session
        return session

    async def send_player_message(peer: WebSocket | None, payload: dict[str, object]) -> bool:
        if peer is None:
            return False
        try:
            await peer.send_json(payload)
        except (RuntimeError, WebSocketDisconnect):
            return False
        return True

    @app.get("/health")
    async def health(request: Request):
        settings: Settings = request.app.state.settings
        return {"status": "ok", "service": settings.app_name, "version": "0.2.0"}

    @app.post("/v1/images/search", response_model=SearchAccepted, status_code=202)
    async def create_search(payload: SearchRequest, service: ImageService = Depends(get_service)):
        task_id = service.create_task(
            payload.query,
            refresh=payload.refresh,
            image_mode=payload.image_mode,
            limit=payload.limit,
            platforms=payload.platforms,
            locale=payload.locale,
            search_tier=payload.search_tier.value,
            profile=payload.profile,
            min_results=payload.min_results,
            recall_version=payload.recall_version,
        )
        return SearchAccepted(task_id=task_id, status=TaskStatus.queued)

    @app.post("/v1/images/batches/import", response_model=BatchResponse, status_code=202)
    async def import_batch(
        request: Request,
        service: ImageService = Depends(get_service),
        limit: int = 20,
        image_mode: str = "all",
        locale: str | None = None,
        search_tier: SearchTier = SearchTier.balanced,
    ):
        if limit < 1 or limit > 500:
            raise HTTPException(status_code=422, detail="limit must be between 1 and 500")
        if image_mode not in {"all", "catalog", "real_photo"}:
            raise HTTPException(status_code=422, detail="invalid image_mode")
        content_length = request.headers.get("content-length")
        try:
            if content_length and int(content_length) > MAX_BATCH_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="Excel 文件不能超过 10 MB")
        except ValueError:
            pass
        content = await request.body()
        if len(content) > MAX_BATCH_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Excel 文件不能超过 10 MB")
        filename = Path(
            request.headers.get("x-filename")
            or request.query_params.get("filename")
            or "import.xlsx"
        ).name
        try:
            items = read_xlsx_rows(content, filename)
        except ExcelImportError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        batch_id = service.create_batch(
            filename,
            items,
            image_mode=image_mode,
            limit=limit,
            locale=locale,
            search_tier=search_tier.value,
        )
        batch = request.app.state.database.get_batch(batch_id)
        if not batch:
            raise HTTPException(status_code=500, detail="批次创建失败")
        return _batch_response(batch, request.app.state.database.list_tasks_for_batch(batch_id))

    @app.post(
        "/v1/employee/intake",
        response_model=BatchResponse,
        status_code=202,
        dependencies=[Depends(require_employee_access)],
    )
    async def employee_intake(
        request: Request,
        service: ImageService = Depends(get_service),
        limit: int = 20,
        image_mode: str = "all",
        locale: str | None = None,
        employee: str = "员工1",
        search_tier: SearchTier = SearchTier.balanced,
    ):
        """Create an automatically queued daily intake batch owned by one employee."""
        employee_name = _normalise_employee(
            request.headers.get("x-employee-name") or employee
        )
        if not employee_name:
            raise HTTPException(status_code=422, detail="employee name is required")
        if limit < 1 or limit > 500:
            raise HTTPException(status_code=422, detail="limit must be between 1 and 500")
        if image_mode not in {"all", "catalog", "real_photo"}:
            raise HTTPException(status_code=422, detail="invalid image_mode")
        content_length = request.headers.get("content-length")
        try:
            if content_length and int(content_length) > MAX_BATCH_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="Excel 文件不能超过 10 MB")
        except ValueError:
            pass
        content = await request.body()
        if len(content) > MAX_BATCH_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Excel 文件不能超过 10 MB")
        filename = Path(
            request.headers.get("x-filename")
            or request.query_params.get("filename")
            or "daily-intake.xlsx"
        ).name
        try:
            items = read_xlsx_rows(content, filename)
        except ExcelImportError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        batch_id = service.create_batch(
            filename,
            items,
            image_mode=image_mode,
            limit=limit,
            locale=locale,
            assignee=employee_name,
            search_tier=search_tier.value,
        )
        batch = request.app.state.database.get_batch(batch_id)
        if not batch:
            raise HTTPException(status_code=500, detail="批次创建失败")
        return _batch_response(batch, request.app.state.database.list_tasks_for_batch(batch_id))

    @app.get(
        "/v1/employee/workbench",
        response_model=EmployeeWorkbenchResponse,
        dependencies=[Depends(require_employee_access)],
    )
    async def employee_workbench(
        request: Request,
        employee: str = "员工1",
        date: str | None = None,
        batch_id: str | None = None,
        limit: int = 200,
    ):
        employee_name = _normalise_employee(
            request.headers.get("x-employee-name") or employee
        )
        if not employee_name:
            raise HTTPException(status_code=422, detail="employee name is required")
        if limit < 1 or limit > 500:
            raise HTTPException(status_code=422, detail="limit must be between 1 and 500")
        work_date = date or datetime.now(EMPLOYEE_TIMEZONE).date().isoformat()
        try:
            datetime.strptime(work_date, "%Y-%m-%d")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="date must use YYYY-MM-DD") from exc
        database = request.app.state.database
        rows = database.list_employee_tasks(
            employee_name, work_date=work_date, batch_id=batch_id, limit=limit
        )
        active_rows = [row for row in rows if row["status"] in {TaskStatus.queued, TaskStatus.processing}]
        queued_rows = [row for row in active_rows if row["status"] == TaskStatus.queued]
        queued_positions = {row["task_id"]: index for index, row in enumerate(queued_rows, 1)}
        tasks = [
            _employee_task_summary(
                row,
                0 if row["status"] == TaskStatus.processing else queued_positions.get(row["task_id"]),
            )
            for row in rows
        ]
        review_counts = Counter(
            str(row.get("review_status") or ReviewStatus.pending)
            for row in rows
            if row.get("status") == TaskStatus.completed
        )
        batch = None
        selected_batch_id = batch_id or next(
            (str(row["batch_id"]) for row in rows if row.get("batch_id")), None
        )
        if selected_batch_id:
            batch_row = database.get_batch(selected_batch_id)
            if batch_row:
                batch = _batch_summary(batch_row, database.list_tasks_for_batch(selected_batch_id))
        return EmployeeWorkbenchResponse(
            employee=employee_name,
            date=work_date,
            batch=batch,
            total=len(rows),
            crawl_completed=sum(row["status"] == TaskStatus.completed for row in rows),
            review_pending=review_counts.get(ReviewStatus.pending.value, 0),
            review_in_progress=review_counts.get(ReviewStatus.in_progress.value, 0),
            review_approved=review_counts.get(ReviewStatus.approved.value, 0),
            review_needs_changes=review_counts.get(ReviewStatus.needs_changes.value, 0),
            tasks=tasks,
        )

    @app.get(
        "/v1/employee/tasks/{task_id}",
        response_model=TaskResponse,
        dependencies=[Depends(require_employee_access)],
    )
    async def get_employee_task(task_id: str, request: Request, employee: str = "员工1"):
        # 审核是共用队列,任何员工都能看任何任务;employee 参数保留只为兼容旧页面
        row = request.app.state.database.get_task(task_id)
        if not row:
            raise HTTPException(status_code=404, detail="task not found")
        return _task_response(row, request.app.state.settings.public_base_url)

    @app.post(
        "/v1/employee/tasks/claim-next",
        response_model=TaskResponse,
        dependencies=[Depends(require_employee_access)],
    )
    async def claim_next_employee_task(
        request: Request, employee: str = "员工1", date: str | None = None
    ):
        employee_name = _normalise_employee(
            request.headers.get("x-employee-name") or employee
        )
        if not employee_name:
            raise HTTPException(status_code=422, detail="employee name is required")
        database = request.app.state.database
        work_date = date or datetime.now(EMPLOYEE_TIMEZONE).date().isoformat()
        try:
            datetime.strptime(work_date, "%Y-%m-%d")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="date must use YYYY-MM-DD") from exc
        # 当天没有就领更早的:ERP 按型号单个发起的任务不在入库批次里,隔天也得有人审
        row = database.find_claimable_employee_task(work_date) or database.find_claimable_employee_task(None)
        if not row or not database.claim_task(str(row["task_id"]), employee_name):
            raise HTTPException(status_code=404, detail="没有可认领的待审核任务")
        claimed = database.get_task(str(row["task_id"]))
        if not claimed:
            raise HTTPException(status_code=500, detail="认领任务失败")
        return _task_response(claimed, request.app.state.settings.public_base_url)

    @app.post(
        "/v1/employee/tasks/{task_id}/claim",
        response_model=TaskResponse,
        dependencies=[Depends(require_employee_access)],
    )
    async def claim_employee_task(task_id: str, request: Request, employee: str = "员工1"):
        employee_name = _normalise_employee(
            request.headers.get("x-employee-name") or employee
        )
        if not employee_name:
            raise HTTPException(status_code=422, detail="employee name is required")
        database = request.app.state.database
        row = database.get_task(task_id)
        if not row:
            raise HTTPException(status_code=404, detail="task not found")
        if row.get("assignee") not in {None, "", employee_name}:
            raise HTTPException(status_code=409, detail="任务已被其他员工认领")
        if not database.claim_task(task_id, employee_name):
            raise HTTPException(status_code=409, detail="任务认领状态已变化")
        claimed = database.get_task(task_id)
        if not claimed:
            raise HTTPException(status_code=404, detail="task not found")
        return _task_response(claimed, request.app.state.settings.public_base_url)

    @app.post(
        "/v1/employee/tasks/{task_id}/review",
        response_model=TaskResponse,
        dependencies=[Depends(require_employee_access)],
    )
    async def review_employee_task(
        task_id: str,
        payload: EmployeeReviewRequest,
        request: Request,
        employee: str = "员工1",
    ):
        employee_name = _normalise_employee(
            request.headers.get("x-employee-name") or employee
        )
        if not employee_name:
            raise HTTPException(status_code=422, detail="employee name is required")
        database = request.app.state.database
        row = database.get_task(task_id)
        if not row:
            raise HTTPException(status_code=404, detail="task not found")
        if row.get("status") != TaskStatus.completed:
            raise HTTPException(status_code=409, detail="爬取完成后才能审核图片")
        database.update_task(
            task_id,
            assignee=employee_name,
            review_status=payload.decision.value,
            reviewer=employee_name,
            review_note=payload.note.strip(),
            reviewed_at=utc_now(),
        )
        reviewed = database.get_task(task_id)
        if not reviewed:
            raise HTTPException(status_code=404, detail="task not found")
        return _task_response(reviewed, request.app.state.settings.public_base_url)

    @app.get("/v1/images/batches", response_model=BatchListResponse)
    async def list_batches(request: Request, limit: int = 20):
        if limit < 1 or limit > 100:
            raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
        database = request.app.state.database
        summaries = [
            _batch_summary(batch, database.list_tasks_for_batch(str(batch["batch_id"])))
            for batch in database.list_batches(limit)
        ]
        return BatchListResponse(batches=summaries)

    @app.get("/v1/images/batches/{batch_id}", response_model=BatchResponse)
    async def get_batch(batch_id: str, request: Request):
        database = request.app.state.database
        batch = database.get_batch(batch_id)
        if not batch:
            raise HTTPException(status_code=404, detail="batch not found")
        return _batch_response(batch, database.list_tasks_for_batch(batch_id))

    @app.post("/v1/images/batches/{batch_id}/cancel", response_model=BatchResponse)
    async def cancel_batch(batch_id: str, request: Request, service: ImageService = Depends(get_service)):
        database = request.app.state.database
        batch = database.get_batch(batch_id)
        if not batch:
            raise HTTPException(status_code=404, detail="batch not found")
        for row in database.list_tasks_for_batch(batch_id):
            if row["status"] not in {TaskStatus.queued, TaskStatus.processing}:
                continue
            try:
                service.cancel_task(str(row["task_id"]))
            except RuntimeError:
                # A worker can claim the task between the snapshot and cancel call;
                # leave it visible for the next refresh instead of hiding the race.
                continue
        return _batch_response(batch, database.list_tasks_for_batch(batch_id))

    @app.post(
        "/v1/images/batches/{batch_id}/retry-failed",
        response_model=BatchResponse,
        status_code=202,
    )
    async def retry_failed_batch(
        batch_id: str, request: Request, service: ImageService = Depends(get_service)
    ):
        database = request.app.state.database
        batch = database.get_batch(batch_id)
        if not batch:
            raise HTTPException(status_code=404, detail="batch not found")
        for row in database.list_tasks_for_batch(batch_id):
            if row["status"] != TaskStatus.failed:
                continue
            try:
                service.retry_task(str(row["task_id"]))
            except RuntimeError:
                # A task can reach the retry limit independently of the rest of
                # the batch; keep it failed so the reason remains actionable.
                continue
        return _batch_response(batch, database.list_tasks_for_batch(batch_id))

    @app.get("/v1/images/tasks", response_model=TaskQueueResponse)
    async def list_search_tasks(
        request: Request,
        include_history: bool = False,
        status: TaskStatus | None = None,
        bucket: str | None = None,
        limit: int = 50,
    ):
        if bucket not in {None, "good", "bad"}:
            raise HTTPException(status_code=422, detail="bucket must be good or bad")
        if bucket == "good":
            # The good lane contains active work and completed tasks that do
            # not currently require review changes.
            rows = request.app.state.database.list_task_bucket("good", limit)
            statuses = None
        elif bucket == "bad":
            # Failed crawls and completed tasks marked needs_changes share the
            # retry/repair lane until they are resolved.
            rows = request.app.state.database.list_task_bucket("bad", limit)
            statuses = None
        else:
            statuses = [status] if status else (
                None if include_history else [TaskStatus.queued, TaskStatus.processing]
            )
            rows = request.app.state.database.list_tasks(statuses=statuses, limit=limit)
        active_rows = [row for row in rows if row["status"] in {"queued", "processing"}]
        queued_rows = [row for row in active_rows if row["status"] == "queued"]
        queued_positions = {row["task_id"]: index for index, row in enumerate(queued_rows, 1)}
        tasks = [
            _task_summary(
                row,
                0 if row["status"] == "processing" else queued_positions.get(row["task_id"]),
            )
            for row in rows
        ]
        return TaskQueueResponse(tasks=tasks, active_count=len(active_rows))

    @app.post("/v1/images/tasks/{task_id}/cancel", response_model=TaskResponse)
    async def cancel_search(
        task_id: str, request: Request, service: ImageService = Depends(get_service)
    ):
        try:
            row = service.cancel_task(task_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if not row:
            raise HTTPException(status_code=404, detail="task not found")
        return _task_response(row, request.app.state.settings.public_base_url)

    @app.post(
        "/v1/images/tasks/{task_id}/retry",
        response_model=TaskResponse,
        status_code=202,
    )
    async def retry_search(
        task_id: str,
        request: Request,
        payload: TaskRetryRequest | None = None,
        service: ImageService = Depends(get_service),
    ):
        try:
            row = service.retry_task(task_id, query=payload.query if payload else None)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if not row:
            current = request.app.state.database.get_task(task_id)
            if not current:
                raise HTTPException(status_code=404, detail="task not found")
            raise HTTPException(status_code=409, detail="任务状态已变化，请刷新后重试")
        return _task_response(row, request.app.state.settings.public_base_url)

    @app.post("/v1/images/tasks/{task_id}/pool-decisions", response_model=TaskResponse)
    async def decide_image_pools(
        task_id: str, payload: PoolDecisionRequest, request: Request
    ):
        database = request.app.state.database
        row = database.get_task(task_id)
        if not row:
            raise HTTPException(status_code=404, detail="task not found")
        if row.get("status") in {TaskStatus.queued, TaskStatus.processing}:
            raise HTTPException(status_code=409, detail="任务完成检索后才能划分图片池")
        decisions = _json_object(row.get("pool_decisions_json"))
        decisions.update({item.image_key: item.pool for item in payload.decisions})
        values: dict[str, object] = {"pool_decisions_json": decisions}
        if payload.note.strip():
            values.update({"review_note": payload.note.strip(), "reviewed_at": utc_now()})
        database.update_task(task_id, **values)
        updated = database.get_task(task_id)
        if not updated:
            raise HTTPException(status_code=404, detail="task not found")
        return _task_response(updated, request.app.state.settings.public_base_url)

    @app.get("/v1/images/tasks/{task_id}", response_model=TaskResponse)
    async def get_search(task_id: str, request: Request):
        row = request.app.state.database.get_task(task_id)
        if not row:
            raise HTTPException(status_code=404, detail="task not found")
        return _task_response(row, request.app.state.settings.public_base_url)

    @app.post(
        "/v1/employee/tasks/{task_id}/pool-decisions",
        response_model=TaskResponse,
        dependencies=[Depends(require_employee_access)],
    )
    async def decide_employee_image_pools(
        task_id: str,
        payload: PoolDecisionRequest,
        request: Request,
        employee: str = "员工1",
    ):
        employee_name = _normalise_employee(
            request.headers.get("x-employee-name") or employee
        )
        row = request.app.state.database.get_task(task_id)
        if not row:
            raise HTTPException(status_code=404, detail="task not found")
        if row.get("status") in {TaskStatus.queued, TaskStatus.processing}:
            raise HTTPException(status_code=409, detail="任务完成检索后才能划分图片池")
        decisions = _json_object(row.get("pool_decisions_json"))
        decisions.update({item.image_key: item.pool for item in payload.decisions})
        values: dict[str, object] = {"pool_decisions_json": decisions, "assignee": employee_name}
        if payload.note.strip():
            values.update({"review_note": payload.note.strip(), "reviewed_at": utc_now()})
        request.app.state.database.update_task(task_id, **values)
        updated = request.app.state.database.get_task(task_id)
        if not updated:
            raise HTTPException(status_code=404, detail="task not found")
        return _task_response(updated, request.app.state.settings.public_base_url)

    @app.get("/files/{filename:path}")
    async def get_file(filename: str, request: Request):
        safe_name = Path(filename).name
        if safe_name != filename or not safe_name.replace(".", "").isalnum():
            raise HTTPException(status_code=404, detail="file not found")
        target = (request.app.state.settings.storage_dir / safe_name).resolve()
        storage = request.app.state.settings.storage_dir.resolve()
        if storage not in target.parents or not target.is_file():
            raise HTTPException(status_code=404, detail="file not found")
        from fastapi.responses import FileResponse

        return FileResponse(target)

    @app.get("/v1/wallpaper/status", dependencies=[Depends(require_admin)])
    async def wallpaper_status(request: Request):
        return _wallpaper_status(request.app.state.settings)

    @app.get("/v1/wallpaper/images", dependencies=[Depends(require_admin)])
    async def wallpaper_images(
        request: Request,
        limit: int = 40,
        offset: int = 0,
        query: str = "",
    ):
        settings: Settings = request.app.state.settings
        safe_limit = max(1, min(limit, 100))
        safe_offset = max(0, min(offset, 1_000_000))
        total, total_bytes, records = _wallpaper_image_records(
            settings.wallpaper_output_dir.expanduser(),
            query=query,
            limit=safe_limit,
            offset=safe_offset,
        )
        return {
            "items": records,
            "total": total,
            "total_bytes": total_bytes,
            "limit": safe_limit,
            "offset": safe_offset,
            "query": query.strip(),
        }

    @app.get("/v1/wallpaper/player/playlist", dependencies=[Depends(require_player_access)])
    async def wallpaper_player_playlist(
        request: Request,
        offset: int = 0,
        query: str = "",
    ):
        settings: Settings = request.app.state.settings
        safe_offset = max(offset, 0)
        total, total_bytes, records = _wallpaper_player_records(
            settings.wallpaper_output_dir.expanduser(),
            query=query,
            length=100,
            offset=safe_offset,
        )
        effective_offset = safe_offset if records and safe_offset < total else 0
        source_batch_count = len({str(item.get("name")) for item in records})
        next_offset = (
            0
            if source_batch_count < 100
            else (effective_offset + len(records)) % total
            if total
            else 0
        )
        return {
            "frames": records,
            "frame_count": len(records),
            "frame_interval_ms": 100,
            "duration_ms": len(records) * 100,
            "source_total": total,
            "source_bytes": total_bytes,
            "offset": effective_offset,
            "next_offset": next_offset,
            "query": query.strip(),
        }

    @app.post("/v1/wallpaper/player/session", dependencies=[Depends(require_player_access)])
    async def wallpaper_player_session():
        session = create_player_session()
        return {
            "pairing_code": session["pairing_code"],
            "frame_count": 100,
            "frame_interval_ms": 100,
            "duration_ms": 10_000,
        }

    @app.websocket("/v1/wallpaper/player/ws")
    async def wallpaper_player_ws(websocket: WebSocket):
        pairing_code = websocket.query_params.get("code", "").strip()
        role = websocket.query_params.get("role", "").strip().lower()
        sessions: dict[str, dict[str, object]] = app.state.player_sessions
        session = sessions.get(pairing_code)
        if session is None or role not in {"display", "remote"}:
            await websocket.close(code=4404)
            return
        await websocket.accept()
        previous = session.get(role)
        if isinstance(previous, WebSocket) and previous is not websocket:
            try:
                await previous.close(code=4001)
            except RuntimeError:
                pass
        session[role] = websocket
        await websocket.send_json(
            {
                "type": "connected",
                "role": role,
                "pairing_code": pairing_code,
                "frame_count": 100,
                "frame_interval_ms": 100,
                "duration_ms": 10_000,
            }
        )
        peer_role = "remote" if role == "display" else "display"
        peer = session.get(peer_role)
        peer_socket = peer if isinstance(peer, WebSocket) else None
        if peer_socket is not None:
            await websocket.send_json({"type": "peer_connected", "role": peer_role})
            await send_player_message(peer_socket, {"type": "peer_connected", "role": role})
        try:
            while True:
                payload = await websocket.receive_json()
                event = str(payload.get("type", "")).strip()
                peer = session.get(peer_role)
                peer_socket = peer if isinstance(peer, WebSocket) else None
                if role == "remote" and event == "start_recording":
                    if peer_socket is None:
                        await websocket.send_json(
                            {"type": "error", "message": "电脑显示页还没有连接"}
                        )
                        continue
                    start_at_ms = int(time.time() * 1000) + 800
                    await websocket.send_json(
                        {"type": "recording_started", "start_at_ms": start_at_ms}
                    )
                    await send_player_message(
                        peer_socket,
                        {"type": "start_playback", "start_at_ms": start_at_ms},
                    )
                elif role == "display" and event == "display_done":
                    await send_player_message(peer_socket, {"type": "playback_done"})
                elif event == "ping":
                    await websocket.send_json({"type": "pong"})
                else:
                    await websocket.send_json({"type": "error", "message": "不支持的控制指令"})
        except WebSocketDisconnect:
            pass
        finally:
            if session.get(role) is websocket:
                session[role] = None
            peer = session.get(peer_role)
            await send_player_message(
                peer if isinstance(peer, WebSocket) else None,
                {"type": "peer_disconnected", "role": role},
            )
            if session.get("display") is None and session.get("remote") is None:
                sessions.pop(pairing_code, None)

    @app.get(
        "/v1/wallpaper/player/files/{filename:path}",
        dependencies=[Depends(require_player_access)],
    )
    async def wallpaper_player_file(filename: str, request: Request):
        safe_name = Path(filename).name
        if (
            safe_name != filename
            or safe_name.startswith(".")
            or not all(char.isalnum() or char in "._-" for char in safe_name)
            or Path(safe_name).suffix.casefold() not in WALLPAPER_IMAGE_EXTENSIONS
        ):
            raise HTTPException(status_code=404, detail="wallpaper image not found")
        output = request.app.state.settings.wallpaper_output_dir.expanduser().resolve()
        target = (output / safe_name).resolve()
        if output not in target.parents or not target.is_file():
            raise HTTPException(status_code=404, detail="wallpaper image not found")
        from fastapi.responses import FileResponse

        return FileResponse(target)

    @app.get("/v1/wallpaper/files/{filename:path}", dependencies=[Depends(require_admin)])
    async def wallpaper_file(filename: str, request: Request):
        safe_name = Path(filename).name
        if (
            safe_name != filename
            or safe_name.startswith(".")
            or not all(char.isalnum() or char in "._-" for char in safe_name)
            or Path(safe_name).suffix.casefold() not in WALLPAPER_IMAGE_EXTENSIONS
        ):
            raise HTTPException(status_code=404, detail="wallpaper image not found")
        output = request.app.state.settings.wallpaper_output_dir.expanduser().resolve()
        target = (output / safe_name).resolve()
        if output not in target.parents or not target.is_file():
            raise HTTPException(status_code=404, detail="wallpaper image not found")
        from fastapi.responses import FileResponse

        return FileResponse(target)

    @app.post("/v1/wallpaper/start", dependencies=[Depends(require_admin)])
    async def wallpaper_start(request: Request):
        settings: Settings = request.app.state.settings
        runner = settings.wallpaper_runner_script.expanduser()
        existing = _wallpaper_runner_processes(runner)
        if existing:
            return {"started": False, "already_running": True, **_wallpaper_status(settings)}
        if not runner.is_file():
            raise HTTPException(status_code=503, detail="wallpaper runner is not configured")
        if not os.environ.get("STEAM_API_KEY", "").strip():
            raise HTTPException(status_code=409, detail="STEAM_API_KEY is not configured for the service")
        log_dir = settings.wallpaper_root.expanduser() / ".wallpaper-bulk"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "service.log"
        log_handle = log_path.open("a", encoding="utf-8")
        environment = os.environ.copy()
        environment["PYTHONUNBUFFERED"] = "1"
        try:
            process = subprocess.Popen(
                [sys.executable, str(runner)],
                cwd=str(runner.parent),
                env=environment,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            log_handle.close()
        (log_dir / "service.pid").write_text(str(process.pid), encoding="utf-8")
        return {"started": True, **_wallpaper_status(settings)}

    @app.post("/v1/wallpaper/stop", dependencies=[Depends(require_admin)])
    async def wallpaper_stop(request: Request):
        settings: Settings = request.app.state.settings
        runner = settings.wallpaper_runner_script.expanduser()
        processes = _wallpaper_runner_processes(runner)
        stopped: list[int] = []
        for item in processes:
            pid = int(item["pid"])
            try:
                process_group = os.getpgid(pid)
                if process_group == pid:
                    os.killpg(process_group, signal.SIGTERM)
                else:
                    os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                continue
            except PermissionError:
                raise HTTPException(status_code=403, detail="wallpaper runner cannot be stopped") from None
            stopped.append(pid)
        return {"stopped": stopped, **_wallpaper_status(settings)}

    @app.get("/admin", response_class=HTMLResponse)
    async def admin_page():
        html = Path(__file__).parent.joinpath("static", "admin.html").read_text(encoding="utf-8")
        return HTMLResponse(
            html,
            headers={"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"},
        )

    @app.get("/wallpaper", response_class=HTMLResponse)
    async def wallpaper_page():
        html = Path(__file__).parent.joinpath("static", "wallpaper.html").read_text(encoding="utf-8")
        return HTMLResponse(
            html,
            headers={"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"},
        )

    @app.get("/wallpaper/player", response_class=HTMLResponse)
    async def wallpaper_player_page(
        request: Request,
        access_key: str | None = None,
        employee_access: str | None = Cookie(default=None),
        admin_session: str | None = Cookie(default=None),
    ):
        settings: Settings = request.app.state.settings
        token = settings.employee_access_token
        has_access = (
            local_dev_access(request)
            or request.app.state.admin.valid(admin_session)
            or bool(token and employee_access == token)
            or bool(token and access_key == token)
        )
        if not has_access:
            raise HTTPException(status_code=401, detail="player access token required")
        html_response = HTMLResponse(
            Path(__file__).parent.joinpath("static", "wallpaper_player.html").read_text(
                encoding="utf-8"
            ),
            headers={"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"},
        )
        if token and employee_access != token and access_key == token:
            html_response.set_cookie(
                "employee_access",
                token,
                httponly=True,
                samesite="strict",
                secure=False,
                max_age=7 * 24 * 3600,
            )
        return html_response

    @app.get("/wallpaper/remote", response_class=HTMLResponse)
    async def wallpaper_remote_page():
        html = Path(__file__).parent.joinpath("static", "wallpaper_remote.html").read_text(
            encoding="utf-8"
        )
        return HTMLResponse(
            html,
            headers={"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"},
        )

    @app.get("/wallpaper/vendor/fflate.min.js")
    async def wallpaper_fflate_vendor():
        """Serve the pinned open-source ZIP encoder used by the phone slicer."""
        from fastapi.responses import FileResponse

        asset = Path(__file__).parent.joinpath("static", "vendor", "fflate.min.js")
        if not asset.is_file():
            raise HTTPException(status_code=404, detail="wallpaper vendor asset not found")
        return FileResponse(
            asset,
            media_type="application/javascript",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    @app.get("/wallpaper/h5-local.cer")
    async def wallpaper_h5_local_certificate():
        """Offer the local HTTPS certificate for a one-time iPhone trust step."""
        from fastapi.responses import FileResponse

        asset = Path("/Volumes/wallpaper/.wallpaper-bulk/h5-https/server.cer")
        if not asset.is_file():
            raise HTTPException(status_code=404, detail="wallpaper HTTPS certificate not found")
        return FileResponse(
            asset,
            media_type="application/x-x509-ca-cert",
            filename="wallpaper-h5.cer",
            headers={"Cache-Control": "no-store, max-age=0"},
        )

    @app.get("/employee", response_class=HTMLResponse)
    async def employee_page(
        request: Request,
        access_key: str | None = None,
        employee_access: str | None = Cookie(default=None),
    ):
        token = request.app.state.settings.employee_access_token
        html_response = HTMLResponse(
            Path(__file__).parent.joinpath("static", "employee.html").read_text(encoding="utf-8"),
            headers={"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"},
        )
        if token:
            if employee_access != token and access_key != token:
                raise HTTPException(status_code=401, detail="employee access token required")
            if employee_access != token:
                html_response.set_cookie(
                    "employee_access",
                    token,
                    httponly=True,
                    samesite="strict",
                    secure=False,
                    max_age=7 * 24 * 3600,
                )
        return html_response

    @app.post("/admin/login")
    async def admin_login(payload: LoginRequest, response: Response, request: Request):
        if not request.app.state.admin.authenticate(payload.password):
            raise HTTPException(status_code=401, detail="invalid password")
        response.set_cookie(
            "admin_session",
            request.app.state.admin.issue(),
            httponly=True,
            samesite="strict",
            secure=False,
            max_age=8 * 3600,
        )
        return {"ok": True}

    @app.get("/admin/access")
    async def admin_access(request: Request):
        settings: Settings = request.app.state.settings
        return {
            "auth_required": not local_dev_access(request),
            "mode": settings.admin_auth_mode,
            "local_only": settings.admin_auth_mode == "local_dev",
        }

    @app.get("/admin/providers", dependencies=[Depends(require_admin)])
    async def list_providers(request: Request):
        service: ImageService = request.app.state.service
        rows = []
        for name, _provider in service.registry.providers.items():
            status = request.app.state.database.get_provider_status(name) or {}
            rows.append(
                {
                    "name": name,
                    "schema": PROVIDER_SCHEMAS.get(name, {}),
                    "status": status,
                    "configured": bool(service.registry.vault.get(name)),
                }
            )
        return {"providers": rows, "vault_enabled": service.registry.vault.enabled}

    @app.put("/admin/providers/{provider}/credentials", dependencies=[Depends(require_admin)])
    async def update_credentials(provider: str, payload: CredentialUpdate, request: Request):
        service: ImageService = request.app.state.service
        if provider not in service.registry.providers:
            raise HTTPException(status_code=404, detail="provider not found")
        if not service.registry.vault.enabled:
            raise HTTPException(
                status_code=503, detail="CREDENTIAL_ENCRYPTION_KEY is not configured"
            )
        clean_values = {
            key: value for key, value in payload.values.items() if isinstance(value, str)
        }
        service.registry.vault.put(provider, clean_values)
        request.app.state.database.log_audit("credential_updated", provider)
        service.registry.reload()
        service.adapters = AdapterRegistry(
            service.registry,
            max_retries=service.settings.provider_retry_attempts,
            retry_backoff_seconds=service.settings.provider_retry_backoff_seconds,
        )
        return {"ok": True, "configured": bool(clean_values)}

    @app.post("/admin/providers/{provider}/healthcheck", dependencies=[Depends(require_admin)])
    async def healthcheck_provider(provider: str, request: Request):
        service: ImageService = request.app.state.service
        item = service.registry.providers.get(provider)
        if not item:
            raise HTTPException(status_code=404, detail="provider not found")
        health = await item.healthcheck()
        request.app.state.database.set_provider_status(provider, health.state.value, health.message)
        return {"provider": provider, "state": health.state.value, "message": health.message}

    @app.get("/admin/security", dependencies=[Depends(require_admin)])
    async def security_status(request: Request):
        settings: Settings = request.app.state.settings
        return {
            "vault_enabled": request.app.state.service.registry.vault.enabled,
            "admin_password_is_default": settings.admin_password == "change-me-now",
            "remote_safe_default": settings.host in {"127.0.0.1", "localhost"},
            "admin_auth_mode": settings.admin_auth_mode,
        }

    @app.get("/admin/search-policy", dependencies=[Depends(require_admin)])
    async def get_search_policy(request: Request):
        policy = request.app.state.database.get_search_policy()
        return policy.model_dump(mode="json")

    @app.put("/admin/search-policy", dependencies=[Depends(require_admin)])
    async def update_search_policy(payload: SearchPolicyUpdate, request: Request):
        tiers = set(payload.tiers)
        if tiers != set(SearchTier):
            raise HTTPException(
                status_code=422,
                detail="必须同时配置严格、平衡、宽松三档策略",
            )
        policy = request.app.state.database.put_search_policy(
            request.app.state.database.get_search_policy().model_copy(
                update={"tiers": payload.tiers}
            )
        )
        request.app.state.database.log_audit("search_policy_updated", "search_policy")
        return policy.model_dump(mode="json")

    @app.get("/admin/blocked-domains", dependencies=[Depends(require_admin)])
    async def list_blocked_domains(request: Request):
        return {"domains": request.app.state.database.list_blocked_domains()}

    @app.post("/admin/blocked-domains", dependencies=[Depends(require_admin)])
    async def add_blocked_domain(payload: BlockedDomainRequest, request: Request):
        try:
            domain = _normalise_blocked_domain(payload.domain)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        item = request.app.state.database.put_blocked_domain(domain, payload.note.strip())
        request.app.state.database.log_audit("blocked_domain_updated", domain)
        return item

    @app.delete("/admin/blocked-domains/{domain}", dependencies=[Depends(require_admin)])
    async def remove_blocked_domain(domain: str, request: Request):
        try:
            normalized = _normalise_blocked_domain(domain)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        removed = request.app.state.database.delete_blocked_domain(normalized)
        if not removed:
            raise HTTPException(status_code=404, detail="blocked domain not found")
        request.app.state.database.log_audit("blocked_domain_removed", normalized)
        return {"ok": True, "domain": normalized}

    @app.get("/admin/orchestration", dependencies=[Depends(require_admin)])
    async def get_orchestration(request: Request):
        orchestrator = request.app.state.service.orchestrator
        return {"summary": orchestrator.summary(), "platforms": orchestrator.platform_views()}

    @app.post("/admin/orchestration/reload", dependencies=[Depends(require_admin)])
    async def reload_orchestration(request: Request):
        orchestrator = request.app.state.service.orchestrator
        orchestrator.reload()
        return {"ok": True, "summary": orchestrator.summary()}

    @app.put("/admin/orchestration/{platform_id}", dependencies=[Depends(require_admin)])
    async def toggle_orchestration(
        platform_id: str, payload: OrchestrationToggle, request: Request
    ):
        try:
            platform = request.app.state.service.orchestrator.set_platform_enabled(
                platform_id, payload.enabled
            )
        except KeyError:
            raise HTTPException(
                status_code=404, detail="orchestration platform not found"
            ) from None
        return {"ok": True, "platform": platform}

    @app.put(
        "/admin/orchestration/{platform_id}/{component_id}",
        dependencies=[Depends(require_admin)],
    )
    async def toggle_orchestration_component(
        platform_id: str,
        component_id: str,
        payload: OrchestrationToggle,
        request: Request,
    ):
        try:
            platform = request.app.state.service.orchestrator.set_component_enabled(
                platform_id, component_id, payload.enabled
            )
        except KeyError:
            raise HTTPException(
                status_code=404, detail="orchestration component not found"
            ) from None
        return {"ok": True, "platform": platform}

    @app.post(
        "/admin/orchestration/{platform_id}/healthcheck",
        dependencies=[Depends(require_admin)],
    )
    async def healthcheck_orchestration(platform_id: str, request: Request):
        try:
            platform = request.app.state.service.orchestrator.healthcheck(platform_id)
        except KeyError:
            raise HTTPException(
                status_code=404, detail="orchestration platform not found"
            ) from None
        return {
            "ok": True,
            "platform": platform,
            "message": "已完成编排清单检查；外部项目和未验证适配器仍需真实 smoke test 才能变更状态。",
        }

    @app.exception_handler(Exception)
    async def unhandled_error(_request: Request, exc: Exception):
        logging.getLogger(__name__).exception("unhandled request error", exc_info=exc)
        return JSONResponse(status_code=500, content={"detail": "internal server error"})

    return app


app = create_app()
