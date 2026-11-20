"""MCP 接入信息路由(/api/config/mcp-info):匿名 401、非 ADMIN 403、ADMIN 可见 key。"""
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.database import get_db
from app.deps import create_access_token
from app.enums import StaffRole, StaffStatus
from app.main import app
from app.models import Staff


@pytest.fixture()
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _auth(db, role, username):
    staff = Staff(staff_no=f"no-{username}", username=username, password_hash="x",
                  name=username, role=role, status=StaffStatus.ACTIVE)
    db.add(staff)
    db.commit()
    return {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


def test_mcp_info_401_when_anonymous(client):
    assert client.get("/api/config/mcp-info").status_code == 401


def test_mcp_info_403_when_not_admin(client, db_session):
    headers = _auth(db_session, StaffRole.SALES, "sales1")
    assert client.get("/api/config/mcp-info", headers=headers).status_code == 403


def test_mcp_info_admin_sees_key(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "mcp_enabled", True)
    monkeypatch.setattr(settings, "mcp_api_key", "test-mcp-key")
    headers = _auth(db_session, StaffRole.ADMIN, "admin1")
    data = client.get("/api/config/mcp-info", headers=headers).json()
    assert data["enabled"] is True
    assert data["url"] == "http://127.0.0.1:8000"
    assert data["key"] == "test-mcp-key"


def test_mcp_info_disabled_when_not_configured(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "mcp_enabled", False)
    monkeypatch.setattr(settings, "mcp_api_key", "")
    headers = _auth(db_session, StaffRole.ADMIN, "admin2")
    data = client.get("/api/config/mcp-info", headers=headers).json()
    assert data["enabled"] is False and data["key"] == ""
