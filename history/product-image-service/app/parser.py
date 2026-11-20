from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from .models import ProductIdentity
from .query_planner import (
    brand_record_by_key,
    brand_records,
    build_query_plan,
    compact_text,
    match_brand,
    model_aliases_for,
    normalize_text,
    remainder_after_alias,
)


def _known_brands() -> dict[str, tuple[str, tuple[str, ...]]]:
    result: dict[str, tuple[str, tuple[str, ...]]] = {}
    for record in brand_records():
        canonical = str(record.get("canonical", record.get("key", "")))
        domains = tuple(str(item) for item in record.get("official_domains", []))
        aliases = [canonical, *record.get("aliases", []), *record.get("localized_names", {}).values()]
        for alias in aliases:
            key = compact_text(str(alias))
            if key:
                result[key] = (canonical, domains)
    return result


# Kept as a compatibility surface for callers that imported the old mapping.
KNOWN_BRANDS = _known_brands()


def normalize(value: str) -> str:
    return normalize_text(value)


# 只去掉缩放/追踪/签名这类“同一张图的不同地址”参数；id/image/v/hash 等身份参数保留。
_TRACKING_QUERY_KEYS = {
    "w", "h", "width", "height", "q", "quality", "fit", "resize", "size",
    "thumbnail", "thumb", "x-oss-process", "expires", "ossaccesskeyid",
    "signature", "security-token", "spm", "from", "ref",
}
_TRACKING_QUERY_PREFIXES = ("utm_", "x-amz-", "imageview", "imgresize")


def normalize_image_url_key(url: str) -> str:
    """图片去重键：保留身份参数，去掉签名/缩放/追踪参数。"""
    raw = (url or "").strip()
    if not raw:
        return ""
    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw.lower()
    host = parts.netloc.lower()
    query = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        lowered = key.lower()
        if lowered in _TRACKING_QUERY_KEYS or lowered.startswith(_TRACKING_QUERY_PREFIXES):
            continue
        query.append((key, value))
    query.sort()
    return urlunsplit((parts.scheme.lower(), host, parts.path, urlencode(query), ""))


def resolve_product(query: str, catalog: dict | None = None) -> ProductIdentity:
    clean = " ".join(query.split())
    if not clean:
        return ProductIdentity(original_query="", brand="", model="", aliases=[])
    matched = match_brand(clean, catalog)
    if matched:
        record, remainder, matched_alias = matched
        brand = (
            matched_alias
            if any("\u4e00" <= char <= "\u9fff" for char in matched_alias)
            else str(record.get("canonical", matched_alias))
        )
        model = remainder_after_alias(clean, matched_alias) or remainder.strip(" -:/") or clean
        brand_key = str(record.get("key", brand))
        brand_aliases = list(
            dict.fromkeys(
                [
                    matched_alias,
                    brand,
                    *[str(item) for item in record.get("aliases", [])],
                    *[str(item) for item in record.get("localized_names", {}).values()],
                ]
            )
        )
        model_aliases = model_aliases_for(record, model)
        aliases = [clean, f"{brand} {model}", *model_aliases]
        aliases.extend(f"{name} {model}" for name in brand_aliases[:12])
        return ProductIdentity(
            original_query=clean,
            brand=brand,
            model=model,
            aliases=list(dict.fromkeys(item for item in aliases if item.strip())),
            brand_key=brand_key,
            brand_aliases=brand_aliases,
            model_aliases=model_aliases,
            official_domains=list(record.get("official_domains", [])),
            supported_locales=list(record.get("supported_locales", [])),
        )

    tokens = clean.split()
    if len(tokens) < 2:
        return ProductIdentity(original_query=clean, brand=clean, model=clean, aliases=[clean])
    brand = tokens[0]
    model = " ".join(tokens[1:])
    variants = model_aliases_for(None, model)
    aliases = list(dict.fromkeys([clean, f"{brand} {model}", *variants]))
    return ProductIdentity(
        original_query=clean,
        brand=brand,
        model=model,
        aliases=aliases,
        brand_aliases=[brand],
        model_aliases=variants,
    )


def official_domains(product: ProductIdentity) -> tuple[str, ...]:
    if product.official_domains:
        return tuple(product.official_domains)
    record = brand_record_by_key(product.brand_key or product.brand)
    return tuple(record.get("official_domains", [])) if record else ()


def brand_evidence_terms(product: ProductIdentity) -> tuple[str, ...]:
    """Return compact brand spellings that are acceptable as page evidence."""
    values = [product.brand, *product.brand_aliases]
    record = brand_record_by_key(product.brand_key or product.brand)
    if record:
        if record.get("evidence_terms"):
            return tuple(
                dict.fromkeys(compact_text(str(item)) for item in record["evidence_terms"] if item)
            )
        values.extend(str(item) for item in record.get("aliases", []))
        values.extend(str(item) for item in record.get("localized_names", {}).values())
    terms = [compact_text(value) for value in values if value]
    return tuple(dict.fromkeys(term for term in terms if term))


def build_queries(product: ProductIdentity, locale: str | None = None) -> list[str]:
    plan = build_query_plan(product, locale=locale)
    queries = list(plan.get("queries", []))
    # Keep the old exact-model query contract and a few quality-oriented English
    # queries even when a catalog entry has no localized search terms.
    base = f"{product.brand} {product.model}".strip()
    queries.extend(
        [
            base,
            f'"{product.model}"',
            f"{base} official product",
            f"{base} product image",
            f"{base} review",
            f"{base} unboxing",
            f"{base} white background",
            f"{base} rear side ports",
        ]
    )
    return list(dict.fromkeys(item for item in queries if item))[:160]


@dataclass
class PageEvidence:
    title: str
    text: str
    image_urls: list[str]
    related_page_urls: list[str] = field(default_factory=list)
    embedded_image_urls: list[str] = field(default_factory=list)


def parse_page(html: str, base_url: str) -> PageEvidence:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    text = soup.get_text(" ", strip=True)[:20_000]
    image_urls: list[str] = []
    related_page_urls: list[str] = []
    embedded_image_urls: list[str] = []
    for tag in soup.find_all("meta"):
        prop = (tag.get("property") or tag.get("name") or "").lower()
        content = tag.get("content") or ""
        if prop in {"og:image", "twitter:image"} and content:
            image_urls.append(urljoin(base_url, content))
    for tag in soup.find_all("img")[:100]:
        for key in ("src", "data-src", "data-original"):
            value = tag.get(key)
            if value:
                image_urls.append(urljoin(base_url, value))
        srcset = tag.get("srcset") or tag.get("data-srcset") or ""
        for item in srcset.split(","):
            if item.strip():
                image_urls.append(urljoin(base_url, item.strip().split(" ")[0]))
    for tag in soup.find_all("a")[:300]:
        href = tag.get("href") or ""
        absolute_href = urljoin(base_url, href)
        href_path = urlparse(absolute_href).path.lower()
        href_host = (urlparse(absolute_href).hostname or "").lower().removeprefix("www.")
        base_host = (urlparse(base_url).hostname or "").lower().removeprefix("www.")
        if (
            href_host == base_host
            and not re.search(r"\.(?:jpe?g|png|webp|gif)(?:[?#]|$)", href_path)
            and any(
                marker in href_path
                for marker in ("gallery", "review", "photo", "comment", "detail", "product", "listing")
            )
        ):
            related_page_urls.append(absolute_href)
        for key in ("href", "data-image", "data-full", "data-original"):
            value = tag.get(key)
            if not value:
                continue
            lowered = value.lower()
            if re.search(r"\.(?:jpe?g|png|webp|gif)(?:[?#]|$)", lowered) or any(
                marker in lowered for marker in ("/image", "/photo", "/media", "/upload")
            ):
                image_urls.append(urljoin(base_url, value))
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            payload = json.loads(script.get_text())
            raw = json.dumps(payload, ensure_ascii=False)
            image_urls.extend(re.findall(r"https?://[^\"' ]+", raw))
            text += " " + raw[:10_000]
        except (json.JSONDecodeError, TypeError):
            continue
    for script in soup.find_all("script"):
        raw_script = script.get_text(" ", strip=False)
        if not raw_script or not any(
            marker in raw_script.casefold()
            for marker in ("image", "photo", "media", "gallery", "picture")
        ):
            continue
        normalized_script = raw_script.replace("\\/", "/")
        for raw_url in re.findall(r'''https?://[^"'\s<>]+''', normalized_script):
            image_url = raw_url.rstrip(",;)]}")
            lowered = image_url.casefold()
            if re.search(r"\.(?:jpe?g|png|webp|gif)(?:[?#]|$)", lowered) or any(
                marker in lowered for marker in ("/image", "/photo", "/media", "/upload")
            ):
                embedded_image_urls.append(image_url)
                image_urls.append(image_url)
    return PageEvidence(
        title=title,
        text=text,
        image_urls=list(dict.fromkeys(image_urls)),
        related_page_urls=list(dict.fromkeys(related_page_urls))[:32],
        embedded_image_urls=list(dict.fromkeys(embedded_image_urls))[:300],
    )


def domain_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower().removeprefix("www.")
