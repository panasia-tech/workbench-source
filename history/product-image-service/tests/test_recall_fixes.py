"""同款图召回/匹配修复(2026-11-11):URL 去重、型号边界、扩展图库放行。"""
from app.models import Candidate
from app.parser import normalize_image_url_key, resolve_product
from app.pipeline import ImageService


def _service(tmp_path):
    from app.db import Database

    from .conftest import make_settings

    settings = make_settings(tmp_path)
    return ImageService(settings, Database(settings.database_path), None)


def test_url_key_keeps_identity_params_and_drops_resize_signature():
    a = normalize_image_url_key("https://img.example.com/a.jpg?id=42&w=800&OSSAccessKeyId=k")
    b = normalize_image_url_key("https://img.example.com/a.jpg?id=42&w=1200&Signature=s")
    c = normalize_image_url_key("https://img.example.com/a.jpg?id=43&w=800")
    assert a == b
    assert a != c


def test_model_match_allows_separator_but_not_longer_variant(tmp_path):
    service = _service(tmp_path)
    product = resolve_product("AOC 24G2")
    base = dict(image_url="https://x/a.jpg", page_url="https://x/p", provider="bing_public",
                source_domain="x", title="AOC 24G2 monitor")

    exact, _, reason = service.score_candidate(
        Candidate(**{**base, "title": "AOC 24 G2 monitor"}), product,
        "AOC 24 G2 monitor", {"width": 1200, "height": 800},
    )
    longer, _, _ = service.score_candidate(
        Candidate(**{**base, "title": "AOC 24G2Z monitor"}), product,
        "AOC 24G2Z monitor", {"width": 1200, "height": 800},
    )
    assert reason == "exact model evidence"
    assert exact > longer


def test_short_model_does_not_match_longer_variant(tmp_path):
    service = _service(tmp_path)
    product = resolve_product("AOC 4")
    candidate = Candidate(
        image_url="https://x/a.jpg", page_url="https://x/p", provider="bing_public",
        source_domain="x", title="AOC 4Lite monitor",
    )
    confidence, _, reason = service.score_candidate(
        candidate, product, "AOC 4Lite monitor", {"width": 1200, "height": 800},
    )
    assert reason == "near model variant"
    assert confidence < 0.96


def test_expanded_gallery_candidate_is_not_dropped_by_offtopic_prefilter(tmp_path):
    service = _service(tmp_path)
    product = resolve_product("AOC 24G2")
    candidate = Candidate(
        image_url="https://x/a.jpg", page_url="https://x/p", provider="bing_public",
        source_domain="x", title="图集", media_origin="embedded_media", query="AOC 24G2",
    )
    assert service.is_offtopic_candidate(candidate, product) is False


def test_space_separated_variant_suffix_is_not_exact(tmp_path):
    """24G2 Z / 24G2 SP / 24G2 V2 中间有空格也算不同型号，不能当 24G2 同款。"""
    service = _service(tmp_path)
    product = resolve_product("AOC 24G2")
    base = dict(
        image_url="https://x/a.jpg", page_url="https://x/p", provider="bing_public",
        source_domain="x",
    )
    for title in (
        "AOC 24G2 Z monitor",
        "AOC 24G2 SP monitor",
        "AOC 24G2 V2 monitor",
        "AOC 24G2-U monitor",
    ):
        confidence, _, reason = service.score_candidate(
            Candidate(**{**base, "title": title}), product, title,
            {"width": 1200, "height": 800},
        )
        assert reason == "near model variant", title
        assert confidence < 0.96, title


def test_common_spec_words_after_model_stay_exact(tmp_path):
    """24G2 monitor / for gaming / 165Hz / 重复品牌不是变体，不能误杀。"""
    service = _service(tmp_path)
    product = resolve_product("AOC 24G2")
    base = dict(
        image_url="https://x/a.jpg", page_url="https://x/p", provider="bing_public",
        source_domain="x",
    )
    for title in (
        "AOC 24G2 monitor",
        "AOC 24G2 for gaming",
        "AOC 24G2 165Hz monitor",
        "AOC 24G2 AOC",
    ):
        confidence, _, reason = service.score_candidate(
            Candidate(**{**base, "title": title}), product, title,
            {"width": 1200, "height": 800},
        )
        assert reason == "exact model evidence", title
        assert confidence >= 0.96, title
