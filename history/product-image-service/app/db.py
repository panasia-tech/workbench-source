from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .models import SearchPolicy, SearchTier, default_search_policy


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _retry_count(row: sqlite3.Row | dict[str, Any]) -> int:
    """Return the persisted retry count used for queue prioritisation."""
    try:
        payload = json.loads(str(row["progress_json"] or "{}"))
    except (TypeError, ValueError, KeyError):
        return 0
    if not isinstance(payload, dict):
        return 0
    try:
        return max(0, int(payload.get("retry_count") or 0))
    except (TypeError, ValueError):
        return 0


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(str(path), check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self.init_schema()

    def init_schema(self) -> None:
        with self._lock, self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    task_id TEXT PRIMARY KEY,
                    query TEXT NOT NULL,
                    original_query TEXT NOT NULL DEFAULT '',
                    search_tier TEXT NOT NULL DEFAULT 'balanced',
                    brand TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    image_mode TEXT NOT NULL DEFAULT 'all',
                    locale TEXT,
                    result_limit INTEGER NOT NULL DEFAULT 20,
                    profile TEXT NOT NULL DEFAULT 'auto',
                    min_results INTEGER NOT NULL DEFAULT 0,
                    recall_version INTEGER NOT NULL DEFAULT 1,
                    platforms_json TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    images_json TEXT NOT NULL DEFAULT '[]',
                    diagnostics_json TEXT NOT NULL DEFAULT '{}',
                    pool_decisions_json TEXT NOT NULL DEFAULT '{}',
                    progress_json TEXT NOT NULL DEFAULT '{}',
                    batch_id TEXT,
                    batch_row INTEGER,
                    batch_spu TEXT NOT NULL DEFAULT '',
                    assignee TEXT NOT NULL DEFAULT '',
                    review_status TEXT NOT NULL DEFAULT 'pending',
                    reviewer TEXT NOT NULL DEFAULT '',
                    review_note TEXT NOT NULL DEFAULT '',
                    reviewed_at TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
                CREATE TABLE IF NOT EXISTS batches (
                    batch_id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    total INTEGER NOT NULL,
                    result_limit INTEGER NOT NULL DEFAULT 20,
                    image_mode TEXT NOT NULL DEFAULT 'all',
                    locale TEXT,
                    search_tier TEXT NOT NULL DEFAULT 'balanced',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_batches_updated ON batches(updated_at);
                CREATE TABLE IF NOT EXISTS objects (
                    sha256 TEXT PRIMARY KEY,
                    path TEXT NOT NULL,
                    extension TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS provider_config (
                    provider TEXT PRIMARY KEY,
                    encrypted_values TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS provider_status (
                    provider TEXT PRIMARY KEY,
                    state TEXT NOT NULL,
                    message TEXT NOT NULL DEFAULT '',
                    checked_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    action TEXT NOT NULL,
                    provider TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS blocked_domains (
                    domain TEXT PRIMARY KEY,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            columns = {
                row[1] for row in self._connection.execute("PRAGMA table_info(tasks)").fetchall()
            }
            if "image_mode" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN image_mode TEXT NOT NULL DEFAULT 'all'"
                )
            if "search_tier" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN search_tier TEXT NOT NULL DEFAULT 'balanced'"
                )
            if "pool_decisions_json" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN pool_decisions_json TEXT NOT NULL DEFAULT '{}'"
                )
            if "original_query" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN original_query TEXT NOT NULL DEFAULT ''"
                )
            self._connection.execute(
                "UPDATE tasks SET original_query=query WHERE original_query IS NULL OR original_query=''"
            )
            if "platforms_json" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN platforms_json TEXT NOT NULL DEFAULT '[]'"
                )
            if "result_limit" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN result_limit INTEGER NOT NULL DEFAULT 20"
                )
            if "profile" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN profile TEXT NOT NULL DEFAULT 'auto'"
                )
            if "min_results" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN min_results INTEGER NOT NULL DEFAULT 0"
                )
            if "recall_version" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN recall_version INTEGER NOT NULL DEFAULT 1"
                )
            if "locale" not in columns:
                self._connection.execute("ALTER TABLE tasks ADD COLUMN locale TEXT")
            if "progress_json" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}'"
                )
            if "started_at" not in columns:
                self._connection.execute("ALTER TABLE tasks ADD COLUMN started_at TEXT")
            if "finished_at" not in columns:
                self._connection.execute("ALTER TABLE tasks ADD COLUMN finished_at TEXT")
            if "batch_id" not in columns:
                self._connection.execute("ALTER TABLE tasks ADD COLUMN batch_id TEXT")
            if "batch_row" not in columns:
                self._connection.execute("ALTER TABLE tasks ADD COLUMN batch_row INTEGER")
            if "batch_spu" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN batch_spu TEXT NOT NULL DEFAULT ''"
                )
            if "assignee" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN assignee TEXT NOT NULL DEFAULT ''"
                )
            if "review_status" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'"
                )
            if "reviewer" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN reviewer TEXT NOT NULL DEFAULT ''"
                )
            if "review_note" not in columns:
                self._connection.execute(
                    "ALTER TABLE tasks ADD COLUMN review_note TEXT NOT NULL DEFAULT ''"
                )
            if "reviewed_at" not in columns:
                self._connection.execute("ALTER TABLE tasks ADD COLUMN reviewed_at TEXT")
            self._connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id, batch_row)"
            )

            batch_columns = {
                row[1]
                for row in self._connection.execute("PRAGMA table_info(batches)").fetchall()
            }
            if "search_tier" not in batch_columns:
                self._connection.execute(
                    "ALTER TABLE batches ADD COLUMN search_tier TEXT NOT NULL DEFAULT 'balanced'"
                )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS search_policy (
                    policy_id INTEGER PRIMARY KEY CHECK(policy_id = 1),
                    version INTEGER NOT NULL DEFAULT 1,
                    config_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            if not self._connection.execute(
                "SELECT 1 FROM search_policy WHERE policy_id=1"
            ).fetchone():
                policy = default_search_policy()
                self._connection.execute(
                    "INSERT INTO search_policy(policy_id,version,config_json,updated_at) VALUES(1,?,?,?)",
                    (
                        policy.version,
                        policy.model_dump_json(),
                        utc_now(),
                    ),
                )
            self._connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_tasks_employee_review ON tasks(assignee, review_status, status)"
            )

    def create_task(
        self,
        task_id: str,
        query: str,
        image_mode: str = "all",
        result_limit: int = 20,
        platforms: list[str] | None = None,
        locale: str | None = None,
        progress_json: dict[str, Any] | None = None,
        batch_id: str | None = None,
        batch_row: int | None = None,
        batch_spu: str = "",
        assignee: str = "",
        search_tier: str = SearchTier.balanced.value,
        profile: str = "auto",
        min_results: int = 0,
        recall_version: int = 1,
    ) -> None:
        now = utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO tasks(task_id, query, original_query, search_tier, image_mode, locale, result_limit, profile, min_results, recall_version, platforms_json, status, progress_json, batch_id, batch_row, batch_spu, assignee, review_status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
                (
                    task_id,
                    query,
                    query,
                    search_tier,
                    image_mode,
                    locale,
                    result_limit,
                    profile,
                    min_results,
                    recall_version,
                    self._serialize_platforms(platforms),
                    "queued",
                    json.dumps(progress_json or {}, ensure_ascii=False),
                    batch_id,
                    batch_row,
                    batch_spu,
                    assignee,
                    now,
                    now,
                ),
            )

    def create_batch(
        self,
        batch_id: str,
        filename: str,
        total: int,
        result_limit: int = 20,
        image_mode: str = "all",
        locale: str | None = None,
        search_tier: str = SearchTier.balanced.value,
    ) -> None:
        now = utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO batches(batch_id,filename,total,result_limit,image_mode,locale,search_tier,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (batch_id, filename, total, result_limit, image_mode, locale, search_tier, now, now),
            )

    def get_batch(self, batch_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM batches WHERE batch_id=?", (batch_id,)
            ).fetchone()
            return dict(row) if row else None

    def list_batches(self, limit: int = 20) -> list[dict[str, Any]]:
        safe_limit = max(1, min(limit, 100))
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM batches ORDER BY updated_at DESC LIMIT ?", (safe_limit,)
            ).fetchall()
            return [dict(row) for row in rows]

    def list_tasks_for_batch(self, batch_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM tasks WHERE batch_id=? ORDER BY batch_row ASC", (batch_id,)
            ).fetchall()
            return [dict(row) for row in rows]

    def list_employee_tasks(
        self,
        employee: str,
        *,
        work_date: str | None = None,
        batch_id: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        # 审核是大家共用的一个队列,不分认领人(employee 只用来记谁审的,不再过滤)
        safe_limit = max(1, min(limit, 500))
        clauses: list[str] = []
        params: list[Any] = []
        if work_date:
            local_zone = ZoneInfo("Asia/Shanghai")
            local_start = datetime.fromisoformat(work_date).replace(tzinfo=local_zone)
            utc_start = local_start.astimezone(UTC).isoformat()
            utc_end = (local_start + timedelta(days=1)).astimezone(UTC).isoformat()
            # 当天建的 + 还没审完的(不论哪天建的):ERP 单个发起的任务隔天也得有人审
            clauses.append(
                "((created_at>=? AND created_at<?) OR status IN ('queued','processing')"
                " OR (status='completed' AND review_status!='approved'))"
            )
            params.extend([utc_start, utc_end])
        if batch_id:
            clauses.append("batch_id=?")
            params.append(batch_id)
        params.append(safe_limit)
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM tasks WHERE "
                + (" AND ".join(clauses) or "1=1")
                + " ORDER BY CASE review_status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'needs_changes' THEN 2 WHEN 'approved' THEN 3 ELSE 4 END, "
                + "CASE status WHEN 'processing' THEN 0 WHEN 'queued' THEN 1 WHEN 'completed' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END, created_at ASC LIMIT ?",
                params,
            ).fetchall()
            return [dict(row) for row in rows]

    def find_claimable_employee_task(self, work_date: str | None = None) -> dict[str, Any] | None:
        clauses = [
            "status='completed'",
            "review_status='pending'",
            "(assignee IS NULL OR assignee='')",
        ]
        params: list[Any] = []
        if work_date:
            local_zone = ZoneInfo("Asia/Shanghai")
            local_start = datetime.fromisoformat(work_date).replace(tzinfo=local_zone)
            utc_start = local_start.astimezone(UTC).isoformat()
            utc_end = (local_start + timedelta(days=1)).astimezone(UTC).isoformat()
            clauses.append("created_at>=? AND created_at<?")
            params.extend([utc_start, utc_end])
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM tasks WHERE "
                + " AND ".join(clauses)
                + " ORDER BY finished_at ASC, created_at ASC LIMIT 1",
                params,
            ).fetchone()
            return dict(row) if row else None

    def claim_task(self, task_id: str, employee: str) -> bool:
        now = utc_now()
        with self._lock, self._connection:
            cursor = self._connection.execute(
                "UPDATE tasks SET assignee=?, review_status=CASE WHEN status='completed' AND review_status='pending' THEN 'in_progress' ELSE review_status END, updated_at=? WHERE task_id=? AND (assignee IS NULL OR assignee='' OR assignee=?)",
                (employee, now, task_id, employee),
            )
            return cursor.rowcount > 0

    def requeue_interrupted_tasks(self) -> int:
        """Put tasks left in 'processing' by a restart back in the queue (single worker process)."""
        with self._lock, self._connection:
            cursor = self._connection.execute(
                "UPDATE tasks SET status='queued', started_at=NULL, updated_at=? WHERE status='processing'",
                (utc_now(),),
            )
            return cursor.rowcount

    def claim_next_task(self) -> dict[str, Any] | None:
        with self._lock, self._connection:
            queued = self._connection.execute(
                "SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at"
            ).fetchall()
            if not queued:
                return None
            row = next((candidate for candidate in queued if _retry_count(candidate) > 0), queued[0])
            now = utc_now()
            progress = json.loads(row["progress_json"] or "{}")
            progress.update(
                {
                    "phase": "planning",
                    "phase_label": "准备检索",
                    "percent": max(1, int(progress.get("percent", 0))),
                    "completed": 0,
                    "total": 0,
                    "elapsed_seconds": 0,
                    "eta_seconds": progress.get("estimated_seconds", 0),
                    "message": "正在生成查询计划",
                    "updated_at": now,
                }
            )
            self._connection.execute(
                "UPDATE tasks SET status='processing', started_at=?, finished_at=NULL, progress_json=?, updated_at=? WHERE task_id=?",
                (now, json.dumps(progress, ensure_ascii=False), now, row["task_id"]),
            )
            claimed = dict(row)
            claimed["status"] = "processing"
            claimed["started_at"] = now
            claimed["finished_at"] = None
            claimed["progress_json"] = json.dumps(progress, ensure_ascii=False)
            claimed["updated_at"] = now
            return claimed

    def update_task(self, task_id: str, **values: Any) -> None:
        values["updated_at"] = utc_now()
        assignments = ", ".join(f"{key} = ?" for key in values)
        params = [
            json.dumps(value, ensure_ascii=False) if key.endswith("_json") else value
            for key, value in values.items()
        ]
        params.append(task_id)
        with self._lock, self._connection:
            self._connection.execute(f"UPDATE tasks SET {assignments} WHERE task_id = ?", params)

    def update_task_if_status(self, task_id: str, expected_status: str, **values: Any) -> bool:
        values["updated_at"] = utc_now()
        assignments = ", ".join(f"{key} = ?" for key in values)
        params = [
            json.dumps(value, ensure_ascii=False) if key.endswith("_json") else value
            for key, value in values.items()
        ]
        params.extend([task_id, expected_status])
        with self._lock, self._connection:
            cursor = self._connection.execute(
                f"UPDATE tasks SET {assignments} WHERE task_id = ? AND status = ?", params
            )
            return cursor.rowcount > 0

    def requeue_failed_task(
        self,
        task_id: str,
        *,
        query: str,
        progress_json: dict[str, Any],
        diagnostics_json: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Put one failed task back in the worker queue without losing its history.

        The status predicate makes the transition atomic: two operators clicking
        retry at the same time can only enqueue the task once.
        """
        now = utc_now()
        with self._lock, self._connection:
            row = self._connection.execute(
                "SELECT * FROM tasks WHERE task_id=?", (task_id,)
            ).fetchone()
            if not row or row["status"] != "failed":
                return None
            cursor = self._connection.execute(
                "UPDATE tasks SET query=?, brand='', model='', status='queued', count=0, images_json='[]', "
                "diagnostics_json=?, pool_decisions_json='{}', progress_json=?, error=NULL, started_at=NULL, "
                "finished_at=NULL, updated_at=? WHERE task_id=? AND status='failed'",
                (
                    query,
                    json.dumps(diagnostics_json, ensure_ascii=False),
                    json.dumps(progress_json, ensure_ascii=False),
                    now,
                    task_id,
                ),
            )
            if cursor.rowcount != 1:
                return None
            refreshed = self._connection.execute(
                "SELECT * FROM tasks WHERE task_id=?", (task_id,)
            ).fetchone()
            return dict(refreshed) if refreshed else None

    def get_search_policy(self) -> SearchPolicy:
        with self._lock:
            row = self._connection.execute(
                "SELECT version, config_json FROM search_policy WHERE policy_id=1"
            ).fetchone()
        if not row:
            return default_search_policy()
        try:
            parsed = json.loads(row[1])
            if isinstance(parsed, dict):
                parsed["version"] = int(row[0] or parsed.get("version") or 1)
                return SearchPolicy.model_validate(parsed)
        except (TypeError, ValueError, json.JSONDecodeError):
            pass
        return default_search_policy()

    def put_search_policy(self, policy: SearchPolicy) -> SearchPolicy:
        now = utc_now()
        with self._lock, self._connection:
            current = self._connection.execute(
                "SELECT version FROM search_policy WHERE policy_id=1"
            ).fetchone()
            version = int(current[0] or 0) + 1 if current else max(1, policy.version)
            stored = policy.model_copy(update={"version": version})
            self._connection.execute(
                "INSERT INTO search_policy(policy_id,version,config_json,updated_at) VALUES(1,?,?,?) "
                "ON CONFLICT(policy_id) DO UPDATE SET version=excluded.version,config_json=excluded.config_json,updated_at=excluded.updated_at",
                (version, stored.model_dump_json(), now),
            )
            return stored

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM tasks WHERE task_id=?", (task_id,)
            ).fetchone()
            return dict(row) if row else None

    def list_tasks(
        self,
        statuses: list[str] | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        safe_limit = max(1, min(limit, 200))
        params: list[Any] = []
        where = ""
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            where = f"WHERE status IN ({placeholders})"
            params.extend(statuses)
        params.append(safe_limit)
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM tasks "
                f"{where} "
                "ORDER BY CASE status WHEN 'processing' THEN 0 WHEN 'queued' THEN 1 "
                "WHEN 'failed' THEN 2 WHEN 'cancelled' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END, "
                "created_at ASC LIMIT ?",
                params,
            ).fetchall()
            if statuses and set(statuses).issubset({"queued", "processing"}):
                status_order = {"processing": 0, "queued": 1}
                rows = sorted(
                    rows,
                    key=lambda row: (
                        status_order.get(str(row["status"]), 9),
                        0 if _retry_count(row) > 0 else 1,
                        str(row["created_at"] or ""),
                    ),
                )
            return [dict(row) for row in rows]

    def list_task_bucket(self, bucket: str, limit: int = 50) -> list[dict[str, Any]]:
        """List the operator-facing good/bad lanes without filtering after LIMIT.

        A completed task marked ``needs_changes`` belongs to the bad lane until
        the employee approves it.  Fetching the matching rows before applying
        the UI limit prevents those rows from disappearing behind unrelated
        completed tasks.
        """
        safe_limit = max(1, min(limit, 200))
        if bucket == "good":
            where = (
                "status IN ('queued','processing') OR "
                "(status='completed' AND COALESCE(review_status,'pending') <> 'needs_changes')"
            )
        elif bucket == "bad":
            where = (
                "status='failed' OR "
                "(status='completed' AND COALESCE(review_status,'pending')='needs_changes')"
            )
        else:
            raise ValueError("bucket must be good or bad")
        with self._lock:
            rows = self._connection.execute(
                f"SELECT * FROM tasks WHERE {where}"
            ).fetchall()
        values = [dict(row) for row in rows]
        if bucket == "good":
            status_order = {"processing": 0, "queued": 1, "completed": 2}
            values.sort(
                key=lambda row: (
                    status_order.get(str(row.get("status")), 9),
                    0 if str(row.get("status")) == "queued" and _retry_count(row) > 0 else 1,
                    str(row.get("created_at") or ""),
                )
            )
        else:
            values.sort(
                key=lambda row: (
                    0 if str(row.get("status")) == "failed" else 1,
                    0 if _retry_count(row) > 0 else 1,
                    str(row.get("updated_at") or row.get("created_at") or ""),
                )
            )
        return values[:safe_limit]

    @staticmethod
    def _serialize_platforms(platforms: list[str] | None) -> str:
        return json.dumps(platforms or [], ensure_ascii=False, separators=(",", ":"))

    def find_recent_completed_task(
        self,
        query: str,
        ttl_seconds: int,
        image_mode: str = "all",
        result_limit: int = 20,
        platforms: list[str] | None = None,
        locale: str | None = None,
        search_tier: str = SearchTier.balanced.value,
        profile: str = "auto",
        min_results: int = 0,
        recall_version: int = 1,
    ) -> dict[str, Any] | None:
        if ttl_seconds <= 0:
            return None
        cutoff = (datetime.now(UTC) - timedelta(seconds=ttl_seconds)).isoformat()
        platforms_json = self._serialize_platforms(platforms)
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM tasks WHERE query=? AND image_mode=? AND locale IS ? AND result_limit=? AND platforms_json=? AND search_tier=? "
                "AND profile=? AND min_results=? AND recall_version=? AND count>=? "
                "AND status='completed' AND updated_at>=? "
                "ORDER BY updated_at DESC LIMIT 1",
                (
                    query,
                    image_mode,
                    locale,
                    result_limit,
                    platforms_json,
                    search_tier,
                    profile,
                    min_results,
                    recall_version,
                    min_results,
                    cutoff,
                ),
            ).fetchone()
            return dict(row) if row else None

    def put_object(self, sha256: str, path: str, extension: str, width: int, height: int) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT OR IGNORE INTO objects(sha256,path,extension,width,height,created_at) VALUES(?,?,?,?,?,?)",
                (sha256, path, extension, width, height, utc_now()),
            )

    def get_config(self, provider: str) -> str | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT encrypted_values FROM provider_config WHERE provider=?", (provider,)
            ).fetchone()
            return row[0] if row else None

    def put_config(self, provider: str, encrypted_values: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO provider_config(provider,encrypted_values,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(provider) DO UPDATE SET encrypted_values=excluded.encrypted_values,updated_at=excluded.updated_at",
                (provider, encrypted_values, utc_now()),
            )

    def set_provider_status(self, provider: str, state: str, message: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO provider_status(provider,state,message,checked_at) VALUES(?,?,?,?) "
                "ON CONFLICT(provider) DO UPDATE SET state=excluded.state,message=excluded.message,checked_at=excluded.checked_at",
                (provider, state, message[:500], utc_now()),
            )

    def get_provider_status(self, provider: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM provider_status WHERE provider=?", (provider,)
            ).fetchone()
            return dict(row) if row else None

    def log_audit(self, action: str, provider: str | None = None) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO audit_log(action,provider,created_at) VALUES(?,?,?)",
                (action, provider, utc_now()),
            )

    def list_blocked_domains(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT domain,note,created_at,updated_at FROM blocked_domains ORDER BY domain"
            ).fetchall()
            return [dict(row) for row in rows]

    def put_blocked_domain(self, domain: str, note: str = "") -> dict[str, Any]:
        now = utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO blocked_domains(domain,note,created_at,updated_at) VALUES(?,?,?,?) "
                "ON CONFLICT(domain) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at",
                (domain, note[:500], now, now),
            )
            row = self._connection.execute(
                "SELECT domain,note,created_at,updated_at FROM blocked_domains WHERE domain=?",
                (domain,),
            ).fetchone()
            return dict(row) if row else {"domain": domain, "note": note}

    def delete_blocked_domain(self, domain: str) -> bool:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                "DELETE FROM blocked_domains WHERE domain=?", (domain,)
            )
            return cursor.rowcount > 0
