from __future__ import annotations

from ..models import ProductIdentity, ProviderState
from .base import Health, Provider


class GoogleProvider(Provider):
    name = "google"
    source_type = "search"
    endpoint = "https://www.googleapis.com/customsearch/v1"

    async def search(self, product: ProductIdentity, queries: list[str]):
        key = self.credentials.get("api_key", "")
        cx = self.credentials.get("cx", "")
        if not key or not cx:
            return []
        found = []
        for query in queries[: self.query_cap]:
            response = await self.client.get(
                self.endpoint,
                params={
                    "key": key,
                    "cx": cx,
                    "q": query,
                    "searchType": "image",
                    "num": 10,
                    "safe": "active",
                },
            )
            if response.status_code in {401, 403}:
                raise PermissionError("Google Custom Search rejected credentials")
            response.raise_for_status()
            for item in response.json().get("items", []):
                image = item.get("image") or {}
                image_url = item.get("link")
                if not image_url:
                    continue
                found.append(
                    self.candidate(
                        image_url=image_url,
                        page_url=image.get("contextLink", ""),
                        source_domain=item.get("displayLink", ""),
                        title=item.get("title", ""),
                        width=int(image.get("width") or 0),
                        height=int(image.get("height") or 0),
                        query=query,
                    )
                )
        return found

    async def healthcheck(self) -> Health:
        if not self.credentials.get("api_key") or not self.credentials.get("cx"):
            return Health(ProviderState.auth_required, "GOOGLE_API_KEY and GOOGLE_CX are required")
        try:
            response = await self.client.get(
                self.endpoint,
                params={
                    "key": self.credentials["api_key"],
                    "cx": self.credentials["cx"],
                    "q": "product",
                    "searchType": "image",
                    "num": 1,
                },
            )
            if response.status_code in {401, 403}:
                return Health(
                    ProviderState.auth_required, "Google Custom Search rejected credentials"
                )
            response.raise_for_status()
            return Health(ProviderState.healthy, "Google Custom Search reachable")
        except Exception as exc:
            return Health(ProviderState.degraded, f"{type(exc).__name__}: {exc}")
