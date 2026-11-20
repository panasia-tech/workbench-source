from fastapi.testclient import TestClient

from app.main import create_app

from .conftest import make_settings


def test_wallpaper_player_page_is_available_without_cache(tmp_path):
    app = create_app(make_settings(tmp_path))

    with TestClient(app) as client:
        response = client.get("/wallpaper/player")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store, max-age=0"
    assert "等待手机" in response.text
    assert "手机配对码" in response.text
    assert "录制并下载" not in response.text
    assert "<button" not in response.text
    assert "body.playing" in response.text
    assert "width: 100vw" in response.text


def test_wallpaper_remote_page_records_and_slices_on_phone(tmp_path):
    app = create_app(make_settings(tmp_path))

    with TestClient(app) as client:
        response = client.get("/wallpaper/remote")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store, max-age=0"
    assert "你好，我来帮你收好这 10 秒画面" in response.text
    assert "getUserMedia" in response.text
    assert "MediaRecorder" in response.text
    assert "captureFrame" in response.text
    assert "requestAnimationFrame" in response.text
    assert "video.currentTime" not in response.text
    assert "frame-${String(index + 1).padStart(3, '0')}.jpg" in response.text
    assert "切出 100 张图片" in response.text
    assert "手机负责取景、录像和切片" in response.text


def test_wallpaper_remote_serves_pinned_zip_encoder(tmp_path):
    app = create_app(make_settings(tmp_path))

    with TestClient(app) as client:
        response = client.get("/wallpaper/vendor/fflate.min.js")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/javascript")
    assert "zipSync" in response.text


def test_wallpaper_player_playlist_keeps_a_100_frame_contract(tmp_path):
    output_dir = tmp_path / "wallpaper" / "images"
    output_dir.mkdir(parents=True)
    for name in ("a.jpg", "b.png", "c.webp"):
        (output_dir / name).write_bytes(b"test-image")

    settings = make_settings(tmp_path)
    settings.wallpaper_output_dir = output_dir
    app = create_app(settings)

    with TestClient(app) as client:
        response = client.get("/v1/wallpaper/player/playlist")

    assert response.status_code == 200
    payload = response.json()
    assert payload["frame_count"] == 100
    assert payload["frame_interval_ms"] == 100
    assert payload["duration_ms"] == 10_000
    assert [frame["frame_index"] for frame in payload["frames"]] == list(range(1, 101))
    first_three = [frame["name"] for frame in payload["frames"][:3]]
    assert set(first_three) == {"a.jpg", "b.png", "c.webp"}
    assert payload["frames"][99]["name"] == payload["frames"][0]["name"]
    assert payload["frames"][0]["player_url"].startswith("/v1/wallpaper/player/files/")


def test_wallpaper_player_playlist_rotates_to_the_next_batch(tmp_path):
    output_dir = tmp_path / "wallpaper" / "images"
    output_dir.mkdir(parents=True)
    for index in range(205):
        (output_dir / f"frame-{index:03d}.jpg").write_bytes(b"test-image")

    settings = make_settings(tmp_path)
    settings.wallpaper_output_dir = output_dir
    app = create_app(settings)

    with TestClient(app) as client:
        first = client.get("/v1/wallpaper/player/playlist?offset=0").json()
        second = client.get(
            f"/v1/wallpaper/player/playlist?offset={first['next_offset']}"
        ).json()

    assert first["offset"] == 0
    assert first["next_offset"] == 100
    assert second["offset"] == 100
    assert second["next_offset"] == 200
    assert set(item["name"] for item in first["frames"]) != set(
        item["name"] for item in second["frames"]
    )

    with TestClient(app) as client:
        tail = client.get("/v1/wallpaper/player/playlist?offset=200").json()
    assert tail["offset"] == 200
    assert tail["next_offset"] == 0


def test_wallpaper_player_requires_employee_or_admin_access_when_remote(tmp_path):
    settings = make_settings(tmp_path)
    settings.host = "0.0.0.0"
    settings.admin_auth_mode = "required"
    settings.employee_access_token = "DEMO_ONLY_REDACTED"
    app = create_app(settings)

    with TestClient(app) as client:
        response = client.get("/wallpaper/player")

    assert response.status_code == 401


def test_wallpaper_player_session_starts_from_remote_websocket(tmp_path):
    app = create_app(make_settings(tmp_path))

    with TestClient(app) as client:
        session_response = client.post("/v1/wallpaper/player/session")
        assert session_response.status_code == 200
        pairing_code = session_response.json()["pairing_code"]
        ws_path = f"/v1/wallpaper/player/ws?code={pairing_code}"
        with client.websocket_connect(f"{ws_path}&role=display") as display:
            assert display.receive_json()["type"] == "connected"
            with client.websocket_connect(f"{ws_path}&role=remote") as remote:
                assert remote.receive_json()["type"] == "connected"
                assert display.receive_json() == {
                    "type": "peer_connected",
                    "role": "remote",
                }
                assert remote.receive_json() == {
                    "type": "peer_connected",
                    "role": "display",
                }
                remote.send_json({"type": "start_recording"})
                recording_started = remote.receive_json()
                playback_start = display.receive_json()
                assert recording_started["type"] == "recording_started"
                assert playback_start["type"] == "start_playback"
                assert playback_start["start_at_ms"] == recording_started["start_at_ms"]
                display.send_json({"type": "display_done"})
                assert remote.receive_json() == {"type": "playback_done"}
