from __future__ import annotations

from urllib.parse import quote_plus

from ..models import ProductIdentity, ProviderState
from .base import Health, Provider


class BraveProvider(Provider):
    name = "brave"
    source_type = "search"
    endpoint = "https://api.search.brave.com/res/v1/images/search"

    async def search(self, product: ProductIdentity, queries: list[str]):
        token = self.credentials.get("api_key", "")
        if not token:
            return []
        found = []
        for query in queries[: self.query_cap]:
            response = await self.client.get(
                self.endpoint,
                params={"q": query, "country": "ALL", "count": 50, "safesearch": "strict"},
                headers={"X-Subscription-Token": token, "Accept": "application/json"},
            )
            if response.status_code in {401, 403}:
                raise PermissionError("Brave API rejected credentials")
            response.raise_for_status()
            for item in response.json().get("results", []):
                properties = item.get("properties") or {}
                image_url = properties.get("url") or item.get("url")
                if not image_url:
                    continue
                found.append(
                    self.candidate(
                        image_url=image_url,
                        page_url=item.get("page_url", "") or item.get("source", ""),
                        source_domain=item.get("source", ""),
                        title=item.get("title", ""),
                        width=int(properties.get("width") or 0),
                        height=int(properties.get("height") or 0),
                        query=query,
                    )
                )
        return found

    async def healthcheck(self) -> Health:
        if not self.credentials.get("api_key"):
            return Health(ProviderState.auth_required, "BRAVE_SEARCH_API_KEY is not configured")
        try:
            response = await self.client.get(
                self.endpoint,
                params={"q": quote_plus("product image"), "count": 1},
                headers={"X-Subscription-Token": self.credentials["api_key"]},
            )
            if response.status_code in {401, 403}:
                return Health(ProviderState.auth_required, "Brave API rejected credentials")
            response.raise_for_status()
            return Health(ProviderState.healthy, "Brave Image Search API reachable")
        except Exception as exc:
            return Health(ProviderState.degraded, f"{type(exc).__name__}: {exc}")
