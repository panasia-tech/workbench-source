from __future__ import annotations

from ..models import ProductIdentity, ProviderState
from .base import Health, Provider


def extract_urls(value: object) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if (
                isinstance(item, str)
                and item.startswith(("http://", "https://"))
                and any(mark in key.lower() for mark in ("cover", "image", "pic", "url"))
            ):
                found.append(item)
            else:
                found.extend(extract_urls(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(extract_urls(item))
    return list(dict.fromkeys(found))


class DouyinProvider(Provider):
    name = "douyin"
    source_type = "community"
    endpoint = "https://open.douyin.com/dy_open_api/v2/search/video/"

    async def search(self, product: ProductIdentity, queries: list[str]):
        token = self.credentials.get("access_token", "")
        device_id = self.credentials.get("device_id", "") or "1"
        if not token:
            return []
        results = []
        for query in queries[: self.query_cap]:
            response = await self.client.get(
                self.endpoint,
                params={"keyword": query, "count": 10, "cursor": 0, "device_id": device_id},
                headers={"access-token": token, "Content-Type": "application/json"},
            )
            if response.status_code in {401, 403}:
                raise PermissionError("Douyin access token was rejected")
            response.raise_for_status()
            payload = response.json()
            for image_url in extract_urls(payload):
                results.append(
                    self.candidate(
                        image_url=image_url, source_domain="douyin.com", title=query, query=query
                    )
                )
        return results

    async def healthcheck(self) -> Health:
        if not self.credentials.get("access_token"):
            return Health(ProviderState.auth_required, "Douyin access token is not configured")
        return Health(
            ProviderState.degraded,
            "Token configured; run a real search smoke test to validate scope",
        )


class XiaohongshuProvider(Provider):
    name = "xiaohongshu"
    source_type = "community"

    async def search(self, product: ProductIdentity, queries: list[str]):
        adapter_url = self.credentials.get("adapter_url", "").rstrip("/")
        if not adapter_url:
            return []
        response = await self.client.post(
            f"{adapter_url}/search",
            json={"queries": queries[: self.query_cap], "query": product.original_query},
            headers={"X-Provider-Cookie": self.credentials.get("cookie", "")},
        )
        if response.status_code in {401, 403}:
            raise PermissionError("Xiaohongshu adapter rejected the configured login state")
        response.raise_for_status()
        payload = response.json()
        results = []
        for item in payload.get("results", []):
            image_url = item.get("image_url") or item.get("url")
            if image_url:
                results.append(
                    self.candidate(
                        **{
                            **item,
                            "image_url": image_url,
                            "query": item.get("query", product.original_query),
                        }
                    )
                )
        return results

    async def healthcheck(self) -> Health:
        if not self.credentials.get("adapter_url"):
            return Health(
                ProviderState.auth_required, "Configure a legal XHS adapter URL and login state"
            )
        return Health(ProviderState.degraded, "Configured adapter; run a real search smoke test")
