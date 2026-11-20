from __future__ import annotations

import shutil

from ..models import ProductIdentity, ProviderState
from .base import Health, Provider


class GalleryDlProvider(Provider):
    name = "gallery_dl"
    source_type = "community"

    async def search(self, product: ProductIdentity, queries: list[str]):
        return []

    async def healthcheck(self) -> Health:
        binary = self.credentials.get("binary", "gallery-dl")
        if not shutil.which(binary):
            return Health(
                ProviderState.unsupported, "gallery-dl is not installed; adapter remains optional"
            )
        return Health(
            ProviderState.healthy,
            "gallery-dl executable detected; only explicit public URLs are eligible",
        )


class PlaywrightProvider(Provider):
    name = "playwright"
    source_type = "browser"

    async def search(self, product: ProductIdentity, queries: list[str]):
        return []

    async def healthcheck(self) -> Health:
        if self.credentials.get("enabled", "false").lower() != "true":
            return Health(ProviderState.temporarily_disabled, "Playwright is disabled by default")
        try:
            import playwright  # noqa: F401
        except ImportError:
            return Health(
                ProviderState.unsupported, "Install the browser extra to enable Playwright"
            )
        return Health(
            ProviderState.healthy,
            "Playwright extra installed; browser concurrency is capped at one",
        )
