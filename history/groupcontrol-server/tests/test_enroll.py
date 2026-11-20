"""app HTTP 引导 enroll(POST /api/gc/enroll):按 hw_id 幂等 upsert 设备 + 密钥校验(空拒/错拒)。

直接调 endpoint 函数(仓库风格,不经 TestClient/httpx)。gc_enroll_secret 用 monkeypatch 注入。
"""
import pytest
from fastapi import HTTPException

from app import api
from app.models import Device
from app.schemas import EnrollIn

SECRET = "DEMO_ONLY_REDACTED"


def _enroll(db, hw_id="android-abc", secret=SECRET, **kw):
    return api.enroll(EnrollIn(hw_id=hw_id, enroll_secret=secret, **kw), db)


def test_enroll_creates_device_and_returns_identity(db_session, monkeypatch):
    monkeypatch.setattr(api.settings, "gc_enroll_secret", SECRET)
    out = _enroll(db_session, hw_id="android-1", brand="Xiaomi", model="M2101", app_version="1.2.3")
    # gc 签发 MQTT 身份
    assert out.device_id and out.token
    dev = db_session.get(Device, out.device_id)
    assert dev.hw_id == "android-1"
    assert dev.brand == "Xiaomi" and dev.model == "M2101" and dev.app_version == "1.2.3"
    assert dev.name == "Xiaomi M2101"          # name 由 brand+model 拼
    assert db_session.query(Device).count() == 1


def test_enroll_is_idempotent_by_hw_id(db_session, monkeypatch):
    monkeypatch.setattr(api.settings, "gc_enroll_secret", SECRET)
    a = _enroll(db_session, hw_id="android-2", model="A")
    b = _enroll(db_session, hw_id="android-2", model="B", app_version="9")
    # 同一 hw_id → 返回同一 device_id/token(幂等),不新增设备
    assert b.device_id == a.device_id
    assert b.token == a.token
    assert db_session.query(Device).count() == 1
    # 顺带更新机型/版本
    dev = db_session.get(Device, a.device_id)
    assert dev.model == "B" and dev.app_version == "9"


def test_enroll_rejects_when_secret_unconfigured(db_session, monkeypatch):
    # gc_enroll_secret 为空 → 403(未配置不放行匿名 enroll)
    monkeypatch.setattr(api.settings, "gc_enroll_secret", "")
    with pytest.raises(HTTPException) as e:
        _enroll(db_session, hw_id="android-3")
    assert e.value.status_code == 403
    assert db_session.query(Device).count() == 0


def test_enroll_rejects_wrong_secret(db_session, monkeypatch):
    monkeypatch.setattr(api.settings, "gc_enroll_secret", SECRET)
    with pytest.raises(HTTPException) as e:
        _enroll(db_session, hw_id="android-4", secret="DEMO_ONLY_REDACTED")
    assert e.value.status_code == 403
    assert db_session.query(Device).count() == 0


def test_enroll_name_falls_back_to_hw_id(db_session, monkeypatch):
    monkeypatch.setattr(api.settings, "gc_enroll_secret", SECRET)
    out = _enroll(db_session, hw_id="android-5")   # 无 brand/model
    dev = db_session.get(Device, out.device_id)
    assert dev.name == "android-5"
