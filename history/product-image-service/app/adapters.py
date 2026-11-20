from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Protocol

import httpx

from .models import Candidate, ProductIdentity, ProviderState
from .parser import domain_of
from .providers.base import Health, Provider
from .providers.registry import ProviderRegistry

# This is deliberately a small, stable vocabulary. New platforms can be added
# here without changing the task pipeline; unknown domains stay as web_search.
PLATFORM_HOST_HINTS: dict[str, tuple[str, ...]] = {
    "amazon": ("amazon.", "amzn."),
    "taobao": ("taobao.com",),
    "tmall": ("tmall.com",),
    "jd": ("jd.com", "360buyimg.com"),
    "pinduoduo": ("pinduoduo.com", "yangkeduo.com"),
    "walmart": ("walmart.com",),
    "shopee": ("shopee.",),
    "ebay": ("ebay.",),
    "aliexpress": ("aliexpress.com",),
    "temu": ("temu.com",),
    "mercado_libre": ("mercadolibre.", "mercadolivre."),
    "etsy": ("etsy.com",),
    "rakuten": ("rakuten.",),
    "coupang": ("coupang.com",),
    "flipkart": ("flipkart.com",),
    "ozon": ("ozon.",),
    "shein": ("shein.com",),
    "lazada": ("lazada.",),
    "kuaishou": ("kuaishou.com", "kwai.com"),
    "allegro": ("allegro.",),
    "douyin_shop": ("douyin.com", "抖音"),
    "xianyu": ("goofish.com", "xianyu.com"),
    "mercari": ("mercari.com",),
    "facebook_marketplace": ("facebook.com",),
    "depop_poshmark": ("depop.com", "poshmark.com"),
    "vinted": ("vinted.",),
    "reddit": ("reddit.com",),
    "youtube": ("youtube.com", "youtu.be"),
}


def platform_for_candidate(candidate: Candidate) -> str:
    if candidate.platform:
        return candidate.platform
    host = (
        candidate.source_domain or domain_of(candidate.page_url) or domain_of(candidate.image_url)
    ).lower()
    for platform, hints in PLATFORM_HOST_HINTS.items():
        if any(hint in host for hint in hints):
            return platform
    return "web_search"


class ImageAdapter(Protocol):
    """Stable execution contract for every source worker."""

    name: str

    async def search(self, product: ProductIdentity, queries: list[str]) -> list[Candidate]: ...

    async def fetch(self, candidate: Candidate) -> bytes: ...

    async def healthcheck(self) -> Health: ...


class ProviderAdapter:
    """Adapts the existing HTTP providers to the platform worker contract."""

    def __init__(self, provider: Provider):
        self.provider = provider
        self.name = provider.name

    async def search(self, product: ProductIdentity, queries: list[str]) -> list[Candidate]:
        candidates = await self.provider.search(product, queries)
        for candidate in candidates:
            candidate.platform = platform_for_candidate(candidate)
            if candidate.media_origin == "unknown":
                candidate.media_origin = (
                    "official_page" if self.provider.name == "official" else "public_search"
                )
        return candidates

    async def fetch(self, candidate: Candidate) -> bytes:
        return await self.provider.fetch(candidate)

    async def healthcheck(self) -> Health:
        return await self.provider.healthcheck()


@dataclass
class AdapterRun:
    name: str
    state: ProviderState
    message: str
    candidates: list[Candidate]
    retry_count: int = 0


class AdapterRegistry:
    """Run source adapters with a shared concurrency ceiling and status shape."""

    def __init__(
        self,
        providers: ProviderRegistry,
        *,
        max_retries: int = 2,
        retry_backoff_seconds: float = 0.5,
    ):
        self.adapters: list[ImageAdapter] = [
            ProviderAdapter(provider) for provider in providers.enabled()
        ]
        self.max_retries = max(0, min(int(max_retries), 3))
        self.retry_backoff_seconds = max(0.0, min(float(retry_backoff_seconds), 5.0))

    def describe(self) -> list[dict[str, str]]:
        return [{"name": adapter.name, "kind": "provider_adapter"} for adapter in self.adapters]

    async def run_all(
        self,
        product: ProductIdentity,
        queries: list[str],
        max_parallel: int = 4,
    ) -> list[AdapterRun]:
        semaphore = asyncio.Semaphore(max(1, max_parallel))

        def is_retryable(exc: Exception) -> bool:
            return isinstance(
                exc,
                httpx.TimeoutException
                | httpx.NetworkError
                | httpx.RemoteProtocolError
                | TimeoutError
                | ConnectionError,
            )

        async def run(adapter: ImageAdapter) -> AdapterRun:
            async with semaphore:
                retry_count = 0
                while True:
                    try:
                        health = await adapter.healthcheck()
                        if health.state in {
                            ProviderState.auth_required,
                            ProviderState.temporarily_disabled,
                            ProviderState.unsupported,
                        }:
                            return AdapterRun(
                                adapter.name, health.state, health.message, [], retry_count
                            )
                        candidates = await adapter.search(product, queries)
                        message = health.message
                        if retry_count:
                            message = f"{message}（已重试 {retry_count} 次）"
                        return AdapterRun(
                            adapter.name, health.state, message, candidates, retry_count
                        )
                    except PermissionError as exc:
                        return AdapterRun(
                            adapter.name,
                            ProviderState.auth_required,
                            str(exc),
                            [],
                            retry_count,
                        )
                    except httpx.HTTPStatusError as exc:
                        state = (
                            ProviderState.rate_limited
                            if exc.response.status_code == 429
                            else ProviderState.degraded
                        )
                        return AdapterRun(adapter.name, state, str(exc), [], retry_count)
                    except Exception as exc:  # Keep other adapters running.
                        if is_retryable(exc) and retry_count < self.max_retries:
                            retry_count += 1
                            if self.retry_backoff_seconds:
                                await asyncio.sleep(
                                    self.retry_backoff_seconds * (2 ** (retry_count - 1))
                                )
                            continue
                        message = f"{type(exc).__name__}: {exc}"
                        if retry_count:
                            message = f"{message}（已重试 {retry_count} 次）"
                        return AdapterRun(
                            adapter.name, ProviderState.degraded, message, [], retry_count
                        )

        return await asyncio.gather(*(run(adapter) for adapter in self.adapters))
