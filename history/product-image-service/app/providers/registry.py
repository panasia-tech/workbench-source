from __future__ import annotations

import httpx

from ..config import Settings
from ..db import Database
from ..security import CredentialVault
from .base import Provider
from .bing import BingPublicImagesProvider
from .brave import BraveProvider
from .community import DouyinProvider, XiaohongshuProvider
from .google import GoogleProvider
from .official import OfficialProvider
from .optional import GalleryDlProvider, PlaywrightProvider
from .reddit import RedditProvider
from .searxng import SearXNGProvider


class ProviderRegistry:
    def __init__(self, settings: Settings, database: Database, client: httpx.AsyncClient):
        self.settings = settings
        self.database = database
        self.vault = CredentialVault(settings, database)
        self.client = client
        self.providers: dict[str, Provider] = {}
        self._build()

    def _credentials(self, name: str, env: dict[str, str]) -> dict[str, str]:
        values = {key: value for key, value in env.items() if value}
        values.update(self.vault.get(name))
        return values

    def _build(self) -> None:
        s = self.settings
        self.providers = {
            "official": OfficialProvider(self.client, self._credentials("official", {})),
            "bing_public": BingPublicImagesProvider(
                self.client,
                self._credentials("bing_public", {}),
                pages_per_query=s.bing_pages_per_query,
                endpoint=s.bing_endpoint,
            ),
            "brave": BraveProvider(
                self.client, self._credentials("brave", {"api_key": s.brave_search_api_key})
            ),
            "google": GoogleProvider(
                self.client,
                self._credentials("google", {"api_key": s.google_api_key, "cx": s.google_cx}),
            ),
            "searxng": SearXNGProvider(
                self.client, self._credentials("searxng", {"url": s.searxng_url})
            ),
            "reddit": RedditProvider(
                self.client,
                self._credentials(
                    "reddit",
                    {
                        "client_id": s.reddit_client_id,
                        "client_secret": s.reddit_client_secret,
                        "user_agent": s.reddit_user_agent,
                    },
                ),
            ),
            "douyin": DouyinProvider(
                self.client,
                self._credentials(
                    "douyin",
                    {"access_token": s.douyin_access_token, "device_id": s.douyin_device_id},
                ),
            ),
            "xiaohongshu": XiaohongshuProvider(
                self.client,
                self._credentials(
                    "xiaohongshu", {"adapter_url": s.xhs_adapter_url, "cookie": s.xhs_cookie}
                ),
            ),
            "gallery_dl": GalleryDlProvider(
                self.client, self._credentials("gallery_dl", {"binary": s.gallery_dl_bin})
            ),
            "playwright": PlaywrightProvider(
                self.client,
                self._credentials("playwright", {"enabled": str(s.playwright_enabled).lower()}),
            ),
        }
        for provider in self.providers.values():
            provider.query_cap = s.provider_query_budget

    def configure_recall_mode(self, *, listing: bool = False, target: bool = False) -> None:
        """Pick Bing page depth for listing recall or long target-mode exports."""
        provider = self.providers.get("bing_public")
        if isinstance(provider, BingPublicImagesProvider):
            if target:
                provider.pages_per_query = self.settings.target_bing_tail_pages_per_query
            elif listing:
                provider.pages_per_query = self.settings.listing_bing_pages_per_query
            else:
                provider.pages_per_query = self.settings.bing_pages_per_query

    def configure_target_mode(self, enabled: bool) -> None:
        """Backward-compatible wrapper for callers that only know target mode."""
        self.configure_recall_mode(target=enabled)

    def bing_pages_per_query(self) -> int:
        provider = self.providers.get("bing_public")
        if isinstance(provider, BingPublicImagesProvider):
            return provider.pages_per_query
        return 0

    def enabled(self) -> list[Provider]:
        names = self.settings.enabled_provider_names
        return [provider for name, provider in self.providers.items() if name in names]

    def reload(self) -> None:
        self._build()
