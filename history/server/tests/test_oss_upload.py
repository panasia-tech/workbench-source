"""客户端上传的对象名:同一毫秒传的不同图不能同名(10-15 一台显示器上架 4 张图只剩 2 张)。"""
import hashlib

import pytest
from fastapi.testclient import TestClient

from app.database import get_db
from app.deps import create_access_token
from app.enums import StaffRole, StaffStatus
from app.main import app
from app.models import Staff
from app.services import oss

_MS = 1792028586314  # 2026-10-15 09:43:06.314,那次撞名的毫秒


@pytest.fixture()
def frozen_ms(monkeypatch):
    monkeypatch.setattr(oss.time, "time_ns", lambda: _MS * 1_000_000)


def test_same_ms_different_content_gets_different_names(frozen_ms):
    a = oss.upload_filename(f"{_MS}.jpg", b"back-label")
    b = oss.upload_filename(f"{_MS}.jpg", b"settings-screenshot")
    assert a != b
    assert a == "mv8vjuq2" + hashlib.md5(b"back-label").hexdigest()[:8] + ".jpg"
    assert int(a[:8], 36) == _MS


def test_keeps_client_extension_and_stays_short(frozen_ms):
    assert oss.upload_filename(f"{_MS}.mp4", b"v").endswith(".mp4")
    assert oss.upload_filename(f"{_MS}_3.jpg", b"x").endswith(".jpg")
    assert oss.upload_filename("", b"x").endswith(".jpg")
    assert oss.upload_filename("noext", b"x").endswith(".jpg")
    assert len(oss.upload_filename("a.jpg", b"x")) == 16 + len(".jpg")


class _FakeBucket:
    endpoint = "https://oss-cn-shanghai.aliyuncs.com"

    def __init__(self):
        self.objects = {}

    def put_object(self, key, content, headers=None):
        self.objects[key] = content

    def sign_url(self, method, key, expires):
        return f"https://signed.example/{key}"


@pytest.fixture()
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_upload_route_same_client_filename_lands_on_two_objects(client, db_session, monkeypatch, frozen_ms):
    """小程序一次多选:几张图带着同一个 Date.now() 文件名进来,要落到不同对象上、谁也不盖谁。"""
    bucket = _FakeBucket()
    monkeypatch.setattr(oss, "get_oss_bucket", lambda: bucket)
    monkeypatch.setattr(oss.settings, "oss_public_base", "https://cdn.example")
    staff = Staff(staff_no="no-up", username="up", password_hash="x", name="up",
                  role=StaffRole.WAREHOUSE, status=StaffStatus.ACTIVE)
    db_session.add(staff)
    db_session.commit()
    headers = {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}

    keys = []
    for body in (b"photo-1", b"photo-2"):
        r = client.post("/api/oss/upload", headers=headers,
                        data={"dir": "inspection/listing/", "filename": f"{_MS}.jpg"},
                        files={"file": ("tmp.jpg", body, "image/jpeg")})
        assert r.status_code == 200, r.text
        keys.append(r.json()["object_key"])

    assert keys[0] != keys[1]
    assert all(k.startswith("inspection/listing/mv8vjuq2") for k in keys)
    assert bucket.objects[keys[0]] == b"photo-1"
    assert bucket.objects[keys[1]] == b"photo-2"
