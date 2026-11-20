from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db as dbmod
from app import main
from app.config import get_settings


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MEDIA_BASE_URL", "http://testserver")
    monkeypatch.setenv("MEDIA_DATABASE_URL", f"sqlite:///{tmp_path / 'media.db'}")
    monkeypatch.setenv("MEDIA_SESSION_SECRET", "test-secret")
    monkeypatch.setenv("MEDIA_STORAGE", "local")
    monkeypatch.setenv("MEDIA_LOCAL_ROOT", str(tmp_path / "storage"))
    monkeypatch.setenv("MEDIA_DEV_LOGIN", "true")
    monkeypatch.setenv("MEDIA_OIDC_ISSUER", "")
    for f in (get_settings, dbmod.get_engine, dbmod.get_sessionmaker):
        f.cache_clear()
    main._storage = None
    yield tmp_path
    for f in (get_settings, dbmod.get_engine, dbmod.get_sessionmaker):
        f.cache_clear()
    main._storage = None


@pytest.fixture
def client(env):
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def db(client):
    s = dbmod.get_sessionmaker()()
    yield s
    s.close()


@pytest.fixture
def storage(client):
    return main.get_storage()


@pytest.fixture
def video(env) -> Path:
    p = env / "lesson.mp4"
    p.write_bytes(b"\x00\x00\x00\x18ftypmp42" + bytes(range(256)) * 64)
    return p


def login(client: TestClient, role: str = "staff", staff_id: str = "E001") -> None:
    client.cookies.clear()
    r = client.get("/auth/dev-login", params={"role": role, "staff_id": staff_id}, follow_redirects=False)
    assert r.status_code == 303
