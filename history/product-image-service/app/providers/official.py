from __future__ import annotations

from urllib.parse import urlparse

from ..models import ProductIdentity, ProviderState
from ..parser import official_domains, parse_page
from .base import Health, Provider


class OfficialProvider(Provider):
    name = "official"
    source_type = "official"

    async def search(self, product: ProductIdentity, queries: list[str]):
        results = []
        for domain in official_domains(product):
            for scheme in ("https",):
                url = f"{scheme}://{domain}"
                try:
                    response = await self.client.get(url, follow_redirects=True)
                    if response.status_code >= 400 or "text/html" not in response.headers.get(
                        "content-type", ""
                    ):
                        continue
                    evidence = parse_page(response.text, str(response.url))
                    haystack = f"{evidence.title} {evidence.text}".lower()
                    model = product.model.lower().replace(" ", "")
                    if model not in haystack.replace(" ", ""):
                        continue
                    for image_url in evidence.image_urls:
                        if urlparse(image_url).scheme in {"http", "https"}:
                            results.append(
                                self.candidate(
                                    image_url=image_url,
                                    page_url=str(response.url),
                                    source_domain=domain,
                                    title=evidence.title,
                                    query=f"site:{domain} {product.model}",
                                )
                            )
                except Exception:
                    continue
        return results

    async def healthcheck(self) -> Health:
        return Health(
            ProviderState.healthy, "Official domain registry and public page parser ready"
        )
