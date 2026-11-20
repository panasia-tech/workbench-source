from __future__ import annotations

from urllib.parse import urljoin

from ..models import ProductIdentity, ProviderState
from .base import Health, Provider


class SearXNGProvider(Provider):
    name = "searxng"
    source_type = "search"

    async def search(self, product: ProductIdentity, queries: list[str]):
        base_url = self.credentials.get("url", "").rstrip("/")
        if not base_url:
            return []
        found = []
        for query in queries[: self.query_cap]:
            response = await self.client.get(
                urljoin(base_url + "/", "search"),
                params={"q": query, "format": "json", "categories": "images", "safesearch": 1},
            )
            if response.status_code in {401, 403}:
                raise PermissionError("SearXNG instance refused the request")
            response.raise_for_status()
            for item in response.json().get("results", []):
                image_url = item.get("img_src") or item.get("thumbnail_src")
                if not image_url:
                    continue
                found.append(
                    self.candidate(
                        image_url=image_url,
                        page_url=item.get("url", ""),
                        source_domain=item.get("domain", ""),
                        title=item.get("title", ""),
                        width=int(item.get("width") or 0),
                        height=int(item.get("height") or 0),
                        query=query,
                    )
                )
        return found

    async def healthcheck(self) -> Health:
        base_url = self.credentials.get("url", "").rstrip("/")
        if not base_url:
            return Health(ProviderState.auth_required, "SEARXNG_URL is not configured")
        try:
            response = await self.client.get(urljoin(base_url + "/", "config"), timeout=8)
            if response.status_code >= 500:
                return Health(ProviderState.degraded, f"SearXNG returned {response.status_code}")
            return Health(ProviderState.healthy, "Configured SearXNG endpoint reachable")
        except Exception as exc:
            return Health(ProviderState.degraded, f"{type(exc).__name__}: {exc}")
