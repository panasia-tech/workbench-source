from fastapi.testclient import TestClient

from app.main import create_app

from .conftest import make_settings


def test_wallpaper_page_is_served_as_no_store_h5_ui(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        response = client.get("/wallpaper")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store, max-age=0"
    assert "viewport-fit=cover" in response.text
    assert "data-view-target=\"overview\"" in response.text
    assert "成人标记直接跳过" in response.text
    assert "只保留图片" in response.text
    assert "演示运行中" not in response.text
    assert "视频首帧" not in response.text


def test_wallpaper_control_endpoints_read_external_output(tmp_path, monkeypatch):
    monkeypatch.setenv("STEAM_API_KEY", "test-key")
    output_dir = tmp_path / "wallpaper" / "images"
    output_dir.mkdir(parents=True)
    image_path = output_dir / "sample.jpg"
    image_path.write_bytes(b"test-image")

    settings = make_settings(tmp_path)
    settings.wallpaper_root = output_dir.parent
    settings.wallpaper_output_dir = output_dir
    settings.wallpaper_runner_script = tmp_path / "runner.py"
    settings.wallpaper_runner_script.write_text("# test runner\n", encoding="utf-8")
    app = create_app(settings)

    with TestClient(app) as client:
        status = client.get("/v1/wallpaper/status")
        images = client.get("/v1/wallpaper/images", params={"query": "sample"})
        file_response = client.get("/v1/wallpaper/files/sample.jpg")

    assert status.status_code == 200
    payload = status.json()
    assert payload["status"] == "ready"
    assert payload["output_dir"] == str(output_dir)
    assert payload["images"]["count"] == 1
    assert payload["policy"]["skip_video"] is True

    assert images.status_code == 200
    assert images.json()["total"] == 1
    assert images.json()["items"][0]["name"] == "sample.jpg"
    assert images.json()["items"][0]["url"] == "/v1/wallpaper/files/sample.jpg"

    assert file_response.status_code == 200
    assert file_response.content == b"test-image"
