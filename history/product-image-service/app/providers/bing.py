from __future__ import annotations

import html
import json

from bs4 import BeautifulSoup

from ..models import ProductIdentity, ProviderState
from ..parser import domain_of, normalize_image_url_key
from .base import Health, Provider


class BingPublicImagesProvider(Provider):
    """Best-effort public Bing Images HTML fallback; no login or anti-bot bypass."""

    name = "bing_public"
    source_type = "search"
    endpoint = "https://www.bing.com/images/search"

    def __init__(
        self,
        client,
        credentials: dict[str, str] | None = None,
        *,
        pages_per_query: int = 1,
        endpoint: str | None = None,
    ):
        super().__init__(client, credentials)
        self.pages_per_query = max(1, min(int(pages_per_query), 5))
        if endpoint:
            self.endpoint = endpoint
        # cn.bing ignores the site: operator and answers with unrelated pages
        # (fruit stock photos, political news, world maps), so drop those queries.
        self.skip_site_queries = "cn.bing.com" in self.endpoint

    async def search(self, product: ProductIdentity, queries: list[str]):
        results = []
        if self.skip_site_queries:
            queries = [query for query in queries if "site:" not in query.lower()]
        for query in queries[: self.query_cap]:
            # 第一次请求可能才被 302 到 cn.bing.com，后续查询也要跳过 site:。
            if self.skip_site_queries and "site:" in query.lower():
                continue
            seen_for_query: set[str] = set()
            for page_index in range(self.pages_per_query):
                response = await self.client.get(
                    self.endpoint,
                    params={
                        "q": query,
                        "safeSearch": "Strict",
                        "first": page_index * 35,
                        "count": 35,
                    },
                    # Mainland egress is 302'd from www.bing.com to cn.bing.com.
                    follow_redirects=True,
                )
                if response.status_code in {401, 403, 429}:
                    raise PermissionError(
                        f"Bing public image search returned {response.status_code}"
                    )
                response.raise_for_status()
                # www.bing.com 在大陆出口会 302 到 cn.bing.com；cn 会忽略 site: 并返回无关页。
                if "cn.bing.com" in str(getattr(response, "url", "")).lower():
                    self.skip_site_queries = True
                soup = BeautifulSoup(response.text, "html.parser")
                new_results = 0
                for anchor in soup.select("a.iusc"):
                    raw = anchor.get("m")
                    if not raw:
                        continue
                    try:
                        item = json.loads(html.unescape(raw))
                    except json.JSONDecodeError:
                        continue
                    image_url = item.get("murl")
                    if not image_url:
                        continue
                    key = normalize_image_url_key(str(image_url))
                    if key in seen_for_query:
                        continue
                    seen_for_query.add(key)
                    new_results += 1
                    results.append(
                        self.candidate(
                            image_url=image_url,
                            page_url=item.get("purl", ""),
                            source_domain=domain_of(item.get("purl", "")),
                            title=item.get("t", "") or item.get("desc", ""),
                            width=int(item.get("expw") or 0),
                            height=int(item.get("exph") or 0),
                            query=query,
                            search_page=page_index + 1,
                            media_origin=(
                                "search_pagination" if page_index else "unknown"
                            ),
                        )
                    )
                if page_index > 0 and new_results == 0:
                    break
        return results

    async def healthcheck(self) -> Health:
        return Health(ProviderState.healthy, "Public Bing Images HTML fallback enabled")
