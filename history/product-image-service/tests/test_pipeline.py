from __future__ import annotations

import io
import json

import httpx
from PIL import Image

from app.db import Database
from app.models import (
    Candidate,
    ReviewStatus,
    SearchTier,
    TaskLane,
    TaskStatus,
    resolve_task_lane,
)
from app.parser import resolve_product
from app.pipeline import ImageService

from .conftest import make_settings


def make_jpeg() -> bytes:
    image = Image.new("RGB", (800, 600), "white")
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


def test_task_lane_mapping_is_disjoint_and_canonical():
    assert resolve_task_lane(TaskStatus.queued) is TaskLane.good
    assert resolve_task_lane(TaskStatus.processing) is TaskLane.good
    assert resolve_task_lane(TaskStatus.completed, ReviewStatus.pending) is TaskLane.good
    assert resolve_task_lane(TaskStatus.completed, ReviewStatus.approved) is TaskLane.good
    assert resolve_task_lane(TaskStatus.failed) is TaskLane.bad
    assert resolve_task_lane(TaskStatus.completed, ReviewStatus.needs_changes) is TaskLane.bad
    assert resolve_task_lane(TaskStatus.cancelled) is TaskLane.history


def test_terminal_status_distinguishes_provider_outage_from_filtered_empty_result():
    status, error = ImageService.terminal_status_for_search(
        candidate_count=0,
        provider_failures={"bing_public": "PoolTimeout: temporary pool exhaustion"},
    )
    assert status == TaskStatus.failed
    assert "公开来源检索暂时失败" in error
    assert "bing_public" in error

    status, error = ImageService.terminal_status_for_search(
        candidate_count=0,
        provider_failures={},
    )
    assert status == TaskStatus.failed
    assert "没有找到可校验" in error

    status, error = ImageService.terminal_status_for_search(
        candidate_count=20,
        formal_count=20,
        provider_failures={"bing_public": "PoolTimeout: partial provider"},
    )
    assert status == TaskStatus.completed
    assert error == ""


def test_terminal_status_fails_when_candidates_have_no_usable_pool():
    status, error = ImageService.terminal_status_for_search(
        candidate_count=397,
        formal_count=0,
        preview_count=0,
        provider_failures={},
        rejection_reasons={"ssrf_blocked": 100},
    )

    assert status == TaskStatus.failed
    assert "未形成可用图片池" in error
    assert "安全地址校验拦截 100 个" in error


def test_failed_task_retry_requeues_and_preserves_history(tmp_path):
    settings = make_settings(tmp_path)
    settings.task_retry_limit = 2
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    database.create_task(
        "img_retry",
        "AOC 24G2",
        result_limit=20,
        progress_json=service.initial_progress(20),
    )
    database.update_task(
        "img_retry",
        status=TaskStatus.failed,
        count=0,
        images_json=[],
        diagnostics_json={"provider_failures": [{"provider": "bing_public"}]},
        progress_json={"phase": "failed", "percent": 100},
        error="公开来源检索暂时失败",
        finished_at="2026-08-30T00:00:00+00:00",
    )

    retried = service.retry_task("img_retry")
    assert retried is not None
    assert retried["status"] == TaskStatus.queued
    assert retried["count"] == 0
    assert retried["error"] is None
    assert json.loads(retried["images_json"]) == []
    diagnostics = json.loads(retried["diagnostics_json"])
    assert diagnostics["retry_count"] == 1
    assert diagnostics["retry_history"][0]["previous_error"] == "公开来源检索暂时失败"
    assert diagnostics["retry_history"][0]["provider_failures"][0]["provider"] == "bing_public"
    assert diagnostics["retry_history"][0]["previous_query"] == "AOC 24G2"
    assert diagnostics["retry_history"][0]["next_query"] == "AOC 24G2"
    assert diagnostics["retry_history"][0]["edited"] is False
    assert diagnostics["original_query"] == "AOC 24G2"
    assert len(diagnostics["retry_snapshots"]) == 1
    assert diagnostics["retry_snapshots"][0]["formal_count"] == 0
    assert json.loads(retried["progress_json"])["message"] == "已重新排队，等待第 1 次重试"

    database.update_task("img_retry", status=TaskStatus.failed, error="第二次失败")
    retried_again = service.retry_task("img_retry", query="ROG XG259CMS")
    assert retried_again is not None
    second_diagnostics = json.loads(retried_again["diagnostics_json"])
    assert second_diagnostics["retry_count"] == 2
    assert second_diagnostics["retry_history"][1]["previous_query"] == "AOC 24G2"
    assert second_diagnostics["retry_history"][1]["next_query"] == "ROG XG259CMS"
    assert second_diagnostics["retry_history"][1]["edited"] is True
    assert second_diagnostics["original_query"] == "AOC 24G2"
    assert len(second_diagnostics["retry_snapshots"]) == 2
    database.update_task("img_retry", status=TaskStatus.failed, error="第三次失败")
    try:
        service.retry_task("img_retry")
    except RuntimeError as exc:
        assert "最大重试次数" in str(exc)
    else:
        raise AssertionError("retry limit should reject the third retry")


def test_failed_task_retry_snapshots_existing_pools_before_clearing_active_result(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    database.create_task("img_retry_pool", "旧名称", result_limit=20, progress_json={})
    database.update_task(
        "img_retry_pool",
        status=TaskStatus.failed,
        count=1,
        images_json=[{"url": "/files/formal.jpg", "source_url": "https://example.com/formal"}],
        diagnostics_json={
            "fuzzy_previews": [{"url": "/files/fuzzy.jpg", "source_url": "https://example.com/fuzzy"}],
            "rejected_previews": [{"url": "/files/rejected.jpg", "source_url": "https://example.com/rejected"}],
        },
        progress_json={"phase": "failed", "percent": 100},
        error="旧结果待复核",
    )

    retried = service.retry_task("img_retry_pool", query="新名称")
    assert retried is not None
    assert json.loads(retried["images_json"]) == []
    diagnostics = json.loads(retried["diagnostics_json"])
    snapshot = diagnostics["retry_snapshots"][0]
    assert snapshot["query"] == "旧名称"
    assert snapshot["formal_count"] == 1
    assert snapshot["fuzzy_count"] == 1
    assert snapshot["rejected_count"] == 1


def test_queue_prioritises_retried_tasks(tmp_path):
    database = Database(tmp_path / "queue.sqlite3")
    database.create_task("normal", "普通任务", progress_json={"estimated_seconds": 60})
    database.create_task(
        "retry",
        "重试任务",
        progress_json={"estimated_seconds": 60, "retry_count": 1},
    )

    queued = database.list_tasks(statuses=["queued", "processing"], limit=10)
    assert [row["task_id"] for row in queued] == ["retry", "normal"]
    claimed = database.claim_next_task()
    assert claimed is not None
    assert claimed["task_id"] == "retry"

    status, error = ImageService.terminal_status_for_search(
        candidate_count=3,
        provider_failures={"bing_public": "PoolTimeout"},
    )
    assert status == TaskStatus.completed
    assert error == ""


def test_task_bucket_filters_before_limit_and_routes_review_issues(tmp_path):
    database = Database(tmp_path / "bucket.sqlite3")
    for task_id in ("normal-a", "normal-b", "normal-c"):
        database.create_task(task_id, task_id, progress_json={})
        database.update_task(task_id, status="completed", count=2, progress_json={"percent": 100})
    database.create_task("needs-review", "需处理任务", progress_json={})
    database.update_task(
        "needs-review",
        status="completed",
        count=2,
        review_status="needs_changes",
        review_note="发现杂图",
        progress_json={"percent": 100},
    )

    assert [row["task_id"] for row in database.list_task_bucket("bad", limit=1)] == [
        "needs-review"
    ]
    assert "needs-review" not in {
        row["task_id"] for row in database.list_task_bucket("good", limit=20)
    }
    database.update_task("needs-review", review_status="approved")
    assert "needs-review" in {
        row["task_id"] for row in database.list_task_bucket("good", limit=20)
    }


def test_terminal_status_allows_small_formal_pool_when_candidates_exist():
    status, error = ImageService.terminal_status_for_search(
        candidate_count=30,
        formal_count=4,
        provider_failures={},
    )
    assert status == TaskStatus.completed
    assert error == ""


def test_terminal_status_allows_fuzzy_or_rejected_previews_without_formal_images():
    status, error = ImageService.terminal_status_for_search(
        candidate_count=30,
        formal_count=0,
        preview_count=4,
        provider_failures={},
    )

    assert status == TaskStatus.completed
    assert error == ""


def test_search_policy_defaults_have_three_simple_tiers(tmp_path):
    database = Database(make_settings(tmp_path).database_path)
    policy = database.get_search_policy()
    assert set(item.value for item in policy.tiers) == {"strict", "balanced", "broad"}
    assert (
        policy.tiers[SearchTier.strict].confidence_threshold
        > policy.tiers[SearchTier.broad].confidence_threshold
    )


def test_search_strategy_labels_mark_rare_sku_expansion():
    assert ImageService.is_rare_sku(resolve_product("AOC 24G10ZNE")) is True
    assert ImageService.is_rare_sku(resolve_product("AOC 24G2")) is False
    assert ImageService.query_strategy_id("AOC 24G10ZNE review") == "S-02"
    assert ImageService.query_strategy_id("site:taobao.com AOC 24G10ZNE") == "S-03"
    assert set(ImageService.search_strategy_log()) == {
        "S-01",
        "S-02",
        "S-03",
        "S-04",
        "S-05",
        "S-06",
        "S-07",
        "S-08",
        "S-09",
        "S-10",
        "S-11",
        "S-12",
        "S-14",
        "S-13",
        "S-16",
        "S-17",
        "S-18",
        "S-19",
        "S-20",
        "S-21",
        "S-22",
        "S-23",
        "S-24",
        "S-25",
        "S-26",
        "S-27",
        "S-29",
        "S-30",
        "S-31",
        "S-32",
        "S-33",
        "S-34",
        "S-35",
    }


def test_target_preview_caps_are_separate_from_normal_caps(tmp_path):
    settings = make_settings(tmp_path)

    assert settings.max_fuzzy_previews == 500
    assert settings.max_rejected_previews == 300
    assert settings.target_max_fuzzy_previews == 12000
    assert settings.target_max_rejected_previews == 12000
    assert settings.deep_target_evaluation_multiplier == 30
    assert settings.target_ultra_evaluation_multiplier == 50
    assert settings.target_extreme_evaluation_multiplier == 80
    assert settings.target_mega_evaluation_multiplier == 120
    assert settings.target_max_evaluation_candidates == 12000
    assert settings.target_candidate_reservoir_multiplier == 200
    assert settings.target_second_hop_pages == 32
    assert settings.target_second_hop_related_pages == 32
    assert settings.target_second_hop_images_per_page == 60
    assert settings.target_multilingual_matrix_queries == 128
    assert settings.target_multilingual_matrix_domains == 24
    assert settings.target_multilingual_matrix_rounds == 8
    assert settings.target_family_query_queries == 96
    assert settings.target_family_query_domains == 24
    assert settings.target_family_query_rounds == 6
    assert settings.target_source_carousel_queries == 192
    assert settings.target_source_carousel_domains == 40
    assert settings.target_source_carousel_rounds == 4
    assert settings.target_broad_page_expansion_pages == 0
    assert settings.target_broad_page_images_per_page == 80
    assert settings.target_broad_related_page_limit == 0
    assert settings.target_fast_tail_evaluation_candidates == 1200


def test_target_candidate_reservoir_cap_expands_to_v19_limit(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())

    assert service.candidate_reservoir_cap(100, True) == 20000
    assert service.candidate_reservoir_cap(20, True) == 5000
    assert service.candidate_reservoir_cap(100, False) == 2000


def test_progress_snapshot_contains_live_phase_and_eta(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    database.create_task(
        "img_progress",
        "AOC 24G2",
        result_limit=100,
        progress_json=service.initial_progress(100),
    )
    claimed = database.claim_next_task()
    assert claimed is not None

    service.update_progress(
        "img_progress",
        phase="evaluating",
        phase_label="下载并校验图片",
        percent=50,
        completed=50,
        total=100,
        message="已校验 50/100 个候选",
    )
    progress = json.loads(database.get_task("img_progress")["progress_json"])
    assert progress["phase"] == "evaluating"
    assert progress["percent"] == 50.0
    assert progress["completed"] == 50
    assert progress["total"] == 100
    assert progress["eta_seconds"] >= 0


def test_v19_reservoir_stratifies_core_near_and_broad_candidates(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    product = resolve_product("AOC 24G10ZNE")
    candidates = [
        Candidate(
            image_url="https://images.example.com/core.jpg",
            provider="test",
            query="AOC 24G10ZNE review",
            title="AOC 24G10ZNE monitor",
        ),
        Candidate(
            image_url="https://images.example.com/near.jpg",
            provider="test",
            query="AOC 24G10 review",
            title="AOC 24G10 gaming monitor",
        ),
        Candidate(
            image_url="https://images.example.com/broad.jpg",
            provider="test",
            query="AOC monitor customer photo",
            title="gaming monitor customer photo",
        ),
    ]

    assert service.candidate_reservoir_bucket(candidates[0], product) == "core"
    assert service.candidate_reservoir_bucket(candidates[1], product) == "near"
    assert service.candidate_reservoir_bucket(candidates[2], product) == "broad"
    assert service.candidate_reservoir_bucket_counts(candidates, product) == {
        "core": 1,
        "near": 1,
        "broad": 1,
    }


def test_evaluation_batches_do_not_exceed_configured_limit(tmp_path):
    settings = make_settings(tmp_path)
    settings.evaluation_batch_size = 250
    candidates = list(range(300))
    batches = [
        candidates[start : min(start + settings.evaluation_batch_size, 300)]
        for start in range(0, 300, settings.evaluation_batch_size)
    ]

    assert [len(batch) for batch in batches] == [250, 50]
    assert sum(len(batch) for batch in batches) == 300


def test_near_model_candidate_goes_to_fuzzy_pool():
    candidate = Candidate(
        image_url="https://images.example.com/24g10ze.jpg",
        page_url="https://example.com/aoc-24g10ze",
        provider="test",
        source_domain="example.com",
        title="AOC 24G10ZE monitor",
    )

    pool = ImageService.rejected_pool(
        candidate,
        resolve_product("AOC 24G10ZNE"),
        "insufficient_model_evidence",
    )

    assert pool == "fuzzy"


def test_image_validation_accepts_large_enough_jpeg(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    import httpx

    service = ImageService(settings, database, httpx.AsyncClient())
    metadata = service.inspect_image(make_jpeg(), "image/jpeg")
    assert metadata["width"] == 800
    assert metadata["height"] == 600
    assert metadata["extension"] == "jpg"


def test_image_validation_rejects_small_image(tmp_path):
    settings = make_settings(tmp_path)
    settings.min_long_edge = 1000
    database = Database(settings.database_path)
    import httpx

    service = ImageService(settings, database, httpx.AsyncClient())
    try:
        service.inspect_image(make_jpeg(), "image/jpeg")
    except ValueError as exc:
        assert "long edge" in str(exc)
    else:
        raise AssertionError("small image should be rejected")


def test_image_validation_can_decode_small_image_for_rejected_preview(tmp_path):
    settings = make_settings(tmp_path)
    settings.min_long_edge = 1000
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())

    metadata = service.inspect_image(make_jpeg(), "image/jpeg", allow_small=True)

    assert metadata["width"] == 800
    assert metadata["height"] == 600


async def test_rejected_model_candidate_keeps_safe_preview(tmp_path):
    settings = make_settings(tmp_path)
    settings.allow_synthetic_dns = True
    database = Database(settings.database_path)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("image.jpg"):
            return httpx.Response(
                200,
                headers={"content-type": "image/jpeg"},
                content=make_jpeg(),
                request=request,
            )
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            text="<html><title>24G2 monitor</title></html>",
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ImageService(settings, database, client)
    result = await service.evaluate_candidate(
        Candidate(
            image_url="https://example.com/image.jpg",
            page_url="https://example.com/page",
            provider="test",
            source_domain="example.com",
            title="24G2 monitor",
            query="AOC 24G2",
        ),
        resolve_product("AOC 24G2"),
    )
    await client.aclose()

    assert result["rejected_reason"] == "insufficient_model_evidence"
    assert result["candidate"].query == "AOC 24G2"
    assert result["preview"]["metadata"]["width"] == 800


async def test_fast_tail_candidate_keeps_decoded_preview_without_page_fetch(tmp_path):
    settings = make_settings(tmp_path)
    settings.allow_synthetic_dns = True

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "image/jpeg"},
            content=make_jpeg(),
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    database = Database(settings.database_path)
    service = ImageService(settings, database, client)
    result = await service.evaluate_candidate(
        Candidate(
            image_url="https://example.com/wide-tail.jpg",
            page_url="https://example.com/should-not-be-fetched",
            provider="test",
            source_domain="example.com",
            title="AOC monitor customer photo",
            query="AOC monitor customer photo",
        ),
        resolve_product("AOC 24G10ZNE"),
        fast_tail=True,
    )
    await client.aclose()

    assert result["rejected_reason"] == "wide_tail_preview"
    assert result["fast_tail"] is True
    assert result["fast_tail_strategy"] == "S-32"
    assert result["preview"]["metadata"]["width"] == 800


def test_score_rejects_same_model_with_wrong_brand(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    candidate = Candidate(
        image_url="https://images.example.com/27g6h.jpg",
        page_url="https://example.com/hisense-27g6h",
        provider="bing_public",
        source_domain="example.com",
        title="Hisense N3G Pro 27G6H monitor",
    )
    metadata = {"width": 1200, "height": 800}
    confidence, score, reason = service.score_candidate(
        candidate,
        resolve_product("泰坦军团 27G6H"),
        service.candidate_evidence(candidate),
        metadata,
    )
    assert confidence == 0
    assert score == 0
    assert reason == "missing brand evidence"


def test_adaptive_fanout_reuses_near_model_and_discovered_domain(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    product = resolve_product("AOC 24G2")
    candidates = [
        Candidate(
            image_url="https://images.example.com/aoc-24g2u.jpg",
            page_url="https://example.com/aoc-24g2u-review",
            provider="bing_public",
            source_domain="example.com",
            title="AOC 24G2U owner review",
        )
    ]

    queries = service.build_adaptive_fanout_queries(product, candidates, ["AOC 24G2"])

    assert "aoc 24g2u review" in [item.casefold() for item in queries]
    assert any(item.startswith("site:example.com AOC 24G2") for item in queries)


def test_query_shape_fanout_generates_compact_sku_spellings(tmp_path):
    settings = make_settings(tmp_path)
    settings.query_shape_fanout_queries = 32
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())

    queries = service.build_query_shape_fanout_queries(
        resolve_product("AOC 24G10ZNE"),
        [],
        ["AOC 24G10ZNE review"],
    )

    lowered = [item.casefold() for item in queries]
    assert any("24 g 10 zne" in item for item in lowered)
    assert any("24g-10zne" in item for item in lowered)


def test_target_query_matrix_keeps_full_model_and_reuses_relevant_domains(tmp_path):
    settings = make_settings(tmp_path)
    settings.target_query_matrix_queries = 64
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    product = resolve_product("AOC 24G10ZNE")
    candidates = [
        Candidate(
            image_url="https://images.example.com/aoc-24g10zne.jpg",
            page_url="https://example.com/aoc-24g10zne-review",
            provider="bing_public",
            source_domain="example.com",
            title="AOC 24G10ZNE customer review photo",
        )
    ]

    queries = service.build_target_query_matrix(product, candidates, [])

    assert queries
    assert any("24g10zne" in item.casefold() for item in queries)
    assert all("aoc" in item.casefold() for item in queries)
    assert any(item.startswith("site:example.com AOC 24G10ZNE") for item in queries)


def test_multilingual_query_matrix_keeps_full_model_and_localized_intents(tmp_path):
    settings = make_settings(tmp_path)
    settings.target_multilingual_matrix_queries = 128
    settings.target_multilingual_matrix_domains = 24
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    product = resolve_product("AOC 24G10ZNE")
    candidates = [
        Candidate(
            image_url="https://images.example.com/aoc-24g10zne.jpg",
            page_url="https://example.com/aoc-24g10zne-review",
            provider="bing_public",
            source_domain="example.com",
            title="AOC 24G10ZNE customer review photo",
        )
    ]

    queries = service.build_multilingual_query_matrix(product, candidates, [])

    assert queries
    assert any(item.startswith("site:example.com") for item in queries)
    assert any("24g10zne" in item.casefold() for item in queries)
    assert any(term in item for item in queries for term in ("评测", "reseña", "レビュー"))


def test_visual_neighbor_matrix_uses_observed_model_family_for_fuzzy_recall(tmp_path):
    settings = make_settings(tmp_path)
    settings.target_family_query_queries = 96
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    product = resolve_product("AOC 24G10ZNE")
    candidates = [
        Candidate(
            image_url="https://images.example.com/aoc-24g11ze.jpg",
            page_url="https://example.com/aoc-24g11ze-review",
            provider="bing_public",
            source_domain="example.com",
            title="AOC 24G11ZE customer photo",
        )
    ]

    queries = service.build_visual_neighbor_query_matrix(product, candidates, [])

    assert queries
    assert any("24g1" in item.casefold() for item in queries)
    assert any(item.startswith("site:example.com") for item in queries)
    family_candidate = candidates[0].model_copy(update={"media_origin": "family_query"})
    assert service.rejected_pool(
        family_candidate, product, "insufficient_model_evidence"
    ) == "fuzzy"


def test_source_domain_carousel_reuses_broad_public_domains(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    product = resolve_product("AOC 24G10ZNE")
    candidates = [
        Candidate(
            image_url="https://example.com/aoc-monitor.jpg",
            page_url="https://example.com/aoc-gallery",
            source_domain="example.com",
            provider="bing_public",
            title="AOC gaming monitor customer photo",
            query="AOC monitor customer photo",
        )
    ]

    queries = service.build_source_domain_carousel_queries(product, candidates, [])

    assert queries
    assert any(item.startswith("site:example.com AOC") for item in queries)
    assert any("buyer photo" in item or "owner photo" in item for item in queries)


def test_broad_page_seed_requires_observed_brand_category_and_intent():
    product = resolve_product("AOC 24G10ZNE")
    seed = Candidate(
        image_url="https://example.com/monitor.jpg",
        page_url="https://example.com/gallery",
        provider="bing_public",
        source_domain="example.com",
        title="AOC gaming monitor customer photo",
        query="site:example.com AOC monitor customer photo",
    )
    unrelated = seed.model_copy(
        update={
            "image_url": "https://example.com/shoes.jpg",
            "page_url": "https://example.com/shoes",
            "title": "AOC shoes",
            "query": "AOC shoes",
        }
    )

    assert ImageService.is_broad_page_seed(seed, product) is True
    assert ImageService.is_broad_page_seed(unrelated, product) is False


async def test_broad_source_page_expansion_reads_public_html(tmp_path):
    settings = make_settings(tmp_path)
    settings.allow_synthetic_dns = True
    database = Database(settings.database_path)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gallery"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text=(
                    "<html><title>AOC gaming monitor customer gallery</title>"
                    "<img src='/photo.jpg'></html>"
                ),
                request=request,
            )
        return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=make_jpeg())

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ImageService(settings, database, client)
    seed = Candidate(
        image_url="https://example.com/seed.jpg",
        page_url="https://example.com/gallery",
        provider="bing_public",
        source_domain="example.com",
        title="AOC gaming monitor customer photo",
        query="AOC monitor customer photo",
    )
    expanded, related = await service.expand_source_pages(
        [seed],
        resolve_product("AOC 24G10ZNE"),
        max_pages=1,
        max_images_per_page=2,
        allow_broad_seeds=True,
    )
    await client.aclose()

    assert related == []
    assert len(expanded) == 1
    assert expanded[0].image_url == "https://example.com/photo.jpg"


def test_candidate_reservoir_prunes_after_preserving_unique_candidates(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    monkeypatch.setattr(service, "candidate_reservoir_cap", lambda _limit, _target: 3)
    candidates = [
        Candidate(
            image_url=f"https://images.example.com/{index}.jpg",
            provider="test",
            query=f"query-{index}",
        )
        for index in range(5)
    ]

    reservoir: list[Candidate] = []
    dropped = service.extend_candidate_reservoir(
        reservoir, candidates, resolve_product("AOC 24G2"), 100, True
    )

    assert len(reservoir) == 3
    assert dropped == 2


def test_blocked_domain_candidates_are_removed_before_pooling(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    service.blocked_domains = {"example.com"}
    service.blocked_domain_hits = {}
    additions = [
        Candidate(
            image_url="https://cdn.example.com/celebrity.jpg",
            page_url="https://www.example.com/gallery",
            source_domain="example.com",
            provider="test",
        ),
        Candidate(
            image_url="https://images.other.test/product.jpg",
            page_url="https://other.test/item",
            source_domain="other.test",
            provider="test",
        ),
    ]

    reservoir: list[Candidate] = []
    dropped = service.extend_candidate_reservoir(
        reservoir, additions, resolve_product("AOC 24G2"), 20, False
    )

    assert dropped == 0
    assert [item.image_url for item in reservoir] == [
        "https://images.other.test/product.jpg"
    ]
    assert service.blocked_domain_hits == {"example.com": 1}


def test_candidate_reservoir_keeps_new_wave_when_old_wave_exceeds_cap(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    monkeypatch.setattr(service, "candidate_reservoir_cap", lambda _limit, _target: 3)
    old = [
        Candidate(image_url=f"https://images.example.com/old-{index}.jpg", provider="test")
        for index in range(4)
    ]
    new = [
        Candidate(image_url=f"https://images.example.com/new-{index}.jpg", provider="test")
        for index in range(4)
    ]

    dropped = service.extend_candidate_reservoir(
        old, new, resolve_product("AOC 24G2"), 100, True
    )

    assert dropped == 5
    assert any("new-" in item.image_url for item in old)


def test_target_candidate_prioritization_interleaves_family_and_matrix_queries(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    candidates = [
        Candidate(
            image_url="https://images.example.com/base.jpg",
            provider="test",
            query="base",
        ),
        Candidate(
            image_url="https://images.example.com/family.jpg",
            provider="test",
            query="AOC 24g1 photo",
            media_origin="family_query",
        ),
        Candidate(
            image_url="https://images.example.com/matrix.jpg",
            provider="test",
            query="site:example.com AOC 24G10ZNE review",
        ),
    ]

    ordered = service.prioritize_target_candidates(
        candidates,
        {"site:example.com AOC 24G10ZNE review"},
        set(),
    )

    assert ordered[0].media_origin == "family_query"
    assert ordered[1].query.startswith("site:example.com")


def test_target_candidate_priority_keeps_core_queries_ahead_of_family_wave(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    candidates = [
        Candidate(
            image_url="https://images.example.com/base.jpg",
            provider="test",
            query="base",
        ),
        Candidate(
            image_url="https://images.example.com/family.jpg",
            provider="test",
            query="AOC 24g1 photo",
            media_origin="family_query",
        ),
        Candidate(
            image_url="https://images.example.com/matrix.jpg",
            provider="test",
            query="site:example.com AOC 24G10ZNE review",
        ),
    ]

    ordered = service.prioritize_target_candidates(
        candidates,
        {"site:example.com AOC 24G10ZNE review"},
        set(),
        target_mode=True,
    )

    assert ordered[0].query == "base"
    assert ordered[1].query.startswith("site:example.com")
    assert ordered[-1].media_origin == "family_query"


def test_image_url_variants_strip_known_thumbnail_markers(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())

    variants = service.image_url_variants(
        "https://images.example.com/photo._SL500_.jpg"
    )

    assert "https://images.example.com/photo.jpg" in variants


def test_family_fuzzy_pool_keeps_same_brand_size_category_candidate(tmp_path):
    settings = make_settings(tmp_path)
    database = Database(settings.database_path)
    service = ImageService(settings, database, httpx.AsyncClient())
    product = resolve_product("AOC 24G10ZNE")
    candidate = Candidate(
        image_url="https://images.example.com/aoc-24g4-monitor.jpg",
        provider="bing_public",
        title="AOC 24 inch gaming monitor display",
        source_domain="example.com",
    )

    assert service.rejected_pool(candidate, product, "insufficient_model_evidence") == "fuzzy"


def test_offtopic_search_hits_are_dropped_before_download(tmp_path):
    settings = make_settings(tmp_path)
    service = ImageService(settings, Database(settings.database_path), httpx.AsyncClient())
    product = resolve_product("苹果 MAGIC TRACKPAD 4")

    def hit(title: str, page_url: str) -> Candidate:
        return Candidate(
            image_url="https://img.example.com/a.jpg", page_url=page_url, title=title,
            provider="bing_public", source_type="search", query="q",
        )

    news = hit("中國觀察 : 大罷免慘敗", "https://www.stheadline.com/china-taiwan/3489876/")
    fruit = hit("新鲜的苹果水果高清图片下载", "https://699pic.com/tupian-600673494.html")
    review = hit("Apple Magic trackpad触控板评测", "https://post.smzdm.com/p/334540/")
    untitled = hit("", "https://example.com/p/1")
    candidates: list[Candidate] = []
    service.extend_candidate_reservoir(candidates, [news, fruit, review, untitled], product, 20, False)
    assert candidates == [review, untitled]
    assert service.offtopic_candidate_count == 2
