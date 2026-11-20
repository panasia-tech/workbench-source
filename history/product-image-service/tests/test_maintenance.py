from __future__ import annotations

import json

from app.db import Database
from scripts.maintenance.reclassify_empty_batch_tasks import reclassify_empty_tasks
from scripts.maintenance.reclassify_zero_pool_task import reclassify_tasks
from scripts.maintenance.restore_retry_candidate_pools import restore_retry_candidate_pools


def test_reclassify_shortfall_batch_tasks_preserves_diagnostics_and_reason(tmp_path):
    database = Database(tmp_path / "catalog.sqlite3")
    batch_id = "batch_reclassify"
    task_id = "img_reclassify"
    database.create_batch(batch_id, "models.xlsx", 2)
    database.create_task(task_id, "SONOS ERA300", batch_id=batch_id, batch_row=2)
    database.update_task(
        task_id,
        status="completed",
        count=19,
        diagnostics_json={
            "providers": {
                "bing_public": {"state": "degraded", "message": "PoolTimeout: simulated"}
            }
        },
        progress_json={"phase": "completed", "percent": 100},
    )

    complete_task_id = "img_reclassify_complete"
    database.create_task(complete_task_id, "SONOS ARC", batch_id=batch_id, batch_row=3)
    database.update_task(
        complete_task_id,
        status="completed",
        count=20,
        diagnostics_json={},
        progress_json={"phase": "completed", "percent": 100},
    )

    assert reclassify_empty_tasks(database, batch_id, apply=False) == 1
    before = database.get_task(task_id)
    assert before["status"] == "completed"

    assert reclassify_empty_tasks(database, batch_id, apply=True) == 1
    after = database.get_task(task_id)
    assert after["status"] == "failed"
    assert "正式图片不足 20 张" in after["error"]
    assert "PoolTimeout" in after["error"]
    assert json.loads(after["diagnostics_json"])["providers"]["bing_public"]["state"] == "degraded"
    assert json.loads(after["progress_json"])["phase_label"] == "未完成 · 待重试"


def test_reclassify_zero_pool_task_preserves_diagnostics_and_moves_to_pending(tmp_path):
    database = Database(tmp_path / "catalog.sqlite3")
    task_id = "img_zero_pool"
    database.create_batch("batch_zero_pool", "zero-pool.xlsx", 1)
    database.create_task(task_id, "14600K", batch_id="batch_zero_pool", batch_row=144)
    database.update_task(
        task_id,
        status="completed",
        count=0,
        diagnostics_json={
            "candidate_count": 397,
            "image_pools": {
                "formal": {"count": 0},
                "fuzzy": {"count": 0},
                "rejected": {"count": 0},
            },
            "rejection_reasons": {"ssrf_blocked": 100},
        },
        progress_json={"phase": "completed", "percent": 100},
    )

    assert reclassify_tasks(database, [task_id], apply=False) == 1
    assert database.get_task(task_id)["status"] == "completed"

    assert reclassify_tasks(database, [task_id], apply=True) == 1
    after = database.get_task(task_id)
    assert after["status"] == "failed"
    assert "未形成可用图片池" in after["error"]
    assert "安全地址校验拦截 100 个" in after["error"]
    assert json.loads(after["diagnostics_json"])["candidate_count"] == 397
    assert json.loads(after["progress_json"])["phase_label"] == "未完成 · 待重试"


def test_restore_retry_candidate_pools_only_restores_empty_current_rows(tmp_path):
    current = Database(tmp_path / "current.sqlite3")
    source = Database(tmp_path / "source.sqlite3")
    task_id = "img_restore"
    current.create_task(task_id, "14600K", progress_json={})
    current.update_task(
        task_id,
        status="failed",
        count=0,
        images_json=[],
        diagnostics_json={"retry_count": 1, "retry_history": [{"next_query": "14600K"}]},
        progress_json={"phase": "failed", "retry_count": 1},
        error="候选图片均未形成可用图片池",
    )
    source.create_task(task_id, "Intel I5-14600K", progress_json={})
    source.update_task(
        task_id,
        status="completed",
        count=1,
        images_json=[
            {
                "url": "http://127.0.0.1:8090/files/formal.jpg",
                "source_url": "https://example.com/formal",
                "source_domain": "example.com",
                "width": 800,
                "height": 600,
            }
        ],
        diagnostics_json={
            "fuzzy_previews": [
                {
                    "url": "http://127.0.0.1:8090/files/fuzzy.jpg",
                    "source_url": "https://example.com/fuzzy",
                }
            ],
            "rejected_previews": [],
        },
        progress_json={"phase": "completed"},
    )

    assert restore_retry_candidate_pools(
        current, source.path, [task_id], apply=False
    ) == 1
    assert json.loads(current.get_task(task_id)["images_json"]) == []

    assert restore_retry_candidate_pools(current, source.path, [task_id], apply=True) == 1
    restored = current.get_task(task_id)
    assert restored["status"] == "failed"
    assert restored["query"] == "14600K"
    assert restored["error"] == "候选图片均未形成可用图片池"
    assert restored["count"] == 1
    assert len(json.loads(restored["images_json"])) == 1
    diagnostics = json.loads(restored["diagnostics_json"])
    assert len(diagnostics["fuzzy_previews"]) == 1
    assert diagnostics["retry_count"] == 1
    assert diagnostics["restored_from_retry_backup"] is True
    assert diagnostics.get("retry_snapshots", []) == []
    progress = json.loads(restored["progress_json"])
    assert progress["restored_previous_pool"] is True
    assert progress["phase_label"] == "未完成 · 可先复核"


def test_restore_retry_candidate_pools_does_not_overwrite_existing_pool(tmp_path):
    current = Database(tmp_path / "current.sqlite3")
    source = Database(tmp_path / "source.sqlite3")
    task_id = "img_keep"
    current.create_task(task_id, "已有结果", progress_json={})
    current.update_task(
        task_id,
        status="failed",
        count=1,
        images_json=[{"url": "/files/current.jpg"}],
        diagnostics_json={},
        progress_json={},
    )
    source.create_task(task_id, "已有结果", progress_json={})
    source.update_task(
        task_id,
        status="completed",
        count=2,
        images_json=[{"url": "/files/old.jpg"}],
        diagnostics_json={"fuzzy_previews": [{"url": "/files/old-fuzzy.jpg"}]},
        progress_json={},
    )

    assert restore_retry_candidate_pools(current, source.path, [task_id], apply=True) == 0
    restored = current.get_task(task_id)
    assert restored["count"] == 1
    assert json.loads(restored["images_json"])[0]["url"] == "/files/current.jpg"
