from __future__ import annotations

import json
from html import escape

import httpx

from app.models import ProductIdentity
from app.providers.bing import BingPublicImagesProvider


async def test_bing_public_provider_maps_image_metadata():
    payload = {
        "murl": "https://cdn.example.com/era300.jpg",
        "purl": "https://www.sonos.com/en-us/shop/era-300",
        "t": "Sonos Era 300 product image",
        "expw": 1200,
        "exph": 800,
    }
    body = f"<a class='iusc' m='{escape(json.dumps(payload), quote=True)}'></a>"

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/html"}, text=body)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = BingPublicImagesProvider(client)
    results = await provider.search(
        ProductIdentity(original_query="Sonos era300", brand="Sonos", model="era300"),
        ["Sonos era300"],
    )
    await client.aclose()
    assert len(results) == 1
    assert results[0].source_domain == "sonos.com"
    assert results[0].width == 1200


async def test_bing_public_provider_reads_a_second_result_page():
    first_payload = {
        "murl": "https://cdn.example.com/era300-first.jpg",
        "purl": "https://www.sonos.com/en-us/shop/era-300",
        "t": "Sonos Era 300 first page",
        "expw": 1200,
        "exph": 800,
    }
    second_payload = {
        "murl": "https://cdn.example.com/era300-second.jpg",
        "purl": "https://www.sonos.com/en-us/shop/era-300/gallery",
        "t": "Sonos Era 300 second page",
        "expw": 1600,
        "exph": 1000,
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = second_payload if request.url.params.get("first") == "35" else first_payload
        body = f"<a class='iusc' m='{escape(json.dumps(payload), quote=True)}'></a>"
        return httpx.Response(200, headers={"content-type": "text/html"}, text=body)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = BingPublicImagesProvider(client, pages_per_query=2)
    results = await provider.search(
        ProductIdentity(original_query="Sonos era300", brand="Sonos", model="era300"),
        ["Sonos era300"],
    )
    await client.aclose()

    assert len(results) == 2
    assert results[1].media_origin == "search_pagination"
    assert results[1].search_page == 2
    assert results[1].height == 1000


async def test_bing_public_provider_skips_site_queries_on_cn_bing():
    seen: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params["q"])
        return httpx.Response(200, headers={"content-type": "text/html"}, text="")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = BingPublicImagesProvider(client, endpoint="https://cn.bing.com/images/search")
    await provider.search(
        ProductIdentity(original_query="Sonos era300", brand="Sonos", model="era300"),
        ["site:reddit.com Sonos era300", "Sonos era300", "SITE:smzdm.com Sonos era300"],
    )
    await client.aclose()
    assert seen == ["Sonos era300"]
