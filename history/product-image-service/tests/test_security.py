from __future__ import annotations

import httpx
import pytest

from app.db import Database
from app.pipeline import ImageService
from app.ssrf import SSRFBlocked, validate_public_url

from .conftest import make_settings


def test_ssrf_blocks_loopback_and_private_addresses(monkeypatch):
    monkeypatch.setattr(
        "app.ssrf.socket.getaddrinfo",
        lambda *args, **kwargs: [(0, 0, 0, "", ("127.0.0.1", 443))],
    )
    with pytest.raises(SSRFBlocked):
        validate_public_url("https://example.com/image.jpg")


def test_synthetic_dns_is_explicitly_opt_in(monkeypatch):
    monkeypatch.setattr(
        "app.ssrf.socket.getaddrinfo",
        lambda *args, **kwargs: [(0, 0, 0, "", ("198.18.0.1", 443))],
    )
    with pytest.raises(SSRFBlocked):
        validate_public_url("https://example.com/image.jpg")
    validate_public_url("https://example.com/image.jpg", allow_synthetic_dns=True)


@pytest.mark.asyncio
async def test_streaming_download_enforces_byte_limit(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    settings.max_image_bytes = 1024
    settings.allow_synthetic_dns = True
    database = Database(settings.database_path)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "image/jpeg"},
            content=b"\xff\xd8" + (b"x" * 2048),
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ImageService(settings, database, client)
    monkeypatch.setattr("app.pipeline.validate_public_url", lambda *args: None)
    with pytest.raises(ValueError, match="byte limit"):
        await service.download_image("https://example.com/image.jpg")
    await client.aclose()


@pytest.mark.asyncio
async def test_webhook_retries_after_failure(tmp_path):
    settings = make_settings(tmp_path)
    settings.result_webhook_url = "https://webhook.example/hook"
    settings.webhook_max_retries = 1
    database = Database(settings.database_path)
    task_id = "img_webhook-test"
    database.create_task(task_id, "sonos era300")
    database.update_task(task_id, status="completed", images_json=[])
    attempts = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(500 if attempts == 1 else 200)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ImageService(settings, database, client)
    await service.push_webhook(task_id)
    await client.aclose()
    assert attempts == 2
