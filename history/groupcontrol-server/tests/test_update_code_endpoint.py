"""update-code 端点:远程给工位执行端下发「下载新代码并重启」(2026-10-10)。

端侧收到 cmd 后尽力下载热更包再退出进程,由 manage.py supervisor 拉起换新;
老执行端(无热更加载器)忽略该指令,任务停在 DISPATCHED——仍需重装 exe。
这里钉服务端三件事:设备不存在 404、下发成功置 DISPATCHED(帧格式正确)、
桥未就绪 502。访问守卫在 test_api_access_guard 的 ERP_ONLY 里统一钉。
"""
import asyncio

import pytest
from fastapi import HTTPException

import app.api as api
from app.models import Device, TaskStatus


class _FakeBridge:
    def __init__(self, exc=None):
        self.exc = exc
        self.frames = []

    async def publish_cmd(self, device_id, frame):
        if self.exc:
            raise self.exc
        self.frames.append((device_id, frame))


def _seed(db):
    db.add(Device(id="dev-u1", name="浏览器号", token="t", hw_id="k1env9", kind="browser"))
    db.commit()


def test_update_code_404_when_device_missing(db_session, monkeypatch):
    monkeypatch.setattr(api, "bridge", _FakeBridge())
    with pytest.raises(HTTPException) as e:
        asyncio.run(api.update_device_code("no-such-device", db_session))
    assert e.value.status_code == 404


def test_update_code_dispatch_success(db_session, monkeypatch):
    _seed(db_session)
    bridge = _FakeBridge()
    monkeypatch.setattr(api, "bridge", bridge)
    task = asyncio.run(api.update_device_code("dev-u1", db_session))
    assert task.task_type == "update_code" and task.source == "MANUAL"
    assert task.status == TaskStatus.DISPATCHED and task.dispatched_at is not None
    [(device_id, frame)] = bridge.frames
    assert device_id == "dev-u1"
    assert frame == {"task_id": task.id, "task_type": "update_code", "payload": {}}


def test_update_code_502_when_bridge_down(db_session, monkeypatch):
    _seed(db_session)
    monkeypatch.setattr(api, "bridge", _FakeBridge(exc=RuntimeError("mqtt bridge not ready")))
    with pytest.raises(HTTPException) as e:
        asyncio.run(api.update_device_code("dev-u1", db_session))
    assert e.value.status_code == 502
    # 任务留着(同 restart 语义),端侧没收到;人工可重试
    assert e.value.detail.startswith("update-code 下发失败")
