from __future__ import annotations

import html
from urllib.parse import urljoin

from ..models import ProductIdentity, ProviderState
from .base import Health, Provider


class RedditProvider(Provider):
    name = "reddit"
    source_type = "community"
    token_endpoint = "https://www.reddit.com/api/v1/access_token"
    api_endpoint = "https://oauth.reddit.com/search.json"

    async def _token(self) -> str:
        client_id = self.credentials.get("client_id", "")
        client_secret = self.credentials.get("client_secret", "")
        if not client_id or not client_secret:
            return ""
        response = await self.client.post(
            self.token_endpoint,
            data={"grant_type": "client_credentials"},
            auth=(client_id, client_secret),
            headers={"User-Agent": self.credentials.get("user_agent", "product-image-service/0.1")},
        )
        if response.status_code in {401, 403}:
            raise PermissionError("Reddit OAuth credentials were rejected")
        response.raise_for_status()
        return str(response.json().get("access_token", ""))

    async def search(self, product: ProductIdentity, queries: list[str]):
        token = await self._token()
        if not token:
            return []
        found = []
        for query in queries[: self.query_cap]:
            response = await self.client.get(
                self.api_endpoint,
                params={"q": query, "type": "link", "limit": 25, "sort": "relevance"},
                headers={
                    "Authorization": f"Bearer {token}",
                    "User-Agent": self.credentials.get("user_agent", "product-image-service/0.1"),
                },
            )
            if response.status_code in {401, 403}:
                raise PermissionError("Reddit API rejected the access token")
            response.raise_for_status()
            children = response.json().get("data", {}).get("children", [])
            for child in children:
                data = child.get("data", {})
                preview = data.get("preview", {}).get("images", [])
                image_url = ""
                if preview:
                    image_url = html.unescape(preview[0].get("source", {}).get("url", ""))
                if not image_url and data.get("url", "").lower().split("?")[0].endswith(
                    (".jpg", ".jpeg", ".png", ".webp")
                ):
                    image_url = data["url"]
                if not image_url:
                    continue
                found.append(
                    self.candidate(
                        image_url=image_url,
                        page_url=urljoin("https://www.reddit.com", data.get("permalink", "")),
                        source_domain="reddit.com",
                        title=data.get("title", ""),
                        width=int(preview[0].get("source", {}).get("width") or 0) if preview else 0,
                        height=int(preview[0].get("source", {}).get("height") or 0)
                        if preview
                        else 0,
                        query=query,
                    )
                )
        return found

    async def healthcheck(self) -> Health:
        if not self.credentials.get("client_id") or not self.credentials.get("client_secret"):
            return Health(
                ProviderState.auth_required, "Reddit client credentials are not configured"
            )
        try:
            await self._token()
            return Health(ProviderState.healthy, "Reddit OAuth token acquired")
        except PermissionError as exc:
            return Health(ProviderState.auth_required, str(exc))
        except Exception as exc:
            return Health(ProviderState.degraded, f"{type(exc).__name__}: {exc}")
