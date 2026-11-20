"""群控运维代理路由(/api/gc-ops):鉴权、token 过滤、任务分页 join、重试。

HTTP 层用 TestClient 跑真实鉴权(401/403);gc client 全 monkeypatch(不连真 gc)。
get_db 覆盖成内存 SQLite(与 db_session 同夹具)。
"""
import httpx
import pytest
from fastapi.testclient import TestClient

import app.routers.gc_ops as G
from app.database import get_db
from app.deps import create_access_token
from app.enums import StaffRole, StaffStatus
from app.main import app
from app.models import Staff

_DEVICES = [
    {"id": "dev1", "name": "红米A", "status": "ONLINE", "kind": "browser", "brand": "Xiaomi", "model": "M1",
     "serial": "SN1", "reported_nick": "闲鱼A", "account_id": "acc-a", "token": "SECRET-TOKEN",
     "last_ready": True, "blocking": False, "busy_task_id": None, "app_version": "1.2.3",
     "last_heartbeat_at": "2026-09-01T10:00:00", "last_online_at": "2026-09-01T09:00:00",
     "last_event": "heartbeat", "last_exit_reason": None},
    {"id": "dev2", "name": "红米B", "status": "OFFLINE", "account_id": None, "token": "T2",
     "last_ready": False, "blocking": True},
]
_ACCOUNTS = [
    {"id": "acc-a", "nick": "闲鱼A", "device_id": "dev1"},
    {"id": "acc-b", "nick": "闲鱼B", "device_id": None},
]
_TASK = {"id": "task-1", "job_id": "job-1", "device_id": "dev1", "account_id": "acc-a",
         "task_type": "publish", "status": "FAILED", "spec": {"sku": "SK1"},
         "result": None, "progress": 50, "mark": None, "error": "超时",
         "failed_step": "publish", "shot_key": None,
         "created_at": "2026-09-01T10:00:00", "dispatched_at": "2026-09-01T10:01:00",
         "finished_at": "2026-09-01T10:05:00"}


def _seed_staff(db, role, username):
    staff = Staff(staff_no=f"no-{username}", username=username, password_hash="x",
                  name=username, role=role, status=StaffStatus.ACTIVE)
    db.add(staff)
    db.commit()
    return staff


def _auth(db, role, username):
    staff = _seed_staff(db, role, username)
    return {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


@pytest.fixture()
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _mock_gc(monkeypatch, *, devices=None, accounts=None, tasks=None, total=None):
    async def list_devices():
        return devices if devices is not None else _DEVICES

    async def list_accounts():
        return accounts if accounts is not None else _ACCOUNTS

    async def list_tasks_paged(device_id=None, status=None, exclude_type=None, page=1, page_size=50):
        items = tasks if tasks is not None else [_TASK]
        return {"items": items, "total": total if total is not None else len(items)}

    monkeypatch.setattr(G.gc, "list_devices", list_devices)
    monkeypatch.setattr(G.gc, "list_accounts", list_accounts)
    monkeypatch.setattr(G.gc, "list_tasks_paged", list_tasks_paged)


# ==================== 鉴权 ====================


def test_devices_401_when_anonymous(client):
    assert client.get("/api/gc-ops/devices").status_code == 401


def test_devices_403_when_role_not_allowed(client, db_session, monkeypatch):
    _mock_gc(monkeypatch)
    # NEGOTIATOR 不在查看四角色里
    headers = _auth(db_session, StaffRole.NEGOTIATOR, "nego")
    assert client.get("/api/gc-ops/devices", headers=headers).status_code == 403


def test_admin_only_ops_reject_non_admin(client, db_session, monkeypatch):
    _mock_gc(monkeypatch)
    # WAREHOUSE 能看,但不能重启(操作类仅 ADMIN)
    headers = _auth(db_session, StaffRole.WAREHOUSE, "wh")
    assert client.get("/api/gc-ops/devices", headers=headers).status_code == 200
    assert client.post("/api/gc-ops/devices/dev1/restart", headers=headers).status_code == 403
    assert client.patch("/api/gc-ops/devices/dev1", json={"name": "x"}, headers=headers).status_code == 403
    assert client.post("/api/gc-ops/tasks/task-1/retry", headers=headers).status_code == 403


# ==================== 设备看板 ====================


def test_devices_never_leak_token(client, db_session, monkeypatch):
    _mock_gc(monkeypatch)
    headers = _auth(db_session, StaffRole.ADMIN, "admin1")
    resp = client.get("/api/gc-ops/devices", headers=headers)
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 2
    # 安全红线:token 绝不下发
    for row in rows:
        assert "token" not in row
    a, b = rows
    assert a["id"] == "dev1" and a["account_nick"] == "闲鱼A" and a["last_ready"] is True
    assert a["app_version"] == "1.2.3" and a["serial"] == "SN1"
    # kind 透传:browser(AdsPower 浏览器环境)如实下发;缺省回退 android
    assert a["kind"] == "browser" and b["kind"] == "android"
    # dev2 没绑账号 → account_nick None
    assert b["id"] == "dev2" and b["account_nick"] is None and b["blocking"] is True


def test_devices_502_when_gc_down(client, db_session, monkeypatch):
    async def boom():
        raise ConnectionError("refused")

    monkeypatch.setattr(G.gc, "list_devices", boom)
    monkeypatch.setattr(G.gc, "list_accounts", boom)
    headers = _auth(db_session, StaffRole.ADMIN, "admin2")
    assert client.get("/api/gc-ops/devices", headers=headers).status_code == 502


# ==================== 任务看板 ====================


def test_tasks_paged_with_join(client, db_session, monkeypatch):
    seen = {}

    async def list_tasks_paged(device_id=None, status=None, exclude_type=None, page=1, page_size=50):
        seen.update(device_id=device_id, status=status, exclude_type=exclude_type,
                    page=page, page_size=page_size)
        return {"items": [dict(_TASK)], "total": 7}

    _mock_gc(monkeypatch, tasks=[])
    monkeypatch.setattr(G.gc, "list_tasks_paged", list_tasks_paged)
    headers = _auth(db_session, StaffRole.SALES, "sales")
    resp = client.get("/api/gc-ops/tasks?device_id=dev1&status=FAILED&page=2&page_size=20",
                      headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 7 and len(data["items"]) == 1
    t = data["items"][0]
    assert t["id"] == "task-1" and t["device_name"] == "红米A" and t["account_nick"] == "闲鱼A"
    assert t["failed_step"] == "publish" and t["error"] == "超时"
    # chat_scan / keepalive 常驻背景任务固定排除(见路由 docstring)
    assert seen == {"device_id": "dev1", "status": "FAILED", "exclude_type": "chat_scan,keepalive",
                    "page": 2, "page_size": 20}


def test_tasks_page_size_capped(client, db_session, monkeypatch):
    _mock_gc(monkeypatch)
    headers = _auth(db_session, StaffRole.ADMIN, "admin3")
    # page_size 上限 100
    assert client.get("/api/gc-ops/tasks?page_size=101", headers=headers).status_code == 422


def test_task_detail_with_join(client, db_session, monkeypatch):
    _mock_gc(monkeypatch)

    async def get_task(task_id):
        assert task_id == "task-1"
        return dict(_TASK)

    monkeypatch.setattr(G.gc, "get_task", get_task)
    headers = _auth(db_session, StaffRole.PURCHASER, "pur")
    resp = client.get("/api/gc-ops/tasks/task-1", headers=headers)
    assert resp.status_code == 200
    t = resp.json()
    assert t["id"] == "task-1" and t["device_name"] == "红米A" and t["account_nick"] == "闲鱼A"


def test_task_detail_404_passthrough(client, db_session, monkeypatch):
    async def get_task(task_id):
        req = httpx.Request("GET", f"http://gc/api/gc/tasks/{task_id}")
        raise httpx.HTTPStatusError("404", request=req,
                                    response=httpx.Response(404, json={"detail": "任务不存在"},
                                                            request=req))

    monkeypatch.setattr(G.gc, "get_task", get_task)
    headers = _auth(db_session, StaffRole.ADMIN, "admin4")
    resp = client.get("/api/gc-ops/tasks/nope", headers=headers)
    assert resp.status_code == 404 and resp.json()["detail"] == "任务不存在"


_REPLAY = {
    "task_id": "task-1", "status": "RUNNING", "live": True, "note": None,
    "steps": [
        {"seq": 1, "at": 0.4, "action": "launch_app", "args": "https://www.goofish.com/publish", "ms": 1183,
         "error": None, "shot_url": "https://bkt/1.png?Signature=s", "thumb_url": "https://bkt/1.png?t",
         "shot_error": None, "debug_extra": "不该透出"},
    ],
    "result_shot_url": None, "result_thumb_url": None, "internal": "不该透出",
}


def test_task_trace_passthrough(client, db_session, monkeypatch):
    async def get_task_trace(task_id):
        assert task_id == "task-1"
        return dict(_REPLAY)

    monkeypatch.setattr(G.gc, "get_task_trace", get_task_trace)
    assert client.get("/api/gc-ops/tasks/task-1/trace").status_code == 401
    headers = _auth(db_session, StaffRole.ADMIN, "admin-replay")
    resp = client.get("/api/gc-ops/tasks/task-1/trace", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["live"] is True and data["steps"][0]["action"] == "launch_app"
    assert data["steps"][0]["shot_url"].startswith("https://")
    assert "internal" not in data and "debug_extra" not in data["steps"][0], "逐字段挑拣,gc 多给的不往前端透"


def test_task_trace_404_passthrough(client, db_session, monkeypatch):
    async def get_task_trace(task_id):
        req = httpx.Request("GET", f"http://gc/api/gc/tasks/{task_id}/trace")
        raise httpx.HTTPStatusError("404", request=req,
                                    response=httpx.Response(404, json={"detail": "任务不存在"}, request=req))

    monkeypatch.setattr(G.gc, "get_task_trace", get_task_trace)
    headers = _auth(db_session, StaffRole.ADMIN, "admin-replay-404")
    resp = client.get("/api/gc-ops/tasks/nope/trace", headers=headers)
    assert resp.status_code == 404 and resp.json()["detail"] == "任务不存在"


# ==================== 操作类 ====================


def test_restart_device(client, db_session, monkeypatch):
    async def restart_device(device_id):
        return {"id": "task-r", "device_id": device_id, "task_type": "restart", "status": "PENDING"}

    monkeypatch.setattr(G.gc, "restart_device", restart_device)
    headers = _auth(db_session, StaffRole.ADMIN, "admin5")
    resp = client.post("/api/gc-ops/devices/dev1/restart", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "task_id": "task-r", "device_id": "dev1",
                           "task_type": "restart", "status": "PENDING"}


def test_update_device_status_validation(client, db_session, monkeypatch):
    seen = {}

    async def update_device(device_id, fields):
        seen.update(fields)
        return dict(_DEVICES[0], **fields)

    monkeypatch.setattr(G.gc, "update_device", update_device)

    async def get_account(aid):
        return {"id": aid, "nick": "闲鱼A", "device_id": "dev1"}

    monkeypatch.setattr(G.gc, "get_account", get_account)
    headers = _auth(db_session, StaffRole.ADMIN, "admin6")
    # OFFLINE 不允许人工设 → 400
    assert client.patch("/api/gc-ops/devices/dev1", json={"status": "OFFLINE"},
                        headers=headers).status_code == 400
    # 空 body → 400
    assert client.patch("/api/gc-ops/devices/dev1", json={}, headers=headers).status_code == 400
    resp = client.patch("/api/gc-ops/devices/dev1", json={"status": "disabled", "note": "坏了"},
                        headers=headers)
    assert resp.status_code == 200
    # status 归一化大写后代理给 gc
    assert seen == {"status": "DISABLED", "note": "坏了"}
    row = resp.json()
    assert row["id"] == "dev1" and row["account_nick"] == "闲鱼A" and "token" not in row


def test_retry_task_rebuilds_from_original(client, db_session, monkeypatch):
    seen = {}

    async def get_task(task_id):
        assert task_id == "task-1"
        return dict(_TASK)

    async def create_task(payload):
        seen.update(payload)
        return {"id": "task-2", "device_id": payload["device_id"],
                "task_type": payload["task_type"], "status": "PENDING"}

    monkeypatch.setattr(G.gc, "get_task", get_task)
    monkeypatch.setattr(G.gc, "create_task", create_task)
    headers = _auth(db_session, StaffRole.ADMIN, "admin7")
    resp = client.post("/api/gc-ops/tasks/task-1/retry", headers=headers)
    assert resp.status_code == 200
    # 用原任务的 device_id/account_id/task_type/spec 建新任务,source=MANUAL
    assert seen == {"device_id": "dev1", "account_id": "acc-a",
                    "task_type": "publish", "spec": {"sku": "SK1"}, "source": "MANUAL"}
    data = resp.json()
    assert data["ok"] is True and data["task_id"] == "task-2" and data["retry_of"] == "task-1"


def test_retry_task_404_when_original_gone(client, db_session, monkeypatch):
    async def get_task(task_id):
        req = httpx.Request("GET", f"http://gc/api/gc/tasks/{task_id}")
        raise httpx.HTTPStatusError("404", request=req,
                                    response=httpx.Response(404, json={"detail": "任务不存在"},
                                                            request=req))

    monkeypatch.setattr(G.gc, "get_task", get_task)
    headers = _auth(db_session, StaffRole.ADMIN, "admin8")
    resp = client.post("/api/gc-ops/tasks/gone/retry", headers=headers)
    assert resp.status_code == 404
