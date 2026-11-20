from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any

from .models import ProductIdentity

SUPPORTED_LOCALES = (
    "en",
    "zh",
    "es",
    "hi",
    "ar",
    "id",
    "pt",
    "fr",
    "ru",
    "bn",
    "ja",
    "ur",
    "de",
    "vi",
    "tr",
)

LOCALE_LABELS = {
    "en": "英语",
    "zh": "中文",
    "es": "西班牙语",
    "hi": "印地语",
    "ar": "阿拉伯语",
    "id": "印度尼西亚语",
    "pt": "葡萄牙语",
    "fr": "法语",
    "ru": "俄语",
    "bn": "孟加拉语",
    "ja": "日语",
    "ur": "乌尔都语",
    "de": "德语",
    "vi": "越南语",
    "tr": "土耳其语",
}

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BRAND_CATALOG_PATH = PROJECT_ROOT / "config" / "brand_aliases.json"
DEFAULT_MARKET_CATALOG_PATH = PROJECT_ROOT / "config" / "market_platforms.json"

def normalize_text(value: str) -> str:
    """Normalize all supported scripts without maintaining a script allow-list."""
    normalized = unicodedata.normalize("NFKC", value).casefold()
    chars: list[str] = []
    for char in normalized:
        # Format characters include zero-width and bidi controls. They must not
        # influence either brand matching or model evidence.
        if unicodedata.category(char) == "Cf":
            continue
        chars.append(char if char.isalnum() or char.isspace() else " ")
    return re.sub(r"\s+", " ", "".join(chars)).strip()


def compact_text(value: str) -> str:
    return re.sub(r"\s+", "", normalize_text(value))


def canonical_locale(value: str | None) -> str | None:
    if not value:
        return None
    candidate = value.strip().lower().replace("_", "-").split("-")[0]
    return candidate if candidate in SUPPORTED_LOCALES else None


def _read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def load_brand_catalog(path: str | Path = DEFAULT_BRAND_CATALOG_PATH) -> dict[str, Any]:
    return _read_json(Path(path), {"version": 1, "brands": []})


def load_market_catalog(path: str | Path = DEFAULT_MARKET_CATALOG_PATH) -> dict[str, Any]:
    return _read_json(Path(path), {"version": 1, "supported_locales": [], "platforms": {}})


def brand_records(catalog: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    catalog = catalog or load_brand_catalog()
    brands = catalog.get("brands", [])
    if isinstance(brands, dict):
        return [dict(value, key=key) for key, value in brands.items()]
    return [item for item in brands if isinstance(item, dict)]


def brand_record_by_key(key: str, catalog: dict[str, Any] | None = None) -> dict[str, Any] | None:
    normalized = compact_text(key)
    return next(
        (
            item
            for item in brand_records(catalog)
            if compact_text(str(item.get("key", item.get("canonical", "")))) == normalized
        ),
        None,
    )


def _record_aliases(record: dict[str, Any]) -> list[str]:
    values: list[str] = []
    values.extend(str(item) for item in record.get("aliases", []) if item)
    values.extend(
        str(item) for item in record.get("localized_names", {}).values() if item
    )
    canonical = record.get("canonical")
    if canonical:
        values.append(str(canonical))
    return list(dict.fromkeys(values))


def match_brand(
    query: str, catalog: dict[str, Any] | None = None
) -> tuple[dict[str, Any], str, str] | None:
    """Match the longest known brand prefix and return (record, remainder, alias)."""
    clean = " ".join(query.split())
    normalized = normalize_text(clean)
    compact = compact_text(clean)
    matches: list[tuple[int, dict[str, Any], str]] = []
    for record in brand_records(catalog):
        for alias in _record_aliases(record):
            alias_normalized = normalize_text(alias)
            alias_compact = compact_text(alias)
            if not alias_compact:
                continue
            if normalized == alias_normalized or normalized.startswith(alias_normalized + " "):
                matches.append((len(alias_compact), record, alias))
            elif compact.startswith(alias_compact) and len(compact) > len(alias_compact):
                matches.append((len(alias_compact), record, alias))
    if not matches:
        return None
    _length, record, alias = max(matches, key=lambda item: item[0])
    alias_normalized = normalize_text(alias)
    if normalized == alias_normalized:
        remainder = ""
    elif normalized.startswith(alias_normalized + " "):
        remainder = normalized[len(alias_normalized) :].strip()
    else:
        remainder = compact[len(compact_text(alias)) :].strip()
    return record, remainder, alias


def remainder_after_alias(value: str, alias: str) -> str:
    """Remove a matched alias while preserving the user's original model casing."""
    target = compact_text(alias)
    seen = ""
    for index, char in enumerate(value):
        unit = compact_text(char)
        if not unit:
            continue
        if not target.startswith(seen + unit):
            return ""
        seen += unit
        if seen == target:
            return value[index + 1 :].strip(" -:/")
    return ""


def model_variants(model: str) -> list[str]:
    """Create conservative model spellings without inventing a different model."""
    clean = " ".join(model.split())
    variants = [clean]
    variants.append(re.sub(r"(?<=\d)(?=[A-Za-z])", " ", clean))
    variants.append(re.sub(r"(?<=[a-z])(?=\d)", " ", clean))
    variants.append(re.sub(r"\s+", "", clean))
    return list(dict.fromkeys(item.strip() for item in variants if item.strip()))


def model_aliases_for(record: dict[str, Any] | None, model: str) -> list[str]:
    if not record:
        return model_variants(model)
    aliases: list[str] = []
    target = compact_text(model)
    for item in record.get("model_aliases", []):
        if not isinstance(item, dict):
            continue
        keys = [item.get("model", ""), *item.get("aliases", [])]
        if target and any(compact_text(str(key)) == target for key in keys if key):
            aliases.extend(str(key) for key in keys if key)
    aliases.extend(model_variants(model))
    return list(dict.fromkeys(item.strip() for item in aliases if item.strip()))


def brand_names_for(
    product: ProductIdentity, locales: list[str], catalog: dict[str, Any] | None = None
) -> list[str]:
    names: list[str] = []
    record = brand_record_by_key(product.brand_key or product.brand, catalog)
    if product.brand:
        names.append(product.brand)
    names.extend(product.brand_aliases)
    if record:
        localized = record.get("localized_names", {})
        for locale in locales:
            if localized.get(locale):
                names.append(str(localized[locale]))
        names.extend(_record_aliases(record))
        for line in record.get("product_lines", []):
            if isinstance(line, dict):
                names.extend(str(value) for value in line.get("aliases", []) if value)
    return list(dict.fromkeys(name.strip() for name in names if name.strip()))


def _locales_for_product(product: ProductIdentity, locale: str | None) -> list[str]:
    requested = canonical_locale(locale)
    if requested:
        return list(dict.fromkeys([requested, "en", "zh"]))
    if product.supported_locales:
        return [item for item in product.supported_locales if item in SUPPORTED_LOCALES]
    if product.brand_key:
        return list(SUPPORTED_LOCALES)
    # Unknown brands are not translated by guesswork. Keep the original language and
    # the two largest fallback search languages only.
    return ["en", "zh"]


INTENT_TERMS = {
    "en": ("product image", "review", "customer photo", "buyer photo", "hands-on", "owner photo"),
    "zh": ("实拍", "晒单", "买家秀", "用户实拍", "开箱", "测评"),
    "es": ("fotos del producto", "reseña", "foto del comprador", "unboxing"),
    "hi": ("उत्पाद फोटो", "समीक्षा", "ग्राहक फोटो", "अनबॉक्सिंग"),
    "ar": ("صور المنتج", "مراجعة", "صور العملاء", "فتح العلبة"),
    "id": ("foto produk", "ulasan", "foto pembeli", "unboxing"),
    "pt": ("foto do produto", "avaliação", "foto do cliente", "unboxing"),
    "fr": ("photo produit", "avis", "photo client", "déballage"),
    "ru": ("фото товара", "обзор", "фото покупателя", "распаковка"),
    "bn": ("পণ্যের ছবি", "রিভিউ", "ক্রেতার ছবি", "আনবক্সিং"),
    "ja": ("製品 写真", "レビュー", "購入者 写真", "開封"),
    "ur": ("مصنوعات کی تصویر", "جائزہ", "خریدار کی تصویر", "ان باکسنگ"),
    "de": ("Produktfoto", "Test", "Kundenfoto", "Unboxing"),
    "vi": ("ảnh sản phẩm", "đánh giá", "ảnh người mua", "đập hộp"),
    "tr": ("ürün fotoğrafı", "inceleme", "müşteri fotoğrafı", "kutudan çıkarma"),
}

COMMUNITY_SEARCH_DOMAINS = {
    "en": ("reddit.com", "youtube.com"),
    "zh": ("reddit.com", "youtube.com", "bilibili.com", "smzdm.com", "tieba.baidu.com"),
}


def eligible_platforms(
    locale: str | None,
    requested: list[str] | None = None,
    catalog: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    market_catalog = catalog or load_market_catalog()
    normalized_locale = canonical_locale(locale)
    requested_set = set(requested or [])
    selected: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for platform_id, item in market_catalog.get("platforms", {}).items():
        platform = dict(item)
        platform["id"] = platform_id
        locales = set(platform.get("locales", []))
        eligible = not normalized_locale or normalized_locale in locales
        if requested_set and platform_id not in requested_set:
            continue
        if eligible and platform.get("availability", "conditional") != "not_available":
            selected.append(platform)
        elif requested_set:
            skipped.append(
                {
                    "id": platform_id,
                    "name": platform.get("name", platform_id),
                    "reason": f"{normalized_locale or '当前语言'}未列入该平台市场目录",
                }
            )
    selected.sort(key=lambda item: (item.get("availability") != "active", item["id"]))
    return selected, skipped


def build_query_plan(
    product: ProductIdentity,
    locale: str | None = None,
    requested_platforms: list[str] | None = None,
    brand_catalog: dict[str, Any] | None = None,
    market_catalog: dict[str, Any] | None = None,
) -> dict[str, Any]:
    locales = _locales_for_product(product, locale)
    names = brand_names_for(product, locales, brand_catalog)
    models = model_aliases_for(
        brand_record_by_key(product.brand_key or product.brand, brand_catalog), product.model
    )
    platforms, skipped = eligible_platforms(locale, requested_platforms, market_catalog)
    queries_by_locale: dict[str, list[str]] = {}
    site_queries_by_locale: dict[str, list[str]] = {}
    for current_locale in locales:
        terms = INTENT_TERMS.get(current_locale, INTENT_TERMS["en"])
        localized: list[str] = [product.original_query]
        localized.extend(f"{name} {product.model}".strip() for name in names[:8])
        # Put direct Latin brand/model pairs first. Several providers deliberately
        # cap a request to 3-8 queries, so a useful alias must not be hidden behind
        # a long tail of intent phrases.
        latin_names = [name for name in names if re.search(r"[A-Za-z]", name)]
        latin_models = [model for model in models if re.search(r"[A-Za-z]", model)]
        localized.extend(
            f"{name} {model}".strip()
            for model in latin_models[:6]
            for name in latin_names[:8]
        )
        for name in names:
            for model in models[:6]:
                base = f"{name} {model}".strip()
                localized.append(base)
                localized.extend(f"{base} {term}" for term in terms[:3])
        core_queries = list(dict.fromkeys(localized))
        platform_site_queries: list[str] = []
        for platform in platforms:
            for domain in platform.get("search_domains", [])[:1]:
                base = f"site:{domain} {product.brand} {product.model}".strip()
                platform_site_queries.append(base)
                for term in terms[1:2]:
                    platform_site_queries.append(f"{base} {term}")
        community_site_queries: list[str] = []
        for domain in COMMUNITY_SEARCH_DOMAINS.get(current_locale, COMMUNITY_SEARCH_DOMAINS["en"]):
            base = f"site:{domain} {product.brand} {product.model}".strip()
            community_site_queries.append(base)
            for term in terms[1:2]:
                community_site_queries.append(f"{base} {term}")
        site_queries = list(
            dict.fromkeys(community_site_queries[:6] + platform_site_queries + community_site_queries[6:])
        )
        site_queries = list(dict.fromkeys(site_queries))
        site_queries_by_locale[current_locale] = site_queries
        # Keep identity aliases in the first provider window, then insert market
        # site-hints before the long tail of review/unboxing language variants.
        queries_by_locale[current_locale] = list(
            dict.fromkeys(core_queries[:8] + site_queries[:24] + core_queries[8:])
        )[:64]
    flat_queries = list(
        dict.fromkeys(query for current in locales for query in queries_by_locale.get(current, []))
    )[:240]
    return {
        "requested_locale": canonical_locale(locale),
        "locales": locales,
        "locale_labels": {item: LOCALE_LABELS[item] for item in locales},
        "platforms": [
            {
                "id": item["id"],
                "name": item.get("name", item["id"]),
                "availability": item.get("availability", "conditional"),
                "regions": item.get("regions", []),
                "search_domains": item.get("search_domains", []),
            }
            for item in platforms
        ],
        "skipped_platforms": skipped,
        "queries_by_locale": queries_by_locale,
        "site_queries_by_locale": site_queries_by_locale,
        "market_site_query_count": sum(len(item) for item in site_queries_by_locale.values()),
        "query_count": len(flat_queries),
        "queries": flat_queries,
        "note": (
            "已知品牌使用词库中的本地名称；未知品牌不自动臆造翻译。"
            "平台仅按市场目录筛选，conditional 仍需真实上游验证。"
        ),
    }


def build_queries_from_plan(plan: dict[str, Any]) -> list[str]:
    return list(plan.get("queries", []))
