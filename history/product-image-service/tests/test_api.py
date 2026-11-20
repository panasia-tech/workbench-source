from __future__ import annotations

import asyncio
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app.adapters import AdapterRun
from app.main import create_app
from app.models import ProviderState

from .conftest import make_settings


def test_create_and_read_task(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        response = client.post("/v1/images/search", json={"query": "sonos era300", "limit": 20, "search_tier": "strict"})
        assert response.status_code == 202
        task_id = response.json()["task_id"]
        for _ in range(20):
            result = client.get(f"/v1/images/tasks/{task_id}")
            if result.json()["status"] not in {"queued", "processing"}:
                break
            time.sleep(0.05)
        assert result.status_code == 200
        assert result.json()["query"] == "sonos era300"
        assert result.json()["count"] == 0
        assert result.json()["limit"] == 20
        assert result.json()["search_tier"] == "strict"
        assert result.json()["progress"]["percent"] == 100
        assert result.json()["started_at"] is not None
        assert result.json()["finished_at"] is not None
        cached = client.post("/v1/images/search", json={"query": "sonos era300"})
        assert cached.status_code == 202
        assert cached.json()["task_id"] != task_id


def test_provider_outage_is_not_reported_as_completed_zero_result(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 0.01
    app = create_app(settings)

    class DegradedAdapters:
        def describe(self):
            return []

        async def run_all(self, product, queries, max_parallel=4):
            return [AdapterRun("bing_public", ProviderState.degraded, "PoolTimeout: simulated", [])]

    with TestClient(app) as client:
        app.state.service.adapters = DegradedAdapters()
        response = client.post(
            "/v1/images/search", json={"query": "AOC 24G2", "refresh": True}
        )
        task_id = response.json()["task_id"]
        for _ in range(60):
            result = client.get(f"/v1/images/tasks/{task_id}")
            if result.json()["status"] not in {"queued", "processing"}:
                break
            time.sleep(0.03)
        assert result.json()["status"] == "failed"
        assert "公开来源检索暂时失败" in result.json()["error"]
        assert result.json()["diagnostics"]["provider_failures"][0]["provider"] == "bing_public"


def test_task_buckets_move_failed_retry_back_to_good_lane(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 60
    app = create_app(settings)
    with TestClient(app) as client:
        database = app.state.database
        database.create_task("good-task", "AOC 24G2")
        database.update_task(
            "good-task",
            status="completed",
            count=2,
            progress_json={"phase": "completed", "percent": 100},
        )
        database.create_task("bad-task", "Intel 14600K")
        database.update_task(
            "bad-task",
            status="failed",
            error="公开来源检索暂时失败",
            progress_json={"phase": "failed", "percent": 100, "retry_count": 1},
        )
        database.create_task("review-task", "ASUS VG249Q3A")
        database.update_task(
            "review-task",
            status="completed",
            count=3,
            review_status="needs_changes",
            review_note="第 2 张疑似其他型号",
            progress_json={"phase": "completed", "percent": 100},
        )

        good = client.get("/v1/images/tasks?bucket=good&limit=20")
        bad = client.get("/v1/images/tasks?bucket=bad&limit=20")
        assert good.status_code == 200
        assert {task["task_id"] for task in good.json()["tasks"]} == {"good-task"}
        assert {task["lane"] for task in good.json()["tasks"]} == {"good"}
        assert {task["task_id"] for task in bad.json()["tasks"]} == {
            "bad-task",
            "review-task",
        }
        assert {task["lane"] for task in bad.json()["tasks"]} == {"bad"}
        review_item = next(
            task for task in bad.json()["tasks"] if task["task_id"] == "review-task"
        )
        assert review_item["review_status"] == "needs_changes"
        assert review_item["review_note"] == "第 2 张疑似其他型号"
        assert review_item["lane"] == "bad"

        database.update_task("review-task", review_status="approved")
        good_after_review = client.get("/v1/images/tasks?bucket=good&limit=20")
        bad_after_review = client.get("/v1/images/tasks?bucket=bad&limit=20")
        assert "review-task" in {task["task_id"] for task in good_after_review.json()["tasks"]}
        assert "review-task" not in {task["task_id"] for task in bad_after_review.json()["tasks"]}

        retried = client.post(
            "/v1/images/tasks/bad-task/retry", json={"query": "Intel Core i5-14600K"}
        )
        assert retried.status_code == 202
        assert retried.json()["status"] == "queued"
        assert retried.json()["lane"] == "good"
        assert retried.json()["query"] == "Intel Core i5-14600K"

        good_after_retry = client.get("/v1/images/tasks?bucket=good&limit=20")
        bad_after_retry = client.get("/v1/images/tasks?bucket=bad&limit=20")
        assert {task["task_id"] for task in good_after_retry.json()["tasks"]} == {
            "good-task",
            "bad-task",
            "review-task",
        }
        assert bad_after_retry.json()["tasks"] == []


def test_admin_masks_and_saves_credentials(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        assert client.post("/admin/login", json={"password": "DEMO_ONLY_REDACTED"}).status_code == 200
        saved = client.put(
            "/admin/providers/brave/credentials", json={"values": {"api_key": "DEMO_ONLY_REDACTED"}}
        )
        assert saved.status_code == 200
        providers = client.get("/admin/providers")
        assert providers.status_code == 200
        assert providers.json()["vault_enabled"] is True
        assert "secret-value" not in providers.text


def test_local_dev_admin_loads_without_login(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        access = client.get("/admin/access")
        assert access.status_code == 200
        assert access.json()["auth_required"] is False
        assert client.get("/admin/providers").status_code == 200


def test_admin_queue_refresh_keeps_scroll_anchor_contract():
    html = (Path(__file__).resolve().parents[1] / "app/static/admin.html").read_text()

    assert "overflow-anchor: none" in html
    assert "scroll-behavior: auto" in html
    assert "function captureQueueViewport()" in html
    assert "function restoreQueueViewport(snapshot)" in html
    assert "function patchQueueRow(row, task)" in html
    assert "function createQueueRow(task)" in html
    assert "queue.insertBefore(row, current || null);" in html
    assert "function isRetryTask(task)" in html
    assert "data-queue-divider" in html
    assert "已置于普通任务之前" in html
    assert "重试任务（优先处理）" in html
    assert "scroller.scrollTop = snapshot.scrollTop;" in html
    assert "if (renderSignature === queueRenderSignature) return;" in html
    assert 'data-task-id="' in html
    assert "function taskLane(task)" in html
    assert "taskLane(task) === 'good'" in html


def test_admin_good_bad_batch_lists_have_separated_header_contract():
    html = (Path(__file__).resolve().parents[1] / "app/static/admin.html").read_text()

    assert '.batch-items[data-filter="bad"] .batch-items-head' in html
    assert "container.dataset.filter = filter;" in html
    assert "好的列表" in html
    assert "坏的列表" in html


def test_admin_batch_refresh_preserves_open_list_and_exposes_unfinished_queue():
    html = (Path(__file__).resolve().parents[1] / "app/static/admin.html").read_text()

    assert "function batchCardMarkup(batch)" in html
    assert "function patchBatchCard(card, batch)" in html
    assert "function renderUnfinishedQueue(data)" in html
    assert "function captureUnfinishedViewport()" in html
    assert "function patchUnfinishedRow(row, task)" in html
    assert "bucket=bad&limit=200" in html
    assert "data-unfinished-task" in html
    assert "未完成原因：" in html
    assert "名称历史：" in html
    assert "review_status === 'needs_changes'" in html
    assert "坏任务" in html
    assert "originModule === 'unfinished' ? 'unfinished' : 'queue'" in html
    assert "function taskLane(task)" in html
    assert "await loadUnfinishedQueue();" in html


def test_search_policy_can_be_read_and_updated(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        current = client.get("/admin/search-policy")
        assert current.status_code == 200
        payload = current.json()
        payload["tiers"]["broad"]["confidence_threshold"] = 0.51
        updated = client.put("/admin/search-policy", json={"tiers": payload["tiers"]})
        assert updated.status_code == 200
        assert updated.json()["tiers"]["broad"]["confidence_threshold"] == 0.51
        assert updated.json()["version"] > payload["version"]


def test_admin_blocked_domain_crud_normalizes_urls(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        assert client.get("/admin/blocked-domains").json() == {"domains": []}
        added = client.post(
            "/admin/blocked-domains",
            json={"domain": "https://www.example.com/celebrity/search?q=1", "note": "无关娱乐图"},
        )
        assert added.status_code == 200
        assert added.json()["domain"] == "example.com"
        assert added.json()["note"] == "无关娱乐图"
        listed = client.get("/admin/blocked-domains")
        assert [item["domain"] for item in listed.json()["domains"]] == ["example.com"]
        removed = client.delete("/admin/blocked-domains/www.example.com")
        assert removed.status_code == 200
        assert client.delete("/admin/blocked-domains/example.com").status_code == 404
        invalid = client.post("/admin/blocked-domains", json={"domain": "not-a-domain"})
        assert invalid.status_code == 422


def test_pool_decisions_move_preview_into_formal_pool(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        database = app.state.database
        database.create_task("img_pool", "AOC 24G2", progress_json={})
        database.update_task(
            "img_pool",
            status="completed",
            count=1,
            images_json=[
                {
                    "url": "http://testserver/files/formal.jpg",
                    "source_url": "https://example.com/formal",
                    "source_domain": "example.com",
                    "source_type": "web",
                    "width": 800,
                    "height": 600,
                    "watermark": "unknown",
                    "product_confidence": 0.9,
                    "score": 120,
                    "provider": "test",
                }
            ],
            diagnostics_json={
                "fuzzy_previews": [
                    {
                        "url": "http://testserver/files/fuzzy.jpg",
                        "source_url": "https://example.com/fuzzy",
                        "source_domain": "example.com",
                        "width": 800,
                        "height": 600,
                        "provider": "test",
                        "reason": "insufficient_model_evidence",
                    }
                ]
            },
            progress_json={"phase": "completed", "percent": 100},
            finished_at="2026-08-31T00:00:00+00:00",
        )
        moved = client.post(
            "/v1/images/tasks/img_pool/pool-decisions",
            json={"decisions": [{"image_key": "http://testserver/files/fuzzy.jpg", "pool": "formal"}]},
        )
        assert moved.status_code == 200
        assert moved.json()["count"] == 2
        assert moved.json()["candidate_images"] == []


def test_remote_admin_keeps_authentication_gate(tmp_path):
    settings = make_settings(tmp_path)
    settings.admin_auth_mode = "required"
    app = create_app(settings)
    with TestClient(app) as client:
        assert client.get("/admin/providers").status_code == 401
        assert client.post("/admin/login", json={"password": "DEMO_ONLY_REDACTED"}).status_code == 200
        assert client.get("/admin/providers").status_code == 200


def test_admin_includes_search_workbench(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        page = client.get("/admin")
        assert page.status_code == 200
        assert "产品图片检索工作台" in page.text
        assert 'href="/employee"' in page.text
        assert "AOC 24G2" in page.text
        assert "复制整理摘要" in page.text
        assert "查看淘汰候选图片" in page.text
        assert "本次搜索用了哪些小巧思" in page.text
        assert "候选搜索词" in page.text
        assert 'id="query-candidates"' in page.text
        assert "data-query-candidate" in page.text
        assert "好的列表" in page.text
        assert "坏的列表" in page.text
        assert "取消任务" in page.text
        assert "历史任务" in page.text
        assert "查看结果" in page.text
        assert 'id="open-pools"' in page.text
        assert "include_history=true" in page.text
        assert "批量导入 Excel" in page.text
        assert "导入并开始" in page.text
        assert "好的列表" in page.text
        assert "坏的列表" in page.text
        assert "未完成原因：" in page.text
        assert "重新搜索" in page.text
        assert "重新搜索名称（可修改）" in page.text
        assert "名称历史" in page.text
        assert "重试失败任务" in page.text
        assert "/retry-failed" in page.text
        assert 'data-batch-filter="good"' in page.text
        assert 'data-batch-filter="bad"' in page.text
        assert "已完成" in page.text
        assert "/v1/images/batches/import" in page.text
        assert "预计还需" in page.text
        assert "最多 300 张" in page.text
        assert "最多 500 张" in page.text
        assert 'id="search-tier"' in page.text
        assert "严格" in page.text and "宽松" in page.text
        assert "快速划分图片池" in page.text
        assert "/admin/search-policy" in page.text
        assert "屏蔽网站" in page.text
        assert "/admin/blocked-domains" in page.text
        assert "data-remove-blocked" in page.text
        assert "viewTaskRequestSeq" in page.text
        assert "activeViewTaskId" in page.text
        assert 'data-task-id' in page.text


def test_admin_and_employee_pages_disable_html_cache(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        for path in ("/admin", "/employee"):
            response = client.get(path)
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-store, max-age=0"
            assert response.headers["pragma"] == "no-cache"


def test_batch_import_tracks_items_progress_and_cancellation(tmp_path):
    from .test_excel_import import make_xlsx

    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 0.05
    app = create_app(settings)
    with TestClient(app) as client:
        service = app.state.service

        async def slow_process(*_args):
            await asyncio.sleep(30)

        service.process_task = slow_process
        workbook = make_xlsx(
            [
                ["品牌+型号", "SPU编码"],
                ["AOC 24G2", "sku-1"],
                ["华硕 PG248QP", "sku-2"],
                ["盛色 N50PRO6", "sku-3"],
            ]
        )
        created = client.post(
            "/v1/images/batches/import?filename=models.xlsx",
            content=workbook,
            headers={"content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
        )
        assert created.status_code == 202
        payload = created.json()
        assert payload["total"] == 3
        assert payload["percent"] == 0
        assert [item["spu"] for item in payload["items"]] == ["sku-1", "sku-2", "sku-3"]

        batch_id = payload["batch_id"]
        listed = client.get("/v1/images/batches").json()
        assert listed["batches"][0]["batch_id"] == batch_id

        cancelled = client.post(f"/v1/images/batches/{batch_id}/cancel")
        assert cancelled.status_code == 200
        assert cancelled.json()["cancelled"] == 3
        assert cancelled.json()["percent"] == 0


def test_batch_progress_reports_completed_percentage(tmp_path):
    from .test_excel_import import make_xlsx

    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 10
    app = create_app(settings)
    with TestClient(app) as client:
        async def slow_process(*_args):
            await asyncio.sleep(30)

        app.state.service.process_task = slow_process
        created = client.post(
            "/v1/images/batches/import?filename=models.xlsx",
            content=make_xlsx(
                [["品牌+型号", "SPU编码"], ["AOC 24G2", "sku-1"], ["华硕 PG248QP", "sku-2"], ["盛色 N50PRO6", "sku-3"]]
            ),
            headers={"content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
        )
        batch_id = created.json()["batch_id"]
        first_task = app.state.database.list_tasks_for_batch(batch_id)[0]
        app.state.database.update_task(
            first_task["task_id"],
            status="completed",
            count=2,
            images_json=[],
            diagnostics_json={},
            progress_json={"phase": "completed", "percent": 100},
            finished_at="2026-08-28T00:00:01+00:00",
        )
        detail = client.get(f"/v1/images/batches/{batch_id}")
        assert detail.status_code == 200
        assert detail.json()["completed"] == 1
        assert detail.json()["percent"] == 33.3
        assert detail.json()["settled_percent"] == 33.3
        assert detail.json()["status"] == "processing"


def test_queue_lists_and_cancels_queued_task(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 10
    app = create_app(settings)
    with TestClient(app) as client:
        first = client.post(
            "/v1/images/search", json={"query": "AOC 24G2", "limit": 30, "refresh": True}
        )
        second = client.post(
            "/v1/images/search", json={"query": "ROG XG259CMS", "limit": 30, "refresh": True}
        )
        assert first.status_code == 202
        assert second.status_code == 202

        queue = client.get("/v1/images/tasks")
        assert queue.status_code == 200
        assert queue.json()["active_count"] == 2
        queued = {item["task_id"]: item for item in queue.json()["tasks"]}
        assert queued[first.json()["task_id"]]["status"] == "queued"
        assert queued[second.json()["task_id"]]["progress"]["queue_position"] == 2
        assert queued[second.json()["task_id"]]["progress"]["estimated_seconds"] == 180

        cancelled = client.post(f"/v1/images/tasks/{second.json()['task_id']}/cancel")
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] == "cancelled"
        assert cancelled.json()["progress"]["phase"] == "cancelled"
        assert client.get(f"/v1/images/tasks/{second.json()['task_id']}").json()["status"] == "cancelled"

        queue_after = client.get("/v1/images/tasks").json()
        assert queue_after["active_count"] == 1
        assert [item["task_id"] for item in queue_after["tasks"]] == [first.json()["task_id"]]


def test_failed_task_retry_endpoint_requeues_task(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 10
    app = create_app(settings)
    with TestClient(app) as client:
        app.state.service.stop_event.set()
        time.sleep(0.05)
        service = app.state.service
        task_id = service.create_task("AOC 24G2", refresh=True)
        app.state.database.update_task(
            task_id,
            status="failed",
            error="公开来源检索暂时失败",
            diagnostics_json={"provider_failures": [{"provider": "bing_public"}]},
            progress_json={"phase": "failed", "percent": 100},
            finished_at="2026-08-30T00:00:00+00:00",
        )
        response = client.post(
            f"/v1/images/tasks/{task_id}/retry",
            json={"query": "ASUS ROG XG259CMS"},
        )
        assert response.status_code == 202
        payload = response.json()
        assert payload["task_id"] == task_id
        assert payload["status"] == "queued"
        assert payload["error"] is None
        assert payload["query"] == "ASUS ROG XG259CMS"
        assert payload["original_query"] == "AOC 24G2"
        assert payload["query_history"] == ["AOC 24G2", "ASUS ROG XG259CMS"]
        assert payload["diagnostics"]["retry_count"] == 1
        assert payload["diagnostics"]["retry_history"][0]["previous_query"] == "AOC 24G2"
        assert payload["diagnostics"]["retry_history"][0]["next_query"] == "ASUS ROG XG259CMS"
        assert payload["diagnostics"]["retry_history"][0]["edited"] is True
        assert payload["progress"]["message"] == "已重新排队，等待第 1 次重试"


def test_task_queue_can_filter_failed_tasks_for_unfinished_work(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 10
    app = create_app(settings)
    with TestClient(app) as client:
        app.state.service.stop_event.set()
        time.sleep(0.05)
        task_id = app.state.service.create_task("Intel Core i5-14600K", refresh=True)
        app.state.database.update_task(
            task_id,
            status="failed",
            error="正式图片不足 20 张（当前 3 张）",
            diagnostics_json={
                "retry_count": 2,
                "retry_history": [
                    {"previous_query": "i5 14600K", "next_query": "Intel Core i5-14600K"}
                ],
            },
            progress_json={"phase": "failed", "percent": 100},
            finished_at="2026-08-30T00:00:00+00:00",
        )

        response = client.get("/v1/images/tasks?status=failed&limit=200")

        assert response.status_code == 200
        payload = response.json()
        assert payload["active_count"] == 0
        assert len(payload["tasks"]) == 1
        assert payload["tasks"][0]["task_id"] == task_id
        assert payload["tasks"][0]["status"] == "failed"
        assert payload["tasks"][0]["error"] == "正式图片不足 20 张（当前 3 张）"
        assert payload["tasks"][0]["query_history"] == ["Intel Core i5-14600K"]


def test_failed_batch_retry_endpoint_requeues_only_failed_items(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 10
    app = create_app(settings)
    with TestClient(app) as client:
        app.state.service.stop_event.set()
        time.sleep(0.05)
        database = app.state.database
        service = app.state.service
        batch_id = "batch_retry"
        database.create_batch(batch_id, "retry.xlsx", 2)
        task_ids = []
        for index, query in enumerate(["AOC 24G2", "ROG XG259CMS"], 1):
            task_id = service.create_task(
                query,
                refresh=True,
                batch_id=batch_id,
                batch_row=index,
                batch_spu=f"sku-{index}",
            )
            task_ids.append(task_id)
            database.update_task(
                task_id,
                status="failed",
                error="待重试：没有通过校验的正式图片。",
                progress_json={"phase": "failed", "percent": 100},
                finished_at="2026-08-30T00:00:00+00:00",
            )
        response = client.post(f"/v1/images/batches/{batch_id}/retry-failed")
        assert response.status_code == 202
        assert response.json()["queued"] == 2
        assert {item["status"] for item in response.json()["items"]} == {"queued"}
        assert all(
            database.get_task(task_id)["status"] == "queued" for task_id in task_ids
        )


def test_processing_task_can_be_cancelled(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 0.05
    app = create_app(settings)
    with TestClient(app) as client:
        service = app.state.service

        async def slow_process(*_args):
            await asyncio.sleep(30)

        service.process_task = slow_process
        accepted = client.post(
            "/v1/images/search", json={"query": "AOC 24G2", "limit": 30, "refresh": True}
        )
        task_id = accepted.json()["task_id"]
        for _ in range(30):
            detail = client.get(f"/v1/images/tasks/{task_id}").json()
            if detail["status"] == "processing":
                break
            time.sleep(0.05)
        assert detail["status"] == "processing"

        cancelled = client.post(f"/v1/images/tasks/{task_id}/cancel")
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] == "cancelled"
        assert cancelled.json()["error"] == "task cancelled by user"
        time.sleep(0.1)
        assert client.get(f"/v1/images/tasks/{task_id}").json()["status"] == "cancelled"


def test_search_accepts_500_result_limit(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/v1/images/search",
            json={"query": "AOC 24G10ZNE", "limit": 500},
        )

        assert response.status_code == 202


def test_admin_orchestration_exposes_platform_component_counts(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        assert client.post("/admin/login", json={"password": "DEMO_ONLY_REDACTED"}).status_code == 200
        response = client.get("/admin/orchestration")
        assert response.status_code == 200
        payload = response.json()
        assert payload["summary"]["platform_count"] >= 20
        platforms = {item["id"]: item for item in payload["platforms"]}
        assert platforms["taobao"]["component_count"] == 8
        assert platforms["kuaishou"]["component_count"] == 5
        assert platforms["mercari"]["component_count"] == 3
        assert platforms["facebook_marketplace"]["component_count"] == 2

        disabled = client.put(
            "/admin/orchestration/taobao",
            json={"enabled": False},
        )
        assert disabled.status_code == 200
        assert disabled.json()["platform"]["enabled"] is False

        component = client.put(
            "/admin/orchestration/mercari/mercari_public_page",
            json={"enabled": False},
        )
        assert component.status_code == 200
        assert component.json()["platform"]["enabled_component_count"] == 2

        healthcheck = client.post("/admin/orchestration/taobao/healthcheck")
        assert healthcheck.status_code == 200
        assert "真实 smoke test" in healthcheck.json()["message"]


def test_search_records_image_mode_and_orchestration_plan(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/v1/images/search",
            json={
                "query": "AOC 24G2",
                "image_mode": "real_photo",
                "platforms": ["taobao", "mercari"],
            },
        )
        assert response.status_code == 202
        task_id = response.json()["task_id"]
        for _ in range(20):
            result = client.get(f"/v1/images/tasks/{task_id}")
            if result.json()["status"] == "completed":
                break
            time.sleep(0.05)
        payload = result.json()
        assert payload["image_mode"] == "real_photo"
        assert payload["diagnostics"]["image_mode"] == "real_photo"
        planned = {item["id"] for item in payload["diagnostics"]["orchestration"]["platforms"]}
        assert planned == {"taobao", "mercari"}


def test_search_cache_isolated_by_image_mode_and_platforms(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        first = client.post("/v1/images/search", json={"query": "AOC 24G2"})
        assert first.status_code == 202
        first_task_id = first.json()["task_id"]
        for _ in range(20):
            result = client.get(f"/v1/images/tasks/{first_task_id}")
            if result.json()["status"] == "completed":
                break
            time.sleep(0.05)

        different_mode = client.post(
            "/v1/images/search",
            json={"query": "AOC 24G2", "image_mode": "real_photo"},
        )
        different_platforms = client.post(
            "/v1/images/search",
            json={"query": "AOC 24G2", "platforms": ["taobao"]},
        )
        assert different_mode.json()["task_id"] != first_task_id
        assert different_platforms.json()["task_id"] != first_task_id


def test_search_supports_100_result_limit(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/v1/images/search",
            json={"query": "AOC 24G2", "limit": 100},
        )
        assert response.status_code == 202
        task_id = response.json()["task_id"]
        for _ in range(20):
            result = client.get(f"/v1/images/tasks/{task_id}")
            if result.json()["status"] == "completed":
                break
            time.sleep(0.05)
        payload = result.json()
        assert payload["limit"] == 100
        assert payload["diagnostics"]["limit"] == 100


def test_search_persists_locale_and_market_query_plan(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/v1/images/search",
            json={"query": "ROG PG27UQR", "locale": "ja", "platforms": ["rakuten", "taobao"]},
        )
        assert response.status_code == 202
        task_id = response.json()["task_id"]
        for _ in range(20):
            result = client.get(f"/v1/images/tasks/{task_id}")
            if result.json()["status"] == "completed":
                break
            time.sleep(0.05)
        payload = result.json()
        assert payload["locale"] == "ja"
        assert payload["diagnostics"]["locale"] == "ja"
        market_ids = {item["id"] for item in payload["diagnostics"]["query_plan"]["platforms"]}
        assert market_ids == {"rakuten"}
        assert payload["diagnostics"]["query_plan"]["skipped_platforms"][0]["id"] == "taobao"


def test_rejected_previews_stay_out_of_candidate_pool(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        database = app.state.database
        database.create_task("img_noise", "AOC 24G2", progress_json={})
        preview = {"source_domain": "example.com", "width": 800, "height": 600, "provider": "test"}
        database.update_task(
            "img_noise",
            status="completed",
            count=0,
            images_json=[],
            diagnostics_json={
                "fuzzy_previews": [{**preview, "url": "http://testserver/files/fuzzy.jpg"}],
                "rejected_previews": [
                    {**preview, "url": "http://testserver/files/news.jpg"},
                    {**preview, "url": "http://testserver/files/kept.jpg"},
                ],
            },
            pool_decisions_json={"http://testserver/files/kept.jpg": "formal"},
            progress_json={"phase": "completed", "percent": 100},
            finished_at="2026-11-05T00:00:00+00:00",
        )
        task = client.get("/v1/images/tasks/img_noise").json()
        assert [image["url"] for image in task["candidate_images"]] == ["http://testserver/files/fuzzy.jpg"]
        assert [image["url"] for image in task["images"]] == ["http://testserver/files/kept.jpg"]


def test_search_persists_listing_profile_and_recall_fields(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/v1/images/search",
            json={
                "query": "AOC 24G2",
                "limit": 40,
                "profile": "listing",
                "min_results": 20,
                "recall_version": 2,
                "refresh": True,
            },
        )
        assert response.status_code == 202
        task_id = response.json()["task_id"]
        for _ in range(20):
            result = client.get(f"/v1/images/tasks/{task_id}")
            if result.json()["status"] == "completed":
                break
            time.sleep(0.05)
        payload = result.json()
        assert payload["profile"] == "listing"
        assert payload["min_results"] == 20
        assert payload["recall_version"] == 2
        assert payload["diagnostics"]["listing_profile"] is True
        assert payload["diagnostics"]["deep_recall"] is True


def test_thin_cached_task_is_not_reused_when_min_results_requested(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        first = client.post("/v1/images/search", json={"query": "AOC 24G2", "limit": 20})
        first_id = first.json()["task_id"]
        for _ in range(20):
            if client.get(f"/v1/images/tasks/{first_id}").json()["status"] == "completed":
                break
            time.sleep(0.05)
        # 空结果算薄结果:要求至少 1 张时不能复用
        second = client.post(
            "/v1/images/search",
            json={"query": "AOC 24G2", "limit": 20, "min_results": 1},
        )
        assert second.json()["task_id"] != first_id


def test_cache_is_isolated_by_recall_version(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        first = client.post("/v1/images/search", json={"query": "AOC 24G2", "limit": 20})
        first_id = first.json()["task_id"]
        for _ in range(20):
            if client.get(f"/v1/images/tasks/{first_id}").json()["status"] == "completed":
                break
            time.sleep(0.05)
        second = client.post(
            "/v1/images/search",
            json={"query": "AOC 24G2", "limit": 20, "recall_version": 2},
        )
        assert second.json()["task_id"] != first_id
