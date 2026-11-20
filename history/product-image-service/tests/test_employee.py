import asyncio

from fastapi.testclient import TestClient

from app.db import Database
from app.main import create_app

from .conftest import make_settings
from .test_excel_import import make_xlsx


def _mark_completed(database, task_id: str, *, count: int = 2) -> None:
    database.update_task(
        task_id,
        status="completed",
        count=count,
        images_json=[
            {
                "url": "/files/example.jpg",
                "source_url": "https://example.com/product",
                "source_domain": "example.com",
                "source_type": "web",
                "width": 640,
                "height": 480,
                "watermark": "none",
                "product_confidence": 0.9,
                "score": 0.8,
                "provider": "official",
            }
        ],
        diagnostics_json={},
        progress_json={"phase": "completed", "percent": 100},
        finished_at="2026-08-28T00:00:01+00:00",
    )


def test_employee_intake_assigns_tasks_and_review_updates_workbench(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 10
    app = create_app(settings)
    with TestClient(app) as client:
        async def slow_process(*_args):
            await asyncio.sleep(30)

        app.state.service.process_task = slow_process
        response = client.post(
            "/v1/employee/intake?employee=小王&filename=today.xlsx",
            content=make_xlsx(
                [["品牌+型号", "SPU编码"], ["AOC 24G2", "sku-1"], ["华硕 PG248QP", "sku-2"]]
            ),
            headers={
                "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "x-filename": "today.xlsx",
            },
        )
        assert response.status_code == 202
        batch_id = response.json()["batch_id"]
        rows = app.state.database.list_tasks_for_batch(batch_id)
        assert len(rows) == 2
        assert {row["assignee"] for row in rows} == {"小王"}
        assert {row["review_status"] for row in rows} == {"pending"}

        _mark_completed(app.state.database, rows[0]["task_id"])
        workbench = client.get("/v1/employee/workbench?employee=小王")
        assert workbench.status_code == 200
        assert workbench.json()["total"] == 2
        assert workbench.json()["crawl_completed"] == 1
        assert workbench.json()["review_pending"] == 1
        assert workbench.json()["tasks"][0]["batch_id"] == batch_id

        detail = client.get(f"/v1/employee/tasks/{rows[0]['task_id']}?employee=小王")
        assert detail.status_code == 200
        assert detail.json()["images"][0]["url"] == "/files/example.jpg"
        reviewed = client.post(
            f"/v1/employee/tasks/{rows[0]['task_id']}/review?employee=小王",
            json={"decision": "needs_changes", "note": "第 1 张疑似杂图"},
        )
        assert reviewed.status_code == 200
        assert reviewed.json()["review_status"] == "needs_changes"
        assert reviewed.json()["reviewer"] == "小王"
        assert reviewed.json()["lane"] == "bad"

        batch = client.get(f"/v1/images/batches/{batch_id}").json()
        assert batch["needs_changes"] == 1
        batch_item = next(item for item in batch["items"] if item["task_id"] == rows[0]["task_id"])
        assert batch_item["review_status"] == "needs_changes"
        assert batch_item["review_note"] == "第 1 张疑似杂图"
        assert batch_item["lane"] == "bad"

        refreshed = client.get("/v1/employee/workbench?employee=小王").json()
        assert refreshed["review_pending"] == 0
        assert refreshed["review_needs_changes"] == 1


def test_employee_page_guards_detail_response_to_selected_task(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        page = client.get("/employee")
        assert page.status_code == 200
        assert "detailRequestSeq" in page.text
        assert "task.task_id !== selectedTaskId" in page.text
        assert "任务未完成，请根据原因处理。" in page.text
        assert "retry-task" in page.text
        assert "重新排队" in page.text
        assert "重新搜索名称（可修改）" in page.text
        assert "名称历史" in page.text


def test_employee_queue_refresh_is_keyed_and_scroll_stable():
    from pathlib import Path

    html = (Path(__file__).resolve().parents[1] / "app/static/employee.html").read_text()

    assert "function captureQueueViewport()" in html
    assert "function restoreQueueViewport(snapshot)" in html
    assert "function patchTaskRow(row, task)" in html
    assert "state.queueRenderSignature" in html
    assert "state.workbenchRequestSeq" in html
    assert "renderKpis(payload); if (!keepSelection" in html
    assert 'data-filter="good"' in html
    assert 'data-filter="bad"' in html
    assert "function isBadTask(task)" in html
    assert "function taskLane(task)" in html
    assert "state.filter = decision === 'needs_changes' ? 'bad' : 'good'" in html
    assert "后续任务（重试任务在上方）" in html


def test_employee_can_claim_unassigned_completed_task(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        accepted = client.post(
            "/v1/images/search", json={"query": "AOC 24G2", "refresh": True}
        )
        task_id = accepted.json()["task_id"]
        _mark_completed(app.state.database, task_id)
        app.state.database.update_task(task_id, assignee="", review_status="pending")

        claimed = client.post("/v1/employee/tasks/claim-next?employee=小李")
        assert claimed.status_code == 200
        assert claimed.json()["task_id"] == task_id
        assert claimed.json()["assignee"] == "小李"
        assert claimed.json()["review_status"] == "in_progress"


def test_anyone_can_review_without_claiming_and_reviewer_is_recorded(tmp_path):
    """审核不用认领:没分给谁、隔天的任务大家都看得见、谁都能审;审了记下是谁。"""
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        task_id = client.post("/v1/images/search", json={"query": "AOC 24G2", "refresh": True}).json()["task_id"]
        _mark_completed(app.state.database, task_id)
        app.state.database.update_task(
            task_id, assignee="", review_status="pending", created_at="2026-08-01T00:00:00+00:00"
        )

        for who in ("小李", "小王"):
            queue = client.get(f"/v1/employee/workbench?employee={who}&date=2026-08-28").json()
            assert [t["task_id"] for t in queue["tasks"]] == [task_id]
            assert client.get(f"/v1/employee/tasks/{task_id}?employee={who}").status_code == 200

        reviewed = client.post(
            f"/v1/employee/tasks/{task_id}/review?employee=小王", json={"decision": "approved", "note": ""}
        )
        assert reviewed.status_code == 200
        assert reviewed.json()["reviewer"] == "小王" and reviewed.json()["review_status"] == "approved"
        queue = client.get("/v1/employee/workbench?employee=小李&date=2026-08-28").json()
        assert queue["tasks"] == [], "审过的旧任务不再挂在队列里"


def test_legacy_absolute_file_urls_use_current_public_base(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_poll_seconds = 10
    app = create_app(settings)
    with TestClient(app) as client:
        accepted = client.post(
            "/v1/images/search", json={"query": "AOC 24G2", "refresh": True}
        )
        task_id = accepted.json()["task_id"]
        _mark_completed(app.state.database, task_id)
        app.state.database.update_task(
            task_id,
            images_json=[
                {
                    "url": "http://127.0.0.1:8090/files/example.jpg",
                    "source_url": "https://example.com/product",
                    "source_domain": "example.com",
                    "source_type": "web",
                    "width": 640,
                    "height": 480,
                    "watermark": "none",
                    "product_confidence": 0.9,
                    "score": 0.8,
                    "provider": "official",
                }
            ],
            diagnostics_json={
                "fuzzy_previews": [{"url": "http://127.0.0.1:8090/files/fuzzy.jpg"}],
                "rejected_previews": [{"url": "/files/rejected.jpg"}],
            },
        )

        detail = client.get(f"/v1/images/tasks/{task_id}")
        assert detail.status_code == 200
        payload = detail.json()
        assert payload["images"][0]["url"] == "http://testserver/files/example.jpg"
        assert payload["diagnostics"]["fuzzy_previews"][0]["url"] == (
            "http://testserver/files/fuzzy.jpg"
        )
        assert payload["diagnostics"]["rejected_previews"][0]["url"] == (
            "/files/rejected.jpg"
        )


def test_employee_access_token_protects_public_page_and_api(tmp_path):
    settings = make_settings(tmp_path)
    settings.admin_auth_mode = "required"
    settings.employee_access_token = "DEMO_ONLY_REDACTED"
    app = create_app(settings)
    with TestClient(app) as client:
        assert client.get("/employee").status_code == 401
        opened = client.get("/employee?access_key=employee-test-token")
        assert opened.status_code == 200
        assert "employee_access=" in opened.headers["set-cookie"]
        assert client.get("/v1/employee/workbench?employee=小王").status_code == 200
        client.cookies.clear()
        assert client.get("/v1/employee/workbench?employee=小王").status_code == 401
        assert client.post("/v1/images/search", json={"query": "AOC 24G2"}).status_code == 401


def test_restart_requeues_tasks_left_processing(tmp_path):
    settings = make_settings(tmp_path)
    app = create_app(settings)
    with TestClient(app) as client:
        task_id = client.post("/v1/images/search", json={"query": "AOC 24G2", "refresh": True}).json()["task_id"]
    db = Database(settings.database_path)
    db.update_task(task_id, status="processing")
    assert db.requeue_interrupted_tasks() == 1
    assert db.get_task(task_id)["status"] == "queued"
