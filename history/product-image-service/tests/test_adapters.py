from __future__ import annotations

import httpx

from app.adapters import AdapterRegistry, ProviderAdapter, platform_for_candidate
from app.models import Candidate, ProductIdentity, ProviderState
from app.providers.base import Health, Provider


class FakeProvider(Provider):
    name = "fake_search"
    source_type = "search"

    async def search(self, product: ProductIdentity, queries: list[str]) -> list[Candidate]:
        return [
            self.candidate(
                image_url="https://i.ytimg.com/vi/demo/maxresdefault.jpg",
                page_url="https://www.youtube.com/watch?v=demo",
                title=product.model,
            )
        ]

    async def fetch(self, candidate: Candidate) -> bytes:
        return b"image"

    async def healthcheck(self) -> Health:
        return Health(ProviderState.healthy, "fake provider ready")


class FlakyProvider(FakeProvider):
    name = "flaky_search"

    def __init__(self, client, failures: int):
        super().__init__(client)
        self.failures = failures
        self.search_calls = 0

    async def search(self, product: ProductIdentity, queries: list[str]) -> list[Candidate]:
        self.search_calls += 1
        if self.search_calls <= self.failures:
            raise httpx.PoolTimeout("temporary pool exhaustion")
        return await super().search(product, queries)


class FakeProviderRegistry:
    def __init__(self, provider: Provider):
        self.provider = provider

    def enabled(self) -> list[Provider]:
        return [self.provider]


async def test_provider_adapter_assigns_platform_and_media_origin():
    client = httpx.AsyncClient()
    adapter = ProviderAdapter(FakeProvider(client))
    results = await adapter.search(
        ProductIdentity(original_query="AOC 24G2", brand="AOC", model="24G2"),
        ["AOC 24G2"],
    )
    await client.aclose()
    assert results[0].platform == "youtube"
    assert results[0].media_origin == "public_search"
    assert platform_for_candidate(results[0]) == "youtube"


async def test_adapter_registry_retries_transient_pool_timeout():
    client = httpx.AsyncClient()
    provider = FlakyProvider(client, failures=1)
    registry = AdapterRegistry(
        FakeProviderRegistry(provider), max_retries=2, retry_backoff_seconds=0
    )
    runs = await registry.run_all(
        ProductIdentity(original_query="AOC 24G2", brand="AOC", model="24G2"),
        ["AOC 24G2"],
    )
    await client.aclose()
    assert provider.search_calls == 2
    assert runs[0].state == ProviderState.healthy
    assert runs[0].retry_count == 1
    assert "已重试 1 次" in runs[0].message
    assert runs[0].candidates


async def test_adapter_registry_marks_exhausted_transient_failure_degraded():
    client = httpx.AsyncClient()
    provider = FlakyProvider(client, failures=5)
    registry = AdapterRegistry(
        FakeProviderRegistry(provider), max_retries=1, retry_backoff_seconds=0
    )
    runs = await registry.run_all(
        ProductIdentity(original_query="AOC 24G2", brand="AOC", model="24G2"),
        ["AOC 24G2"],
    )
    await client.aclose()
    assert provider.search_calls == 2
    assert runs[0].state == ProviderState.degraded
    assert runs[0].retry_count == 1
    assert "PoolTimeout" in runs[0].message
    assert "已重试 1 次" in runs[0].message
    assert runs[0].candidates == []
