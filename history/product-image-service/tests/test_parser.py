from app.parser import (
    brand_evidence_terms,
    build_queries,
    domain_of,
    official_domains,
    parse_page,
    resolve_product,
)
from app.query_planner import SUPPORTED_LOCALES, build_query_plan


def test_resolve_known_product_aliases():
    product = resolve_product("ROG XG259CMS")
    assert product.brand == "ROG"
    assert product.model == "XG259CMS"
    assert "XG259CMS" in product.aliases
    assert "asus.com" in official_domains(product)


def test_resolve_chinese_product():
    product = resolve_product("泰坦军团 27G6H")
    assert product.brand == "泰坦军团"
    assert product.model == "27G6H"
    assert any("实拍" in query for query in build_queries(product))


def test_domain_of_removes_www():
    assert domain_of("https://www.example.com/path") == "example.com"


def test_brand_evidence_aliases():
    assert brand_evidence_terms(resolve_product("ROG XG259CMS")) == ("rog", "asus")
    assert "titanarmy" in brand_evidence_terms(resolve_product("泰坦军团 27G6H"))


def test_multilingual_brand_and_model_expansion_examples():
    rog_queries = build_queries(resolve_product("ROG PG27UQR"))
    sanc_queries = build_queries(resolve_product("SANC N50PRO6"))
    dyson_queries = build_queries(resolve_product("dyson bp04"))
    xiaomi_queries = build_queries(resolve_product("小米空气净化器4lite"))

    assert "ASUS ROG PG27UQR" in rog_queries
    assert "华硕 ROG PG27UQR" in rog_queries
    assert "盛色 N50PRO6" in sanc_queries
    assert "戴森 bp04" in dyson_queries
    assert "Xiaomi Smart Air Purifier 4 Lite" in xiaomi_queries


def test_supported_locales_and_market_filtering():
    assert len(SUPPORTED_LOCALES) == 15
    product = resolve_product("ROG PG27UQR")
    japanese = build_query_plan(product, locale="ja")
    hindi = build_query_plan(product, locale="hi")
    japanese_platforms = {item["id"] for item in japanese["platforms"]}
    hindi_platforms = {item["id"] for item in hindi["platforms"]}

    assert "rakuten" in japanese_platforms
    assert "mercari" in japanese_platforms
    assert "taobao" not in japanese_platforms
    assert "flipkart" in hindi_platforms
    assert "taobao" not in hindi_platforms


def test_high_coverage_plan_prioritizes_community_and_market_sites():
    plan = build_query_plan(resolve_product("AOC 24G2"))
    first_queries = plan["queries"][:20]

    assert any(query.startswith("site:reddit.com") for query in first_queries)
    assert any(query.startswith("site:youtube.com") for query in first_queries)
    assert any(query.startswith("site:amazon.com") for query in first_queries)
    assert plan["market_site_query_count"] > 0


def test_parse_page_keeps_gallery_and_lazy_loaded_image_links():
    page = parse_page(
        """
        <html><head><title>AOC 24G2 review</title></head><body>
          <img data-srcset="/img/a.jpg 1x, /img/a-large.jpg 2x">
          <a href="/gallery/24g2-large.jpg">gallery</a>
          <a data-full="/upload/24g2-owner.png">owner</a>
        </body></html>
        """,
        "https://example.com/review",
    )

    assert "https://example.com/img/a.jpg" in page.image_urls
    assert "https://example.com/img/a-large.jpg" in page.image_urls
    assert "https://example.com/gallery/24g2-large.jpg" in page.image_urls
    assert "https://example.com/upload/24g2-owner.png" in page.image_urls


def test_parse_page_finds_same_site_related_review_and_gallery_pages():
    page = parse_page(
        """
        <a href="/product/24g2/gallery">gallery</a>
        <a href="https://other.example/review/24g2">other host</a>
        <a href="/about">about</a>
        """,
        "https://example.com/product/24g2",
    )

    assert "https://example.com/product/24g2/gallery" in page.related_page_urls
    assert "https://other.example/review/24g2" not in page.related_page_urls


def test_parse_page_extracts_embedded_media_manifest_urls():
    page = parse_page(
        """
        <script>
          window.__DATA__ = {"gallery": ["https:\\/\\/cdn.example.com\\/photo\\/24g2-owner.jpg"]};
        </script>
        """,
        "https://example.com/review/24g2",
    )

    assert "https://cdn.example.com/photo/24g2-owner.jpg" in page.embedded_image_urls


def test_unknown_brand_is_not_given_fake_translations():
    product = resolve_product("UnknownBrand X-123")
    plan = build_query_plan(product)
    assert plan["locales"] == ["en", "zh"]
    assert not any("未知品牌" in query for query in plan["queries"])
