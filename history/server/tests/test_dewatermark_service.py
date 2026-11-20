"""京东云去水印补图服务(dewatermark_service/main.py):令牌、回包格式、没装好时 503。

镜像里 dewatermark.py 是 ERP 那份原样拷过去的,这里直接让 import dewatermark 指到 ERP 的模块。
"""
import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services import dewatermark as dw


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setitem(sys.modules, "dewatermark", dw)
    monkeypatch.setenv("DEWATERMARK_TOKEN", "tok")
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "dewatermark_service"))
    sys.modules.pop("main", None)
    main = importlib.import_module("main")
    yield TestClient(main.app)
    sys.modules.pop("main", None)


AUTH = {"Authorization": "Bearer tok"}


def test_token_required(client):
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/process", content=b"x").status_code == 401
    assert client.get("/livez").status_code == 200


def test_health_reports_why(client, monkeypatch):
    monkeypatch.setattr(dw, "available", lambda: (False, "去水印模型没放:/models/lama_fp32.onnx"))
    r = client.get("/health", headers=AUTH)
    assert r.json() == {"available": False, "reason": "去水印模型没放:/models/lama_fp32.onnx"}


def test_process_returns_wire(client, monkeypatch):
    got = {}

    def fake(content):
        got["content"] = content
        return dw.Result(dw.DONE, regions=[dw.Region("logo", [1, 2, 3, 4], 0.9)], image=b"\xff\xd8clean",
                         width=10, height=20)

    monkeypatch.setattr(dw, "process", fake)
    r = client.post("/process", content=b"\xff\xd8raw", headers=AUTH)
    assert r.status_code == 200 and got["content"] == b"\xff\xd8raw"
    back = dw.from_wire(r.json())
    assert back.status == dw.DONE and back.image == b"\xff\xd8clean" and back.regions[0].box == [1, 2, 3, 4]


def test_process_unavailable_is_503(client, monkeypatch):
    def boom(content):
        raise dw.DewatermarkUnavailable("服务器没装 onnxruntime")

    monkeypatch.setattr(dw, "process", boom)
    r = client.post("/process", content=b"\xff\xd8raw", headers=AUTH)
    assert r.status_code == 503 and "onnxruntime" in r.json()["detail"]
    assert client.post("/process", content=b"", headers=AUTH).status_code == 400
