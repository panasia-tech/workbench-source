from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import mimetypes
import os
import re
import secrets
from datetime import UTC, datetime, timedelta
from math import ceil

import httpx
import imagehash
from PIL import Image, UnidentifiedImageError

from .adapters import AdapterRegistry, AdapterRun, platform_for_candidate
from .config import Settings
from .db import Database, utc_now
from .models import (
    Candidate,
    ImageResult,
    ProductIdentity,
    SearchTier,
    TaskStatus,
    default_search_policy,
)
from .orchestration import OrchestrationRegistry
from .parser import (
    brand_evidence_terms,
    build_queries,
    domain_of,
    normalize_image_url_key,
    official_domains,
    parse_page,
    resolve_product,
)
from .providers.registry import ProviderRegistry
from .quality import assess as assess_quality
from .query_planner import (
    build_query_plan,
    canonical_locale,
    compact_text,
    load_brand_catalog,
    load_market_catalog,
    normalize_text,
)
from .ssrf import SSRFBlocked, validate_public_url

logger = logging.getLogger(__name__)
# 型号对上的候选多看几倍再按上架图质量挑(水印、海报、拼图这些往后放)
QUALITY_HEADROOM = 3
QUALITY_WORKERS = 2

# 型号后面紧跟的短字母/字母+数字后缀多半是另一个型号：
# 24G2Z / 24G2 SP / 24G2 V2 / 24G2 PRO 都不是 24G2 的同款。
_MODEL_VARIANT_SUFFIXES = {
    "z", "sp", "u", "v", "e", "f", "p", "q", "s", "g", "x", "se", "ii",
    "pro", "plus", "max", "lite", "ultra", "elite", "oc",
}
# 这些是规格/常见词，不能当型号变体误杀：
# 24G2 monitor / 24G2 for gaming / 24G2 165Hz / 24G2 AOC 仍是同款。
_MODEL_BENIGN_SUFFIXES = {
    "a", "an", "and", "the", "for", "with", "of", "to", "in", "on", "new", "used",
    "led", "ips", "va", "hz", "pc", "ps", "tv", "hd", "fhd", "qhd", "uhd", "rgb",
    "ms", "dpi", "usb", "vga", "dp", "monitor", "gaming", "display", "screen",
    "inch", "series", "edition",
}


class ImageRejected(ValueError):
    pass


class ImageService:
    def __init__(self, settings: Settings, database: Database, client: httpx.AsyncClient):
        self.settings = settings
        self.database = database
        self.client = client
        self.registry = ProviderRegistry(settings, database, client)
        self.adapters = AdapterRegistry(
            self.registry,
            max_retries=settings.provider_retry_attempts,
            retry_backoff_seconds=settings.provider_retry_backoff_seconds,
        )
        self.orchestrator = OrchestrationRegistry(
            settings.orchestration_manifest_path, settings.orchestration_state_path
        )
        self.stop_event = asyncio.Event()
        self.worker_task: asyncio.Task[None] | None = None
        self.current_task: asyncio.Task[None] | None = None
        self.current_task_id: str | None = None
        self.cancel_requested: set[str] = set()
        self.blocked_domains: set[str] = set()
        self.blocked_domain_hits: dict[str, int] = {}
        self.offtopic_candidate_count = 0
        self.download_sem = asyncio.Semaphore(settings.download_concurrency)
        self.evidence_sem = asyncio.Semaphore(settings.download_concurrency)

    @staticmethod
    def estimate_task_seconds(limit: int, profile: str = "auto") -> int:
        """Return a conservative first estimate before live progress is available."""
        if profile == "listing":
            # 上架深抓：翻页、变体和页面扩展会让 40 张的目标比旧 20 张浅抓慢，
            # 但仍应控制在几分钟内，页面靠轮询消化。
            return 5 * 60
        if limit >= 500:
            return 60 * 60
        if limit >= 300:
            return 45 * 60
        if limit >= 100:
            return 30 * 60
        if limit >= 50:
            return 10 * 60
        return 3 * 60

    def initial_progress(self, limit: int, profile: str = "auto") -> dict[str, object]:
        estimate = self.estimate_task_seconds(limit, profile)
        return {
            "phase": "queued",
            "phase_label": "排队等待",
            "percent": 0,
            "completed": 0,
            "total": 0,
            "elapsed_seconds": 0,
            "estimated_seconds": estimate,
            "eta_seconds": estimate,
            "eta_at": None,
            "message": "等待前面的任务完成",
            "estimate_confidence": "low",
            "updated_at": utc_now(),
        }

    @staticmethod
    def elapsed_seconds(started_at: str | None, finished_at: str | None = None) -> float:
        if not started_at:
            return 0.0
        try:
            started = datetime.fromisoformat(started_at)
            ended = datetime.fromisoformat(finished_at) if finished_at else datetime.now(UTC)
            return max(0.0, (ended - started).total_seconds())
        except (TypeError, ValueError):
            return 0.0

    def search_batch_estimate(self, query_count: int, target_mode: bool) -> int:
        """Estimate the number of bounded provider batches for progress display."""
        budget = max(1, self.settings.provider_query_budget)
        batch_counts = [max(1, query_count)]
        if target_mode:
            batch_counts.extend(
                [
                    self.settings.adaptive_fanout_queries,
                    self.settings.query_shape_fanout_queries,
                    self.settings.target_query_matrix_queries,
                    self.settings.target_multilingual_matrix_queries,
                    self.settings.target_family_query_queries,
                    self.settings.target_source_carousel_queries,
                ]
            )
        return max(1, sum(ceil(count / budget) for count in batch_counts if count > 0))

    def update_progress(
        self,
        task_id: str,
        *,
        phase: str,
        phase_label: str,
        percent: float,
        message: str,
        completed: int = 0,
        total: int = 0,
    ) -> None:
        row = self.database.get_task(task_id)
        if not row or row["status"] != TaskStatus.processing:
            return
        try:
            progress = json.loads(row.get("progress_json", "{}") or "{}")
        except json.JSONDecodeError:
            progress = {}
        elapsed = self.elapsed_seconds(row.get("started_at"))
        percent = max(0.0, min(99.0, float(percent)))
        estimate = max(
            1.0,
            float(
                progress.get("estimated_seconds")
                or self.estimate_task_seconds(row["result_limit"], row.get("profile", "auto"))
            ),
        )
        if percent >= 5 and elapsed > 0:
            estimate = max(estimate, elapsed / (percent / 100.0))
        eta = max(0.0, estimate - elapsed)
        eta_at = (
            (datetime.now(UTC) + timedelta(seconds=eta)).isoformat() if eta > 0 else None
        )
        progress.update(
            {
                "phase": phase,
                "phase_label": phase_label,
                "percent": round(percent, 1),
                "completed": max(0, int(completed)),
                "total": max(0, int(total)),
                "elapsed_seconds": round(elapsed, 1),
                "estimated_seconds": round(estimate, 1),
                "eta_seconds": round(eta, 1),
                "eta_at": eta_at,
                "message": message,
                "estimate_confidence": "medium" if percent >= 10 else "low",
                "updated_at": utc_now(),
            }
        )
        self.database.update_task_if_status(task_id, TaskStatus.processing, progress_json=progress)

    @staticmethod
    def _terminal_progress(row: dict[str, object], phase: str, label: str, message: str) -> dict[str, object]:
        try:
            progress = json.loads(str(row.get("progress_json", "{}") or "{}"))
        except json.JSONDecodeError:
            progress = {}
        finished_at = utc_now()
        progress.update(
            {
                "phase": phase,
                "phase_label": label,
                "percent": 100 if phase in {"completed", "failed"} else progress.get("percent", 0),
                "eta_seconds": 0,
                "eta_at": None,
                "elapsed_seconds": round(
                    ImageService.elapsed_seconds(row.get("started_at"), finished_at), 1
                ),
                "message": message,
                "updated_at": finished_at,
            }
        )
        return progress

    @staticmethod
    def terminal_status_for_search(
        *,
        candidate_count: int,
        provider_failures: dict[str, str],
        formal_count: int | None = None,
        preview_count: int = 0,
        rejection_reasons: dict[str, int] | None = None,
    ) -> tuple[TaskStatus, str]:
        """Finish after a real search; formal/candidate split is reviewed separately.

        A formal-image count is deliberately not a completion gate. A task with
        usable fuzzy/rejected previews is complete enough for an operator to
        classify those images, while a provider outage or an entirely unusable
        candidate set remains failed.
        """
        actual_formal_count = candidate_count if formal_count is None else formal_count
        usable_preview_count = max(0, int(preview_count or 0))
        if actual_formal_count > 0 or usable_preview_count > 0:
            return TaskStatus.completed, ""
        if provider_failures:
            details = "；".join(
                f"{name}: {message}" for name, message in provider_failures.items()
            )
            return (
                TaskStatus.failed,
                f"公开来源检索暂时失败，未能获取候选图片。{details}",
            )
        if candidate_count > 0:
            reason_labels = {
                "ssrf_blocked": "安全地址校验拦截",
                "download_error": "图片下载失败",
                "invalid_image": "图片格式无法识别",
                "image long edge is below minimum": "图片尺寸不足",
                "insufficient_model_evidence": "型号证据不足",
                "image exceeds pixel limit": "图片尺寸超出限制",
            }
            details = []
            for reason, count in sorted(
                (rejection_reasons or {}).items(),
                key=lambda item: (-int(item[1] or 0), str(item[0])),
            )[:3]:
                details.append(f"{reason_labels.get(reason, reason)} {int(count or 0)} 个")
            suffix = "；" + "、".join(details) if details else ""
            return (
                TaskStatus.failed,
                f"候选图片均未形成可用图片池（原始候选 {candidate_count} 个{suffix}）。"
                "请调整检索名称或稍后重试。",
            )
        return TaskStatus.failed, "本轮没有找到可校验的候选图片。"

    def cancel_task(self, task_id: str) -> dict[str, object] | None:
        row = self.database.get_task(task_id)
        if not row:
            return None
        status = row["status"]
        if status in {TaskStatus.completed, TaskStatus.failed, TaskStatus.cancelled}:
            return row
        if status == TaskStatus.processing and self.current_task_id != task_id:
            raise RuntimeError("task is not controlled by the active worker")
        if status not in {TaskStatus.queued, TaskStatus.processing}:
            raise RuntimeError(f"task cannot be cancelled from status {status}")
        now = utc_now()
        try:
            progress = json.loads(row.get("progress_json", "{}") or "{}")
        except json.JSONDecodeError:
            progress = {}
        progress.update(
            {
                "phase": "cancelled",
                "phase_label": "已取消",
                "eta_seconds": 0,
                "eta_at": None,
                "elapsed_seconds": round(self.elapsed_seconds(row.get("started_at"), now), 1),
                "message": "已由用户取消",
                "updated_at": now,
            }
        )
        cancelled = self.database.update_task_if_status(
            task_id,
            status,
            status=TaskStatus.cancelled,
            error="task cancelled by user",
            progress_json=progress,
            finished_at=now,
        )
        if not cancelled:
            return self.database.get_task(task_id)
        if status == TaskStatus.processing:
            self.cancel_requested.add(task_id)
            if self.current_task and not self.current_task.done():
                self.current_task.cancel()
        return self.database.get_task(task_id)

    def retry_task(self, task_id: str, query: str | None = None) -> dict[str, object] | None:
        """Requeue a failed task for a fresh provider search.

        A retry gets the same task identity (and therefore the same batch row),
        but starts a fresh active result so the next run cannot mix old and new
        images. The previous formal/fuzzy/rejected pools are retained in a
        bounded ``retry_snapshots`` history for operator preview.
        """
        row = self.database.get_task(task_id)
        if not row:
            return None
        if row["status"] != TaskStatus.failed:
            raise RuntimeError("只有检索失败的任务可以重试")
        try:
            diagnostics = json.loads(row.get("diagnostics_json", "{}") or "{}")
        except (TypeError, json.JSONDecodeError):
            diagnostics = {}
        if not isinstance(diagnostics, dict):
            diagnostics = {}
        history = diagnostics.get("retry_history", [])
        if not isinstance(history, list):
            history = []
        if len(history) >= self.settings.task_retry_limit:
            raise RuntimeError(
                f"该任务已达到最大重试次数（{self.settings.task_retry_limit} 次）"
            )
        current_query = str(row.get("query") or "").strip()
        retry_query = current_query if query is None else " ".join(str(query).split())
        if len(retry_query) < 2:
            raise ValueError("重新搜索名称至少需要 2 个字符")
        original_query = str(row.get("original_query") or current_query).strip()
        try:
            previous_images = json.loads(row.get("images_json", "[]") or "[]")
        except (TypeError, json.JSONDecodeError):
            previous_images = []
        if not isinstance(previous_images, list):
            previous_images = []
        previous_fuzzy = diagnostics.get("fuzzy_previews", [])
        previous_rejected = diagnostics.get("rejected_previews", [])
        if not isinstance(previous_fuzzy, list):
            previous_fuzzy = []
        if not isinstance(previous_rejected, list):
            previous_rejected = []
        snapshots = diagnostics.get("retry_snapshots", [])
        if not isinstance(snapshots, list):
            snapshots = []
        snapshots = [item for item in snapshots if isinstance(item, dict)]
        snapshots.append(
            {
                "attempt": len(history) + 1,
                "captured_at": utc_now(),
                "query": current_query,
                "status": str(row.get("status") or "failed"),
                "formal_images": previous_images,
                "fuzzy_previews": previous_fuzzy,
                "rejected_previews": previous_rejected,
                "formal_count": len(previous_images),
                "fuzzy_count": len(previous_fuzzy),
                "rejected_count": len(previous_rejected),
            }
        )
        diagnostics["retry_snapshots"] = snapshots[-max(1, self.settings.task_retry_limit) :]
        history = [
            *history,
            {
                "attempt": len(history) + 1,
                "previous_status": str(row.get("status") or "failed"),
                "previous_error": row.get("error") or "未记录错误原因",
                "previous_query": current_query,
                "next_query": retry_query,
                "edited": retry_query != current_query,
                "provider_failures": diagnostics.get("provider_failures", []),
                "candidate_count": diagnostics.get("candidate_count", 0),
                "formal_count": int(row.get("count") or 0),
                "at": utc_now(),
            },
        ]
        diagnostics["retry_history"] = history
        diagnostics["retry_count"] = len(history)
        diagnostics["original_query"] = original_query
        progress = self.initial_progress(
            int(row.get("result_limit") or 20), str(row.get("profile") or "auto")
        )
        progress.update(
            {
                "phase_label": "等待重试",
                "message": f"已重新排队，等待第 {len(history)} 次重试",
                "retry_count": len(history),
            }
        )
        return self.database.requeue_failed_task(
            task_id,
            query=retry_query,
            progress_json=progress,
            diagnostics_json=diagnostics,
        )

    async def start(self) -> None:
        self.worker_task = asyncio.create_task(self.worker_loop())

    async def stop(self) -> None:
        self.stop_event.set()
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
        if self.worker_task:
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass

    def create_task(
        self,
        query: str,
        refresh: bool = False,
        image_mode: str = "all",
        limit: int = 20,
        platforms: list[str] | None = None,
        locale: str | None = None,
        batch_id: str | None = None,
        batch_row: int | None = None,
        batch_spu: str = "",
        assignee: str = "",
        search_tier: str = SearchTier.balanced.value,
        profile: str = "auto",
        min_results: int = 0,
        recall_version: int = 1,
    ) -> str:
        if not refresh and batch_id is None:
            cached = self.database.find_recent_completed_task(
                query,
                self.settings.cache_ttl_seconds,
                image_mode=image_mode,
                result_limit=limit,
                platforms=platforms,
                locale=canonical_locale(locale),
                search_tier=search_tier,
                profile=profile,
                min_results=min_results,
                recall_version=recall_version,
            )
            if cached:
                return cached["task_id"]
        task_id = f"img_{secrets.token_urlsafe(12)}"
        self.database.create_task(
            task_id,
            query,
            image_mode=image_mode,
            result_limit=limit,
            platforms=platforms,
            locale=canonical_locale(locale),
            progress_json=self.initial_progress(limit, profile),
            batch_id=batch_id,
            batch_row=batch_row,
            batch_spu=batch_spu,
            assignee=assignee,
            search_tier=search_tier,
            profile=profile,
            min_results=min_results,
            recall_version=recall_version,
        )
        return task_id

    def create_batch(
        self,
        filename: str,
        items: list[dict[str, object]],
        *,
        image_mode: str = "all",
        limit: int = 20,
        locale: str | None = None,
        assignee: str = "",
        search_tier: str = SearchTier.balanced.value,
    ) -> str:
        batch_id = f"batch_{secrets.token_urlsafe(12)}"
        self.database.create_batch(
            batch_id,
            filename,
            len(items),
            result_limit=limit,
                image_mode=image_mode,
                locale=canonical_locale(locale),
                search_tier=search_tier,
        )
        for item in items:
            query = " ".join(str(item.get("query") or "").split())
            if not query:
                continue
            self.create_task(
                query,
                refresh=True,
                image_mode=image_mode,
                limit=limit,
                locale=locale,
                batch_id=batch_id,
                batch_row=int(item.get("row_number") or 0),
                batch_spu=str(item.get("spu") or ""),
                assignee=assignee,
                search_tier=search_tier,
            )
        return batch_id

    async def worker_loop(self) -> None:
        while not self.stop_event.is_set():
            row = self.database.claim_next_task()
            if row:
                self.current_task_id = row["task_id"]
                self.current_task = asyncio.create_task(
                    self.process_task(
                        row["task_id"],
                        row["query"],
                        row.get("image_mode", "all"),
                        row.get("result_limit", 20),
                        json.loads(row.get("platforms_json", "[]") or "[]"),
                        row.get("locale"),
                        row.get("search_tier", SearchTier.balanced.value),
                        row.get("profile", "auto"),
                        int(row.get("min_results") or 0),
                        int(row.get("recall_version") or 1),
                    )
                )
                try:
                    await self.current_task
                except asyncio.CancelledError:
                    task_row = self.database.get_task(row["task_id"]) or row
                    if row["task_id"] in self.cancel_requested or task_row["status"] == TaskStatus.cancelled:
                        self.cancel_requested.discard(row["task_id"])
                        continue
                    finished_at = utc_now()
                    self.database.update_task(
                        row["task_id"],
                        status=TaskStatus.failed,
                        error="task cancelled during service shutdown",
                        finished_at=finished_at,
                        progress_json=self._terminal_progress(
                            task_row, "failed", "已中止", "服务正在关闭"
                        ),
                    )
                    raise
                except Exception as exc:  # Keep the worker alive for later tasks.
                    logger.exception("task %s failed", row["task_id"])
                    task_row = self.database.get_task(row["task_id"]) or row
                    finished_at = utc_now()
                    self.database.update_task(
                        row["task_id"],
                        status=TaskStatus.failed,
                        error=f"{type(exc).__name__}: {exc}",
                        finished_at=finished_at,
                        progress_json=self._terminal_progress(
                            task_row, "failed", "失败", "检索任务失败"
                        ),
                    )
                finally:
                    self.current_task = None
                    self.current_task_id = None
            else:
                try:
                    await asyncio.wait_for(
                        self.stop_event.wait(), timeout=self.settings.task_poll_seconds
                    )
                except TimeoutError:
                    pass

    async def process_task(
        self,
        task_id: str,
        query: str,
        image_mode: str = "all",
        limit: int = 20,
        platforms: list[str] | None = None,
        locale: str | None = None,
        search_tier: str = SearchTier.balanced.value,
        profile: str = "auto",
        min_results: int = 0,
        recall_version: int = 1,
    ) -> None:
        previous_diagnostics: dict[str, object] = {}
        existing_task = self.database.get_task(task_id)
        if existing_task:
            try:
                parsed_diagnostics = json.loads(
                    existing_task.get("diagnostics_json", "{}") or "{}"
                )
            except (TypeError, json.JSONDecodeError):
                parsed_diagnostics = {}
            if isinstance(parsed_diagnostics, dict):
                previous_diagnostics = parsed_diagnostics
        brand_catalog = load_brand_catalog(self.settings.brand_catalog_path)
        market_catalog = load_market_catalog(self.settings.market_catalog_path)
        policy = self.database.get_search_policy()
        self.blocked_domains = {
            str(item.get("domain") or "").strip().lower()
            for item in self.database.list_blocked_domains()
            if item.get("domain")
        }
        self.blocked_domain_hits = {}
        self.offtopic_candidate_count = 0
        try:
            tier = SearchTier(str(search_tier or SearchTier.balanced.value))
        except ValueError:
            tier = SearchTier.balanced
        tier_policy = policy.tiers.get(tier) or policy.tiers.get(SearchTier.balanced)
        if tier_policy is None:
            tier_policy = default_search_policy().tiers[SearchTier.balanced]
        product = resolve_product(query, catalog=brand_catalog)
        query_plan = build_query_plan(
            product,
            locale=locale,
            requested_platforms=platforms,
            brand_catalog=brand_catalog,
            market_catalog=market_catalog,
        )
        queries = list(query_plan["queries"])
        if not queries:
            queries = build_queries(product, locale=locale)
        self.database.update_task(task_id, brand=product.brand, model=product.model)
        self.update_progress(
            task_id,
            phase="planning",
            phase_label="准备检索",
            percent=5,
            message="查询计划已生成，准备访问公开来源",
        )
        candidates: list[Candidate] = []
        reservoir_dropped = 0
        orchestration_plan = self.orchestrator.plan(query)
        if platforms:
            orchestration_plan["platforms"] = [
                item for item in orchestration_plan["platforms"] if item["id"] in platforms
            ]
        if locale:
            eligible_ids = {item["id"] for item in query_plan["platforms"]}
            orchestration_plan["platforms"] = [
                item for item in orchestration_plan["platforms"] if item["id"] in eligible_ids
            ]
        orchestration_plan["market_locale"] = query_plan["requested_locale"]
        orchestration_plan["market_platforms"] = query_plan["platforms"]
        orchestration_plan["skipped_market_platforms"] = query_plan["skipped_platforms"]
        diagnostics: dict[str, object] = {
            "queries": queries,
            "query_plan": query_plan,
            "providers": {},
            "rejected": 0,
            "image_mode": image_mode,
            "limit": limit,
            "profile": profile,
            "min_results": min_results,
            "recall_version": recall_version,
            "search_tier": tier.value,
            "search_policy_version": policy.version,
            "search_policy": tier_policy.model_dump(mode="json"),
            "blocked_domains": sorted(self.blocked_domains),
            "locale": canonical_locale(locale),
            "query_budget": self.settings.provider_query_budget,
            "bing_pages_per_query": self.registry.bing_pages_per_query(),
            "target_bing_pages_per_query": self.settings.target_bing_pages_per_query,
            "target_bing_tail_pages_per_query": self.settings.target_bing_tail_pages_per_query,
            "max_query_rounds": self.settings.max_query_rounds,
            "rare_sku_extra_query_rounds": self.settings.rare_sku_extra_query_rounds,
            "bulk_result_extra_query_rounds": self.settings.bulk_result_extra_query_rounds,
            "adaptive_fanout_queries": self.settings.adaptive_fanout_queries,
            "adaptive_fanout_domains": self.settings.adaptive_fanout_domains,
            "query_shape_fanout_queries": self.settings.query_shape_fanout_queries,
            "target_query_matrix_queries": self.settings.target_query_matrix_queries,
            "target_query_matrix_domains": self.settings.target_query_matrix_domains,
            "target_query_matrix_rounds": self.settings.target_query_matrix_rounds,
            "target_multilingual_matrix_queries": self.settings.target_multilingual_matrix_queries,
            "target_multilingual_matrix_domains": self.settings.target_multilingual_matrix_domains,
            "target_multilingual_matrix_rounds": self.settings.target_multilingual_matrix_rounds,
            "target_family_query_queries": self.settings.target_family_query_queries,
            "target_family_query_domains": self.settings.target_family_query_domains,
            "target_family_query_rounds": self.settings.target_family_query_rounds,
            "target_source_carousel_queries": self.settings.target_source_carousel_queries,
            "target_source_carousel_domains": self.settings.target_source_carousel_domains,
            "target_source_carousel_rounds": self.settings.target_source_carousel_rounds,
            "target_broad_page_expansion_pages": self.settings.target_broad_page_expansion_pages,
            "target_broad_page_images_per_page": self.settings.target_broad_page_images_per_page,
            "target_broad_related_page_limit": self.settings.target_broad_related_page_limit,
            "max_evaluation_candidates": self.settings.max_evaluation_candidates,
            "target_evaluation_multiplier": self.settings.target_evaluation_multiplier,
            "deep_target_evaluation_multiplier": self.settings.deep_target_evaluation_multiplier,
            "target_ultra_evaluation_multiplier": self.settings.target_ultra_evaluation_multiplier,
            "target_extreme_evaluation_multiplier": self.settings.target_extreme_evaluation_multiplier,
            "target_mega_evaluation_multiplier": self.settings.target_mega_evaluation_multiplier,
            "target_max_evaluation_candidates": self.settings.target_max_evaluation_candidates,
            "target_fast_tail_evaluation_candidates": self.settings.target_fast_tail_evaluation_candidates,
            "target_candidate_reservoir_multiplier": self.settings.target_candidate_reservoir_multiplier,
            "page_expansion_pages": self.settings.page_expansion_pages,
            "page_expansion_images_per_page": self.settings.page_expansion_images_per_page,
            "deep_source_expansion_pages": self.settings.deep_source_expansion_pages,
            "deep_source_expansion_images_per_page": (
                self.settings.deep_source_expansion_images_per_page
            ),
            "related_page_expansion_pages": self.settings.related_page_expansion_pages,
            "target_second_hop_pages": self.settings.target_second_hop_pages,
            "target_second_hop_related_pages": self.settings.target_second_hop_related_pages,
            "target_second_hop_images_per_page": self.settings.target_second_hop_images_per_page,
            "embedded_media_urls": self.settings.embedded_media_urls,
            "image_url_variant_candidates": self.settings.image_url_variant_candidates,
            "max_fuzzy_previews": self.settings.max_fuzzy_previews,
            "max_rejected_previews": self.settings.max_rejected_previews,
            "target_max_fuzzy_previews": self.settings.target_max_fuzzy_previews,
            "target_max_rejected_previews": self.settings.target_max_rejected_previews,
            "orchestration": orchestration_plan,
            "adapters": self.adapters.describe(),
            "retry_history": previous_diagnostics.get("retry_history", []),
            "retry_count": len(previous_diagnostics.get("retry_history", []))
            if isinstance(previous_diagnostics.get("retry_history", []), list)
            else 0,
            "retry_snapshots": previous_diagnostics.get("retry_snapshots", []),
        }
        strategy_log = self.search_strategy_log()
        listing_profile = profile == "listing"
        # listing 是给上架选图的深抓档：它不要求 limit>=50 才开翻页/变体/扩展。
        deep_recall = listing_profile or limit >= 50
        diagnostics["listing_profile"] = listing_profile
        diagnostics["deep_recall"] = deep_recall
        target_preview_mode = limit >= 100
        fuzzy_preview_limit = (
            self.settings.target_max_fuzzy_previews
            if target_preview_mode
            else self.settings.max_fuzzy_previews
        )
        rejected_preview_limit = (
            self.settings.target_max_rejected_previews
            if target_preview_mode
            else self.settings.max_rejected_previews
        )
        diagnostics["target_preview_mode"] = target_preview_mode
        diagnostics["active_fuzzy_preview_limit"] = fuzzy_preview_limit
        diagnostics["active_rejected_preview_limit"] = rejected_preview_limit
        if target_preview_mode:
            strategy_log["S-29"]["preview_capacity"] = (
                fuzzy_preview_limit + rejected_preview_limit
            )
            strategy_log["S-30"]["candidate_capacity"] = self.candidate_reservoir_cap(
                limit, target_preview_mode
            )
            strategy_log["S-31"]["candidate_capacity"] = self.candidate_reservoir_cap(
                limit, target_preview_mode
            )
        self.registry.configure_recall_mode(listing=listing_profile, target=target_preview_mode)
        if target_preview_mode:
            strategy_log["S-18"]["enabled"] = True
            strategy_log["S-19"]["enabled"] = True
            strategy_log["S-20"]["enabled"] = True
            strategy_log["S-21"]["enabled"] = True
            strategy_log["S-22"]["enabled"] = True
            strategy_log["S-23"]["enabled"] = True
            strategy_log["S-24"]["enabled"] = True
            strategy_log["S-25"]["enabled"] = True
            strategy_log["S-26"]["enabled"] = True
            strategy_log["S-27"]["enabled"] = True
            strategy_log["S-29"]["enabled"] = True
            strategy_log["S-30"]["enabled"] = True
            strategy_log["S-31"]["enabled"] = True
            strategy_log["S-32"]["enabled"] = True
            strategy_log["S-33"]["enabled"] = True
            strategy_log["S-34"]["enabled"] = True
            strategy_log["S-35"]["enabled"] = True
        diagnostics["bing_pages_per_query"] = self.registry.bing_pages_per_query()
        query_budget = self.settings.provider_query_budget
        target_candidate_count = max(50, min(limit * 5, 2500))
        natural_rounds = max(1, ceil(len(queries) / query_budget))
        initial_rounds = min(natural_rounds, self.settings.max_query_rounds)
        rare_sku = self.is_rare_sku(product)
        bulk_result = limit >= 300
        rare_extra_rounds = self.settings.rare_sku_extra_query_rounds if rare_sku else 0
        bulk_extra_rounds = self.settings.bulk_result_extra_query_rounds if bulk_result else 0
        planned_rounds = initial_rounds
        if (rare_sku or bulk_result) and limit >= 50:
            planned_rounds = min(
                natural_rounds,
                initial_rounds + rare_extra_rounds + bulk_extra_rounds,
            )
        if listing_profile:
            # listing 至少两轮：第一轮拿主查询，第二轮补品牌别名/意图词，避免 20 张浅抓。
            planned_rounds = max(planned_rounds, 2)
        elif limit < 50:
            planned_rounds = 1
        diagnostics["rare_sku_detected"] = rare_sku
        diagnostics["bulk_result_mode"] = bulk_result
        diagnostics["initial_query_rounds"] = initial_rounds
        diagnostics["extra_query_rounds"] = max(0, planned_rounds - initial_rounds)
        search_progress = {
            "completed": 0,
            "total": self.search_batch_estimate(len(queries), target_preview_mode),
        }
        provider_failures: dict[str, str] = {}

        async def run_adapter_batch(batch: list[str]) -> list[AdapterRun]:
            adapter_runs = await self.adapters.run_all(
                product,
                batch,
                max_parallel=self.orchestrator.summary()["max_parallel_platforms"],
            )
            for run in adapter_runs:
                if run.state.value in {"degraded", "rate_limited"} and not run.candidates:
                    provider_failures.setdefault(run.name, run.message)
            search_progress["completed"] += 1
            completed = int(search_progress["completed"])
            total = int(search_progress["total"])
            self.update_progress(
                task_id,
                phase="searching",
                phase_label="检索公开来源",
                percent=5 + min(40, 40 * completed / max(1, total)),
                completed=completed,
                total=total,
                message=f"已完成第 {completed}/{total} 批来源检索，正在整理候选",
            )
            return adapter_runs

        eligible_market_ids = {item["id"] for item in query_plan["platforms"]}
        requested_platform_ids = set(platforms or [])
        query_rounds: list[dict[str, object]] = []
        for round_index in range(planned_rounds):
            start = round_index * query_budget
            batch = queries[start : start + query_budget]
            if not batch:
                break
            extra_round_index = round_index - initial_rounds
            if extra_round_index < 0:
                forced_strategy = ""
            elif extra_round_index < rare_extra_rounds:
                forced_strategy = "S-04"
            else:
                forced_strategy = "S-06"
            strategy_ids = set()
            for query_item in batch:
                strategy_id = forced_strategy or self.query_strategy_id(query_item)
                strategy_ids.add(strategy_id)
                strategy_log[strategy_id]["queries"] += 1
            adapter_runs = await run_adapter_batch(batch)
            round_candidates = 0
            round_accepted = 0
            for run in adapter_runs:
                self.database.set_provider_status(run.name, run.state.value, run.message)
                accepted_candidates = []
                for candidate in run.candidates:
                    candidate_platform = platform_for_candidate(candidate)
                    if (
                        requested_platform_ids
                        and candidate_platform not in requested_platform_ids
                        and candidate_platform != "web_search"
                    ):
                        continue
                    if (
                        locale
                        and candidate_platform != "web_search"
                        and candidate_platform not in eligible_market_ids
                    ):
                        continue
                    accepted_candidates.append(candidate)
                    strategy_id = (
                        self.pagination_strategy_id(candidate)
                        if candidate.media_origin == "search_pagination"
                        else forced_strategy or self.query_strategy_id(candidate.query)
                    )
                    strategy_log[strategy_id]["candidates"] += 1
                    if candidate.media_origin == "search_pagination":
                        strategy_ids.add("S-14")
                provider_diagnostics = diagnostics["providers"].setdefault(
                    run.name,
                    {
                        "state": run.state.value,
                        "message": run.message,
                        "rounds": 0,
                        "candidates": 0,
                        "accepted_candidates": 0,
                    },
                )
                provider_diagnostics.update(
                    {
                        "state": run.state.value,
                        "message": run.message,
                        "rounds": int(provider_diagnostics["rounds"]) + 1,
                        "candidates": int(provider_diagnostics["candidates"])
                        + len(run.candidates),
                        "accepted_candidates": int(provider_diagnostics["accepted_candidates"])
                        + len(accepted_candidates),
                    }
                )
                round_candidates += len(run.candidates)
                round_accepted += len(accepted_candidates)
                reservoir_dropped += self.extend_candidate_reservoir(
                    candidates, accepted_candidates, product, limit, target_preview_mode
                )
            query_rounds.append(
                {
                    "round": round_index + 1,
                    "query_count": len(batch),
                    "candidate_count": round_candidates,
                    "accepted_candidate_count": round_accepted,
                    "strategy_ids": sorted(strategy_ids),
                }
            )
            if len(self.unique_candidates(candidates)) >= target_candidate_count:
                break
        diagnostics["query_rounds"] = query_rounds
        diagnostics["executed_query_count"] = sum(item["query_count"] for item in query_rounds)

        # S-07 uses the first waves as a map: it derives near-model spellings and
        # newly discovered source domains, then asks the providers for a bounded
        # second look. This is intentionally separate from formal evidence so a
        # useful but ambiguous listing can increase the fuzzy/rejected pools
        # without weakening the formal pool.
        adaptive_queries = self.build_adaptive_fanout_queries(product, candidates, queries)
        diagnostics["adaptive_fanout_query_count"] = len(adaptive_queries)
        adaptive_rounds = 0
        shape_queries: list[str] = []
        shape_query_set: set[str] = set()
        if adaptive_queries and (deep_recall or rare_sku):
            adaptive_batches = [
                adaptive_queries[index : index + query_budget]
                for index in range(0, len(adaptive_queries), query_budget)
            ]
            max_adaptive_rounds = 2 if limit >= 300 else 1
            for adaptive_batch in adaptive_batches[:max_adaptive_rounds]:
                strategy_log["S-07"]["queries"] += len(adaptive_batch)
                adapter_runs = await run_adapter_batch(adaptive_batch)
                round_candidates = 0
                round_accepted = 0
                for run in adapter_runs:
                    self.database.set_provider_status(run.name, run.state.value, run.message)
                    accepted_candidates = []
                    for candidate in run.candidates:
                        candidate_platform = platform_for_candidate(candidate)
                        if (
                            requested_platform_ids
                            and candidate_platform not in requested_platform_ids
                            and candidate_platform != "web_search"
                        ):
                            continue
                        if (
                            locale
                            and candidate_platform != "web_search"
                            and candidate_platform not in eligible_market_ids
                        ):
                            continue
                        accepted_candidates.append(candidate)
                    provider_diagnostics = diagnostics["providers"].setdefault(
                        run.name,
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": 0,
                            "candidates": 0,
                            "accepted_candidates": 0,
                        },
                    )
                    provider_diagnostics.update(
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": int(provider_diagnostics["rounds"]) + 1,
                            "candidates": int(provider_diagnostics["candidates"])
                            + len(run.candidates),
                            "accepted_candidates": int(
                                provider_diagnostics["accepted_candidates"]
                            )
                            + len(accepted_candidates),
                        }
                    )
                    round_candidates += len(run.candidates)
                    round_accepted += len(accepted_candidates)
                    for candidate in accepted_candidates:
                        if candidate.media_origin == "search_pagination":
                            strategy_log[self.pagination_strategy_id(candidate)]["candidates"] += 1
                        else:
                            strategy_log["S-07"]["candidates"] += 1
                    reservoir_dropped += self.extend_candidate_reservoir(
                        candidates, accepted_candidates, product, limit, target_preview_mode
                    )
                adaptive_rounds += 1
                query_rounds.append(
                    {
                        "round": len(query_rounds) + 1,
                        "query_count": len(adaptive_batch),
                        "candidate_count": round_candidates,
                        "accepted_candidate_count": round_accepted,
                        "strategy_ids": ["S-07"],
                    }
                )
            diagnostics["queries"] = list(dict.fromkeys([*queries, *adaptive_queries]))
        diagnostics["adaptive_fanout_rounds"] = adaptive_rounds
        diagnostics["executed_query_count"] = sum(item["query_count"] for item in query_rounds)

        # S-17 expands model spellings and reuses domains already discovered by
        # the first waves. It is target-mode only: the extra search is intended
        # to enlarge the fuzzy/rejected reservoirs, while formal scoring stays
        # unchanged.
        shape_queries = self.build_query_shape_fanout_queries(
            product, candidates, [*queries, *adaptive_queries]
        )
        shape_query_set = set(shape_queries)
        diagnostics["query_shape_fanout_query_count"] = len(shape_queries)
        shape_rounds = 0
        if shape_queries and limit >= 100:
            shape_batches = [
                shape_queries[index : index + query_budget]
                for index in range(0, len(shape_queries), query_budget)
            ]
            max_shape_rounds = 2 if limit >= 300 else 1
            for shape_batch in shape_batches[:max_shape_rounds]:
                strategy_log["S-17"]["queries"] += len(shape_batch)
                adapter_runs = await run_adapter_batch(shape_batch)
                round_candidates = 0
                round_accepted = 0
                round_strategy_ids = {"S-17"}
                for run in adapter_runs:
                    self.database.set_provider_status(run.name, run.state.value, run.message)
                    accepted_candidates = []
                    for candidate in run.candidates:
                        candidate_platform = platform_for_candidate(candidate)
                        if (
                            requested_platform_ids
                            and candidate_platform not in requested_platform_ids
                            and candidate_platform != "web_search"
                        ):
                            continue
                        if (
                            locale
                            and candidate_platform != "web_search"
                            and candidate_platform not in eligible_market_ids
                        ):
                            continue
                        accepted_candidates.append(candidate)
                    provider_diagnostics = diagnostics["providers"].setdefault(
                        run.name,
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": 0,
                            "candidates": 0,
                            "accepted_candidates": 0,
                        },
                    )
                    provider_diagnostics.update(
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": int(provider_diagnostics["rounds"]) + 1,
                            "candidates": int(provider_diagnostics["candidates"])
                            + len(run.candidates),
                            "accepted_candidates": int(
                                provider_diagnostics["accepted_candidates"]
                            )
                            + len(accepted_candidates),
                        }
                    )
                    round_candidates += len(run.candidates)
                    round_accepted += len(accepted_candidates)
                    for candidate in accepted_candidates:
                        if candidate.media_origin == "search_pagination":
                            pagination_strategy = self.pagination_strategy_id(candidate)
                            strategy_log[pagination_strategy]["candidates"] += 1
                            round_strategy_ids.add(pagination_strategy)
                        else:
                            strategy_log["S-17"]["candidates"] += 1
                    reservoir_dropped += self.extend_candidate_reservoir(
                        candidates, accepted_candidates, product, limit, target_preview_mode
                    )
                shape_rounds += 1
                query_rounds.append(
                    {
                        "round": len(query_rounds) + 1,
                        "query_count": len(shape_batch),
                        "candidate_count": round_candidates,
                        "accepted_candidate_count": round_accepted,
                        "strategy_ids": sorted(round_strategy_ids),
                    }
                )
            diagnostics["queries"] = list(
                dict.fromkeys([*queries, *adaptive_queries, *shape_queries])
            )
        diagnostics["query_shape_fanout_rounds"] = shape_rounds
        diagnostics["executed_query_count"] = sum(item["query_count"] for item in query_rounds)

        # S-23 keeps the complete brand and model in every query row while
        # cross-matching already relevant source domains with buyer-intent
        # terms. It is target-only and bounded by provider/query round caps.
        matrix_queries = self.build_target_query_matrix(
            product, candidates, [*queries, *adaptive_queries, *shape_queries]
        )
        matrix_query_set = set(matrix_queries)
        diagnostics["target_query_matrix_query_count"] = len(matrix_queries)
        matrix_rounds = 0
        if matrix_queries and limit >= 100:
            matrix_batches = [
                matrix_queries[index : index + query_budget]
                for index in range(0, len(matrix_queries), query_budget)
            ]
            max_matrix_rounds = (
                6 if limit >= 300 else self.settings.target_query_matrix_rounds
            )
            for matrix_batch in matrix_batches[:max_matrix_rounds]:
                strategy_log["S-23"]["queries"] += len(matrix_batch)
                adapter_runs = await run_adapter_batch(matrix_batch)
                round_candidates = 0
                round_accepted = 0
                round_strategy_ids = {"S-23"}
                for run in adapter_runs:
                    self.database.set_provider_status(run.name, run.state.value, run.message)
                    accepted_candidates = []
                    for candidate in run.candidates:
                        candidate_platform = platform_for_candidate(candidate)
                        if (
                            requested_platform_ids
                            and candidate_platform not in requested_platform_ids
                            and candidate_platform != "web_search"
                        ):
                            continue
                        if (
                            locale
                            and candidate_platform != "web_search"
                            and candidate_platform not in eligible_market_ids
                        ):
                            continue
                        accepted_candidates.append(candidate)
                    provider_diagnostics = diagnostics["providers"].setdefault(
                        run.name,
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": 0,
                            "candidates": 0,
                            "accepted_candidates": 0,
                        },
                    )
                    provider_diagnostics.update(
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": int(provider_diagnostics["rounds"]) + 1,
                            "candidates": int(provider_diagnostics["candidates"])
                            + len(run.candidates),
                            "accepted_candidates": int(
                                provider_diagnostics["accepted_candidates"]
                            )
                            + len(accepted_candidates),
                        }
                    )
                    round_candidates += len(run.candidates)
                    round_accepted += len(accepted_candidates)
                    for candidate in accepted_candidates:
                        if candidate.media_origin == "search_pagination":
                            pagination_strategy = self.pagination_strategy_id(candidate)
                            strategy_log[pagination_strategy]["candidates"] += 1
                            round_strategy_ids.add(pagination_strategy)
                        else:
                            strategy_log["S-23"]["candidates"] += 1
                    reservoir_dropped += self.extend_candidate_reservoir(
                        candidates, accepted_candidates, product, limit, target_preview_mode
                    )
                matrix_rounds += 1
                query_rounds.append(
                    {
                        "round": len(query_rounds) + 1,
                        "query_count": len(matrix_batch),
                        "candidate_count": round_candidates,
                        "accepted_candidate_count": round_accepted,
                        "strategy_ids": sorted(round_strategy_ids),
                    }
                )
            diagnostics["queries"] = list(
                dict.fromkeys(
                    [*queries, *adaptive_queries, *shape_queries, *matrix_queries]
                )
            )
        diagnostics["target_query_matrix_rounds_executed"] = matrix_rounds
        diagnostics["executed_query_count"] = sum(item["query_count"] for item in query_rounds)

        # S-24 adds multilingual buyer-intent terms and broader relevant-domain
        # coverage, while every query still contains a complete model form.
        multilingual_queries = self.build_multilingual_query_matrix(
            product,
            candidates,
            [*queries, *adaptive_queries, *shape_queries, *matrix_queries],
        )
        multilingual_query_set = set(multilingual_queries)
        diagnostics["target_multilingual_matrix_query_count"] = len(multilingual_queries)
        multilingual_rounds = 0
        if multilingual_queries and limit >= 100:
            multilingual_batches = [
                multilingual_queries[index : index + query_budget]
                for index in range(0, len(multilingual_queries), query_budget)
            ]
            max_multilingual_rounds = (
                10 if limit >= 300 else self.settings.target_multilingual_matrix_rounds
            )
            for multilingual_batch in multilingual_batches[:max_multilingual_rounds]:
                strategy_log["S-24"]["queries"] += len(multilingual_batch)
                adapter_runs = await run_adapter_batch(multilingual_batch)
                round_candidates = 0
                round_accepted = 0
                round_strategy_ids = {"S-24"}
                for run in adapter_runs:
                    self.database.set_provider_status(run.name, run.state.value, run.message)
                    accepted_candidates = []
                    for candidate in run.candidates:
                        candidate_platform = platform_for_candidate(candidate)
                        if (
                            requested_platform_ids
                            and candidate_platform not in requested_platform_ids
                            and candidate_platform != "web_search"
                        ):
                            continue
                        if (
                            locale
                            and candidate_platform != "web_search"
                            and candidate_platform not in eligible_market_ids
                        ):
                            continue
                        accepted_candidates.append(candidate)
                    provider_diagnostics = diagnostics["providers"].setdefault(
                        run.name,
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": 0,
                            "candidates": 0,
                            "accepted_candidates": 0,
                        },
                    )
                    provider_diagnostics.update(
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": int(provider_diagnostics["rounds"]) + 1,
                            "candidates": int(provider_diagnostics["candidates"])
                            + len(run.candidates),
                            "accepted_candidates": int(
                                provider_diagnostics["accepted_candidates"]
                            )
                            + len(accepted_candidates),
                        }
                    )
                    round_candidates += len(run.candidates)
                    round_accepted += len(accepted_candidates)
                    for candidate in accepted_candidates:
                        if candidate.media_origin == "search_pagination":
                            pagination_strategy = self.pagination_strategy_id(candidate)
                            strategy_log[pagination_strategy]["candidates"] += 1
                            round_strategy_ids.add(pagination_strategy)
                        else:
                            strategy_log["S-24"]["candidates"] += 1
                    reservoir_dropped += self.extend_candidate_reservoir(
                        candidates, accepted_candidates, product, limit, target_preview_mode
                    )
                multilingual_rounds += 1
                query_rounds.append(
                    {
                        "round": len(query_rounds) + 1,
                        "query_count": len(multilingual_batch),
                        "candidate_count": round_candidates,
                        "accepted_candidate_count": round_accepted,
                        "strategy_ids": sorted(round_strategy_ids),
                    }
                )
            diagnostics["queries"] = list(
                dict.fromkeys(
                    [
                        *queries,
                        *adaptive_queries,
                        *shape_queries,
                        *matrix_queries,
                        *multilingual_queries,
                    ]
                )
            )
        diagnostics["target_multilingual_matrix_rounds_executed"] = multilingual_rounds
        diagnostics["executed_query_count"] = sum(item["query_count"] for item in query_rounds)

        # S-25 intentionally searches the discovered model family rather than
        # only the exact SKU. These candidates are tagged before evaluation so
        # brand-matching near models can remain visible in the fuzzy pool while
        # the formal score still requires the requested model evidence.
        family_queries = self.build_visual_neighbor_query_matrix(
            product,
            candidates,
            [
                *queries,
                *adaptive_queries,
                *shape_queries,
                *matrix_queries,
                *multilingual_queries,
            ],
        )
        diagnostics["target_family_query_query_count"] = len(family_queries)
        family_rounds = 0
        if family_queries and limit >= 100:
            family_batches = [
                family_queries[index : index + query_budget]
                for index in range(0, len(family_queries), query_budget)
            ]
            max_family_rounds = (
                10 if limit >= 300 else self.settings.target_family_query_rounds
            )
            for family_batch in family_batches[:max_family_rounds]:
                strategy_log["S-25"]["queries"] += len(family_batch)
                adapter_runs = await run_adapter_batch(family_batch)
                round_candidates = 0
                round_accepted = 0
                for run in adapter_runs:
                    self.database.set_provider_status(run.name, run.state.value, run.message)
                    accepted_candidates = []
                    for candidate in run.candidates:
                        candidate_platform = platform_for_candidate(candidate)
                        if (
                            requested_platform_ids
                            and candidate_platform not in requested_platform_ids
                            and candidate_platform != "web_search"
                        ):
                            continue
                        if (
                            locale
                            and candidate_platform != "web_search"
                            and candidate_platform not in eligible_market_ids
                        ):
                            continue
                        accepted_candidates.append(
                            candidate.model_copy(update={"media_origin": "family_query"})
                        )
                    provider_diagnostics = diagnostics["providers"].setdefault(
                        run.name,
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": 0,
                            "candidates": 0,
                            "accepted_candidates": 0,
                        },
                    )
                    provider_diagnostics.update(
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": int(provider_diagnostics["rounds"]) + 1,
                            "candidates": int(provider_diagnostics["candidates"])
                            + len(run.candidates),
                            "accepted_candidates": int(
                                provider_diagnostics["accepted_candidates"]
                            )
                            + len(accepted_candidates),
                        }
                    )
                    round_candidates += len(run.candidates)
                    round_accepted += len(accepted_candidates)
                    strategy_log["S-25"]["candidates"] += len(accepted_candidates)
                    reservoir_dropped += self.extend_candidate_reservoir(
                        candidates, accepted_candidates, product, limit, target_preview_mode
                    )
                family_rounds += 1
                query_rounds.append(
                    {
                        "round": len(query_rounds) + 1,
                        "query_count": len(family_batch),
                        "candidate_count": round_candidates,
                        "accepted_candidate_count": round_accepted,
                        "strategy_ids": ["S-25"],
                    }
                )
            diagnostics["queries"] = list(
                dict.fromkeys(
                    [
                        *queries,
                        *adaptive_queries,
                        *shape_queries,
                        *matrix_queries,
                        *multilingual_queries,
                        *family_queries,
                    ]
                )
            )
        diagnostics["target_family_query_rounds_executed"] = family_rounds
        diagnostics["executed_query_count"] = sum(item["query_count"] for item in query_rounds)

        # S-33 rotates through public source domains discovered in the broad
        # candidate waves. Earlier matrices require exact-model evidence before
        # a domain is eligible; this deliberately relaxes only the *query
        # discovery* gate so a page that mentions the brand/category can reveal
        # more public galleries, listings, or buyer-photo assets. Every result
        # still enters the same bounded reservoir and image/evidence pipeline.
        source_carousel_queries = self.build_source_domain_carousel_queries(
            product,
            candidates,
            [
                *queries,
                *adaptive_queries,
                *shape_queries,
                *matrix_queries,
                *multilingual_queries,
                *family_queries,
            ],
        )
        diagnostics["target_source_carousel_query_count"] = len(source_carousel_queries)
        source_carousel_rounds = 0
        if source_carousel_queries and limit >= 100:
            source_carousel_batches = [
                source_carousel_queries[index : index + query_budget]
                for index in range(0, len(source_carousel_queries), query_budget)
            ]
            for source_batch in source_carousel_batches[
                : self.settings.target_source_carousel_rounds
            ]:
                strategy_log["S-33"]["queries"] += len(source_batch)
                adapter_runs = await run_adapter_batch(source_batch)
                round_candidates = 0
                round_accepted = 0
                for run in adapter_runs:
                    self.database.set_provider_status(run.name, run.state.value, run.message)
                    accepted_candidates = []
                    for candidate in run.candidates:
                        candidate_platform = platform_for_candidate(candidate)
                        if (
                            requested_platform_ids
                            and candidate_platform not in requested_platform_ids
                            and candidate_platform != "web_search"
                        ):
                            continue
                        if (
                            locale
                            and candidate_platform != "web_search"
                            and candidate_platform not in eligible_market_ids
                        ):
                            continue
                        accepted_candidates.append(
                            candidate.model_copy(update={"media_origin": "source_domain_query"})
                        )
                    provider_diagnostics = diagnostics["providers"].setdefault(
                        run.name,
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": 0,
                            "candidates": 0,
                            "accepted_candidates": 0,
                        },
                    )
                    provider_diagnostics.update(
                        {
                            "state": run.state.value,
                            "message": run.message,
                            "rounds": int(provider_diagnostics["rounds"]) + 1,
                            "candidates": int(provider_diagnostics["candidates"])
                            + len(run.candidates),
                            "accepted_candidates": int(
                                provider_diagnostics["accepted_candidates"]
                            )
                            + len(accepted_candidates),
                        }
                    )
                    round_candidates += len(run.candidates)
                    round_accepted += len(accepted_candidates)
                    strategy_log["S-33"]["candidates"] += len(accepted_candidates)
                    reservoir_dropped += self.extend_candidate_reservoir(
                        candidates,
                        accepted_candidates,
                        product,
                        limit,
                        target_preview_mode,
                    )
                source_carousel_rounds += 1
                query_rounds.append(
                    {
                        "round": len(query_rounds) + 1,
                        "query_count": len(source_batch),
                        "candidate_count": round_candidates,
                        "accepted_candidate_count": round_accepted,
                        "strategy_ids": ["S-33"],
                    }
                )
            diagnostics["queries"] = list(
                dict.fromkeys(
                    [
                        *queries,
                        *adaptive_queries,
                        *shape_queries,
                        *matrix_queries,
                        *multilingual_queries,
                        *family_queries,
                        *source_carousel_queries,
                    ]
                )
            )
        diagnostics["target_source_carousel_rounds_executed"] = source_carousel_rounds
        diagnostics["executed_query_count"] = sum(item["query_count"] for item in query_rounds)

        diagnostics["candidate_reservoir_cap"] = self.candidate_reservoir_cap(
            limit, target_preview_mode
        )
        diagnostics["candidate_reservoir_dropped"] = reservoir_dropped
        unique_candidates = self.diversify_candidates(self.unique_candidates(candidates))
        self.update_progress(
            task_id,
            phase="expanding",
            phase_label="展开来源页面",
            percent=45,
            completed=0,
            total=0,
            message=f"已发现 {len(unique_candidates)} 个候选，正在读取公开来源页",
        )
        if deep_recall and self.settings.page_expansion_pages:
            deep_source_mode = limit >= 100
            expansion_pages = (
                self.settings.deep_source_expansion_pages
                if deep_source_mode
                else self.settings.page_expansion_pages
            )
            expansion_images_per_page = (
                self.settings.deep_source_expansion_images_per_page
                if deep_source_mode
                else self.settings.page_expansion_images_per_page
            )
            expanded_candidates, related_candidates = await self.expand_source_pages(
                unique_candidates,
                product,
                max_pages=expansion_pages,
                max_images_per_page=expansion_images_per_page,
                expand_related_pages=deep_source_mode,
            )
            second_hop_candidates: list[Candidate] = []
            if (
                deep_source_mode
                and related_candidates
                and self.settings.target_second_hop_pages > 0
            ):
                _repeat_candidates, raw_second_hop_candidates = await self.expand_source_pages(
                    related_candidates,
                    product,
                    max_pages=self.settings.target_second_hop_pages,
                    max_images_per_page=self.settings.target_second_hop_images_per_page,
                    expand_related_pages=True,
                    related_page_limit=self.settings.target_second_hop_related_pages,
                )
                second_hop_candidates = [
                    candidate.model_copy(update={"media_origin": "deep_related_page"})
                    for candidate in raw_second_hop_candidates
                ]
            reservoir_dropped += self.extend_candidate_reservoir(
                candidates,
                [*expanded_candidates, *related_candidates, *second_hop_candidates],
                product,
                limit,
                target_preview_mode,
            )
            diagnostics["page_expansion_candidates"] = len(expanded_candidates) + len(
                related_candidates
            )
            diagnostics["related_page_candidates"] = len(related_candidates)
            diagnostics["second_hop_candidates"] = len(second_hop_candidates)
            strategy_id = "S-09" if deep_source_mode else "S-05"
            strategy_log[strategy_id]["added_candidates"] = len(expanded_candidates)
            strategy_log["S-11"]["added_candidates"] = len(related_candidates)
            strategy_log["S-22"]["added_candidates"] = len(second_hop_candidates)
            embedded_candidates = [
                candidate
                for candidate in [*expanded_candidates, *related_candidates]
                if candidate.media_origin == "embedded_media"
            ]
            strategy_log["S-12"]["added_candidates"] = len(embedded_candidates)
            diagnostics["embedded_media_candidates"] = len(embedded_candidates)
            diagnostics["deep_source_expansion"] = deep_source_mode
            unique_candidates = self.diversify_candidates(self.unique_candidates(candidates))
        else:
            diagnostics["page_expansion_candidates"] = 0
            diagnostics["related_page_candidates"] = 0
            diagnostics["second_hop_candidates"] = 0
            diagnostics["embedded_media_candidates"] = 0
            diagnostics["deep_source_expansion"] = False
        broad_page_expanded: list[Candidate] = []
        broad_page_related: list[Candidate] = []
        if (
            target_preview_mode
            and self.settings.target_broad_page_expansion_pages > 0
            and self.settings.target_broad_page_images_per_page > 0
        ):
            # Do not revisit exact-model seeds already handled above. S-34 is
            # specifically for public pages discovered through broad/domain
            # queries whose model is absent from the search-engine caption.
            model_terms = [
                compact_text(product.model).lower(),
                *[compact_text(alias).lower() for alias in product.model_aliases],
            ]
            broad_seed_candidates = [
                candidate
                for candidate in unique_candidates
                if not any(
                    term
                    and term in compact_text(self.candidate_evidence(candidate)).lower()
                    for term in model_terms
                )
            ]
            raw_broad_expanded, raw_broad_related = await self.expand_source_pages(
                broad_seed_candidates,
                product,
                max_pages=self.settings.target_broad_page_expansion_pages,
                max_images_per_page=self.settings.target_broad_page_images_per_page,
                expand_related_pages=True,
                related_page_limit=self.settings.target_broad_related_page_limit,
                allow_broad_seeds=True,
            )
            broad_page_expanded = [
                candidate.model_copy(
                    update={
                        "media_origin": (
                            "broad_embedded_media"
                            if candidate.media_origin == "embedded_media"
                            else "broad_source_page"
                        )
                    }
                )
                for candidate in raw_broad_expanded
            ]
            broad_page_related = [
                candidate.model_copy(update={"media_origin": "broad_related_page"})
                for candidate in raw_broad_related
            ]
            reservoir_dropped += self.extend_candidate_reservoir(
                candidates,
                [*broad_page_expanded, *broad_page_related],
                product,
                limit,
                target_preview_mode,
            )
            diagnostics["broad_page_expansion_candidates"] = len(broad_page_expanded)
            diagnostics["broad_related_page_candidates"] = len(broad_page_related)
            strategy_log["S-34"]["added_candidates"] = len(broad_page_expanded) + len(
                broad_page_related
            )
            unique_candidates = self.diversify_candidates(self.unique_candidates(candidates))
        else:
            diagnostics["broad_page_expansion_candidates"] = 0
            diagnostics["broad_related_page_candidates"] = 0
        if deep_recall and self.settings.image_url_variant_candidates:
            variant_candidates = self.expand_image_url_variants(unique_candidates)
            reservoir_dropped += self.extend_candidate_reservoir(
                candidates, variant_candidates, product, limit, target_preview_mode
            )
            diagnostics["image_url_variant_candidates"] = len(variant_candidates)
            strategy_log["S-10"]["added_candidates"] = len(variant_candidates)
            unique_candidates = self.diversify_candidates(self.unique_candidates(candidates))
        else:
            diagnostics["image_url_variant_candidates"] = 0
        self.update_progress(
            task_id,
            phase="preparing_validation",
            phase_label="准备图片校验",
            percent=45,
            completed=len(unique_candidates),
            total=len(unique_candidates),
            message=f"候选整理完成，共 {len(unique_candidates)} 个，准备下载校验",
        )
        unique_candidates = self.prioritize_target_candidates(
            unique_candidates,
            matrix_query_set,
            multilingual_query_set,
            target_mode=target_preview_mode,
        )
        if target_preview_mode:
            strategy_log["S-26"]["candidates"] = len(unique_candidates)
            reservoir_buckets = self.candidate_reservoir_bucket_counts(
                unique_candidates, product
            )
            diagnostics["target_reservoir_buckets"] = reservoir_buckets
            strategy_log["S-31"]["retained_candidates"] = len(unique_candidates)
            strategy_log["S-31"]["core_candidates"] = reservoir_buckets["core"]
            strategy_log["S-31"]["near_candidates"] = reservoir_buckets["near"]
            strategy_log["S-31"]["broad_candidates"] = reservoir_buckets["broad"]
            strategy_log["S-32"]["fast_tail_candidates"] = reservoir_buckets["broad"]
        evaluation_candidate_cap = (
            self.settings.target_max_evaluation_candidates
            if target_preview_mode
            else self.settings.max_evaluation_candidates
        )
        diagnostics["active_max_evaluation_candidates"] = evaluation_candidate_cap
        first_pass_multiplier = int(tier_policy.first_pass_multiplier)
        base_check_limit = min(
            len(unique_candidates),
            evaluation_candidate_cap,
            max(50, limit * first_pass_multiplier),
        )
        diagnostics["first_pass_multiplier"] = first_pass_multiplier
        diagnostics["first_pass_evaluation_limit"] = base_check_limit
        target_check_limit = (
            min(
                len(unique_candidates),
                evaluation_candidate_cap,
                max(50, limit * self.settings.target_evaluation_multiplier),
            )
            if limit >= 100
            else base_check_limit
        )
        check_multiplier = (
            self.settings.target_mega_evaluation_multiplier
            if target_preview_mode
            else 10
            if limit >= 50
            else 5
        )
        deep_check_limit = min(
            len(unique_candidates),
            evaluation_candidate_cap,
            max(50, limit * self.settings.deep_target_evaluation_multiplier),
        )
        ultra_check_limit = min(
            len(unique_candidates),
            evaluation_candidate_cap,
            max(50, limit * self.settings.target_ultra_evaluation_multiplier),
        )
        extreme_check_limit = min(
            len(unique_candidates),
            evaluation_candidate_cap,
            max(50, limit * self.settings.target_extreme_evaluation_multiplier),
        )
        check_limit = min(
            len(unique_candidates),
            evaluation_candidate_cap,
            max(50, limit * check_multiplier),
        )
        diagnostics["evaluation_limit_base"] = base_check_limit
        diagnostics["target_evaluation_extra_candidates"] = max(
            0, target_check_limit - base_check_limit
        )
        diagnostics["deep_evaluation_limit"] = deep_check_limit
        diagnostics["deep_evaluation_extra_candidates"] = max(
            0, deep_check_limit - target_check_limit
        )
        diagnostics["ultra_evaluation_limit"] = ultra_check_limit
        diagnostics["ultra_evaluation_extra_candidates"] = max(
            0, ultra_check_limit - deep_check_limit
        )
        diagnostics["extreme_evaluation_limit"] = extreme_check_limit
        diagnostics["extreme_evaluation_extra_candidates"] = max(
            0, extreme_check_limit - ultra_check_limit
        )
        diagnostics["mega_evaluation_limit"] = check_limit
        diagnostics["mega_evaluation_extra_candidates"] = max(
            0, check_limit - extreme_check_limit
        )
        strategy_log["S-16"]["added_candidates"] = diagnostics[
            "target_evaluation_extra_candidates"
        ]
        strategy_log["S-21"]["added_candidates"] = diagnostics[
            "deep_evaluation_extra_candidates"
        ]
        strategy_log["S-27"]["added_candidates"] = max(
            0, ultra_check_limit - deep_check_limit
        )
        strategy_log["S-30"]["added_candidates"] = max(
            0, extreme_check_limit - ultra_check_limit
        )
        strategy_log["S-31"]["added_candidates"] = max(
            0, check_limit - extreme_check_limit
        )
        evaluation_candidates = unique_candidates[:check_limit]
        fast_tail_extra_candidates: list[Candidate] = []
        if target_preview_mode and self.settings.target_fast_tail_evaluation_candidates > 0:
            fast_tail_extra_candidates = [
                candidate
                for candidate in unique_candidates[check_limit:]
                if self.candidate_reservoir_bucket(candidate, product) == "broad"
            ][: self.settings.target_fast_tail_evaluation_candidates]
            evaluation_candidates.extend(fast_tail_extra_candidates)
            strategy_log["S-35"]["added_candidates"] = len(fast_tail_extra_candidates)
            strategy_log["S-35"]["fast_tail_candidates"] = len(fast_tail_extra_candidates)
        diagnostics["fast_tail_evaluation_extra_candidates"] = len(fast_tail_extra_candidates)
        diagnostics["fast_tail_evaluation_limit"] = len(evaluation_candidates)
        self.update_progress(
            task_id,
            phase="evaluating",
            phase_label="下载并校验图片",
            percent=45,
            completed=0,
            total=len(evaluation_candidates),
            message=f"已收集 {len(unique_candidates)} 个候选，准备逐张校验",
        )
        diagnostics["rejected"] = 0
        rejection_reasons: dict[str, int] = {}
        fuzzy_previews: list[dict[str, object]] = []
        rejected_previews: list[dict[str, object]] = []
        rejected_preview_hashes: list[tuple[str, imagehash.ImageHash]] = []
        valid_results: list[dict[str, object]] = []
        evaluated_count = 0
        validated_count = 0
        # Keep only a bounded score-sorted reservoir of valid items. Rejected
        # previews are persisted immediately, so thousands of decoded images do
        # not remain alive in the worker until the task finishes.
        retained_valid_limit = max(300, min(1000, limit * 3))
        fast_tail_extra_keys = {
            candidate.image_url.split("?", 1)[0].casefold()
            for candidate in fast_tail_extra_candidates
        }
        for start in range(0, len(evaluation_candidates), self.settings.evaluation_batch_size):
            batch = evaluation_candidates[
                start : min(start + self.settings.evaluation_batch_size, len(evaluation_candidates))
            ]
            batch_evaluated = await asyncio.gather(
                *(
                    self.evaluate_candidate(
                        candidate,
                        product,
                        image_mode,
                        confidence_threshold=float(tier_policy.confidence_threshold),
                        fast_tail_strategy=(
                            "S-35"
                            if candidate.image_url.split("?", 1)[0].casefold()
                            in fast_tail_extra_keys
                            else "S-32"
                        ),
                        fast_tail=(
                            target_preview_mode
                            and self.candidate_reservoir_bucket(candidate, product) == "broad"
                        ),
                    )
                    for candidate in batch
                ),
                return_exceptions=True,
            )
            evaluated_count += len(batch_evaluated)
            self.update_progress(
                task_id,
                phase="evaluating",
                phase_label="下载并校验图片",
                percent=45 + 45 * evaluated_count / max(1, len(evaluation_candidates)),
                completed=evaluated_count,
                total=len(evaluation_candidates),
                message=f"已校验 {evaluated_count}/{len(evaluation_candidates)} 个候选",
            )
            for item in batch_evaluated:
                if (
                    isinstance(item, dict)
                    and "candidate" in item
                    and "rejected_reason" not in item
                ):
                    metadata = item.get("metadata")
                    if isinstance(metadata, dict):
                        # The pHash is already computed by evaluate_candidate;
                        # the PIL image object is not needed during final store.
                        slim_item = dict(item)
                        slim_item["metadata"] = {
                            key: value for key, value in metadata.items() if key != "image"
                        }
                        valid_results.append(slim_item)
                        validated_count += 1
                        if target_preview_mode:
                            if start >= extreme_check_limit:
                                strategy_log["S-31"]["validated_images"] += 1
                            elif start >= ultra_check_limit:
                                strategy_log["S-30"]["validated_images"] += 1
                            elif start >= deep_check_limit:
                                strategy_log["S-27"]["validated_images"] += 1
                    continue
                diagnostics["rejected"] = int(diagnostics["rejected"]) + 1
                if isinstance(item, dict):
                    reason = str(item.get("rejected_reason", "rejected"))
                else:
                    reason = "rejected"
                rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1
                if isinstance(item, dict) and "candidate" in item:
                    if item.get("fast_tail"):
                        strategy_log[str(item.get("fast_tail_strategy", "S-32"))][
                            "validated_images"
                        ] += 1
                    preview = item.get("preview")
                    pool = self.rejected_pool(item["candidate"], product, reason)
                    pool_count = len(fuzzy_previews) if pool == "fuzzy" else len(rejected_previews)
                    pool_limit = (
                        fuzzy_preview_limit
                        if pool == "fuzzy"
                        else rejected_preview_limit
                    )
                    if isinstance(preview, dict) and pool_count < pool_limit:
                        preview_item = self.store_rejected_preview(
                            item["candidate"], reason, pool, preview, rejected_preview_hashes
                        )
                        if preview_item:
                            if pool == "fuzzy":
                                fuzzy_previews.append(preview_item)
                                strategy_id = (
                                    "S-34"
                                    if item["candidate"].media_origin.startswith("broad_")
                                    else "S-33"
                                    if item["candidate"].media_origin == "source_domain_query"
                                    else "S-25"
                                    if item["candidate"].media_origin == "family_query"
                                    else "S-24"
                                    if item["candidate"].query in multilingual_query_set
                                    else "S-13"
                                    if self.is_family_fuzzy_candidate(item["candidate"], product)
                                    else "S-08"
                                )
                                strategy_log[strategy_id]["fuzzy_previews"] += 1
                            else:
                                rejected_previews.append(preview_item)
                            if target_preview_mode:
                                pool_key = (
                                    "fuzzy_previews" if pool == "fuzzy" else "rejected_previews"
                                )
                                if item.get("fast_tail"):
                                    strategy_log[
                                        str(item.get("fast_tail_strategy", "S-32"))
                                    ][pool_key] += 1
                                if start < check_limit:
                                    if start >= extreme_check_limit:
                                        strategy_log["S-31"][pool_key] += 1
                                    elif start >= ultra_check_limit:
                                        strategy_log["S-30"][pool_key] += 1
                                    elif start >= deep_check_limit:
                                        strategy_log["S-27"][pool_key] += 1
                            if target_preview_mode:
                                strategy_log["S-18"]["preview_items"] += 1
                                strategy_log["S-18"][
                                    "fuzzy_previews" if pool == "fuzzy" else "rejected_previews"
                                ] += 1
            valid_results.sort(key=lambda candidate: float(candidate["score"]), reverse=True)
            del valid_results[retained_valid_limit:]
            del batch_evaluated
            # Evaluation is expensive. Once enough validated candidates exist,
            # later batches are unnecessary; diversity was already introduced
            # before this loop.
            if listing_profile and validated_count >= max(limit * 2, 80):
                break
            if limit < 50 and not listing_profile and validated_count >= limit * QUALITY_HEADROOM:
                break
        diagnostics["evaluation_limit"] = len(evaluation_candidates)
        diagnostics["evaluated_count"] = evaluated_count
        results: list[ImageResult] = []
        hashes: list[tuple[str, imagehash.ImageHash]] = []
        diagnostics["rejection_reasons"] = rejection_reasons
        diagnostics["fuzzy_preview_count"] = len(fuzzy_previews)
        diagnostics["rejected_preview_count"] = len(rejected_previews)
        diagnostics["safe_rejected_preview_count"] = len(fuzzy_previews) + len(rejected_previews)
        diagnostics["fuzzy_previews"] = fuzzy_previews
        diagnostics["rejected_previews"] = rejected_previews
        valid_results.sort(key=lambda item: item["score"], reverse=True)
        ordered_valid_results = self.diversify_results(valid_results)
        ordered_valid_results = await self.rank_by_listing_quality(
            ordered_valid_results, product, limit
        )
        for item in ordered_valid_results:
            if len(results) >= limit:
                break
            candidate = item["candidate"]
            content = item["content"]
            final_url = item["final_url"]
            metadata = item["metadata"]
            confidence = item["confidence"]
            score = item["score"]
            digest = item["digest"]
            phash = item["phash"]
            if digest in {item[0] for item in hashes} or any(
                (phash - item[1]) <= self.settings.phash_dedup_distance for item in hashes
            ):
                continue
            try:
                source_domain = candidate.source_domain or domain_of(
                    candidate.page_url or final_url
                )
                source_type = (
                    "official"
                    if source_domain in official_domains(product)
                    else candidate.source_type
                )
                extension = metadata["extension"]
                object_path = self.settings.storage_dir / f"{digest}.{extension}"
                if not object_path.exists():
                    object_path.write_bytes(content)
                self.database.put_object(
                    digest, str(object_path), extension, metadata["width"], metadata["height"]
                )
                results.append(
                    ImageResult(
                        url=f"{self.settings.public_base_url.rstrip('/')}/files/{digest}.{extension}",
                        source_url=candidate.page_url or final_url,
                        source_domain=source_domain,
                        source_type=source_type,
                        width=metadata["width"],
                        height=metadata["height"],
                        watermark=(
                            "detected"
                            if item.get("quality") and "水印" in item["quality"].flags
                            else self.detect_watermark(candidate)
                        ),
                        product_confidence=round(confidence, 4),
                        score=round(score, 2),
                        provider=candidate.provider,
                        platform=candidate.platform,
                        media_origin=candidate.media_origin,
                        image_class=candidate.image_class,
                        real_photo_confidence=candidate.real_photo_confidence,
                        review_url=candidate.review_url,
                        review_id=candidate.review_id,
                        **(item["quality"].as_dict() if item.get("quality") else {}),
                    )
                )
                result_strategy = (
                    "S-22"
                    if candidate.media_origin == "deep_related_page"
                    else "S-05"
                    if candidate.media_origin == "source_page"
                    else "S-12"
                    if candidate.media_origin == "embedded_media"
                    else "S-10"
                    if candidate.media_origin == "url_variant"
                    else "S-34"
                    if candidate.media_origin.startswith("broad_")
                    else "S-33"
                    if candidate.media_origin == "source_domain_query"
                    else "S-25"
                    if candidate.media_origin == "family_query"
                    else self.pagination_strategy_id(candidate)
                    if candidate.media_origin == "search_pagination"
                    else "S-24"
                    if candidate.query in multilingual_query_set
                    else "S-23"
                    if candidate.query in matrix_query_set
                    else "S-17"
                    if candidate.query in shape_query_set
                    else self.query_strategy_id(candidate.query)
                )
                strategy_log[result_strategy]["validated_images"] += 1
                hashes.append((digest, phash))
            except OSError as exc:
                diagnostics["rejected"] = int(diagnostics["rejected"]) + 1
                rejection_reasons["storage_error"] = rejection_reasons.get("storage_error", 0) + 1
                logger.debug("candidate storage rejected: %s", exc)
        if target_preview_mode:
            formal_digests = {item[0] for item in hashes}
            overflow_candidates = [
                item
                for item in ordered_valid_results
                if str(item.get("digest", "")) not in formal_digests
            ]
            diagnostics["formal_overflow_candidate_count"] = len(overflow_candidates)
            overflow_seen_hashes = [*rejected_preview_hashes, *hashes]
            for item in overflow_candidates:
                if len(fuzzy_previews) >= fuzzy_preview_limit:
                    break
                preview_item = self.store_rejected_preview(
                    item["candidate"],
                    "formal_pool_overflow",
                    "fuzzy",
                    {
                        "content": item["content"],
                        "final_url": item["final_url"],
                        "metadata": item["metadata"],
                    },
                    overflow_seen_hashes,
                )
                if preview_item:
                    fuzzy_previews.append(preview_item)
                    strategy_log["S-19"]["fuzzy_previews"] += 1
                    strategy_log["S-19"]["preview_items"] += 1
            diagnostics["formal_overflow_preview_count"] = strategy_log["S-19"][
                "preview_items"
            ]
        else:
            diagnostics["formal_overflow_candidate_count"] = 0
            diagnostics["formal_overflow_preview_count"] = 0
        results.sort(key=lambda item: item.score, reverse=True)
        diagnostics["candidate_count"] = len(candidates)
        diagnostics["blocked_candidate_count"] = sum(self.blocked_domain_hits.values())
        diagnostics["blocked_domain_hits"] = dict(sorted(self.blocked_domain_hits.items()))
        diagnostics["offtopic_candidate_count"] = self.offtopic_candidate_count
        diagnostics["provider_failures"] = [
            {"provider": name, "message": message}
            for name, message in provider_failures.items()
        ]
        diagnostics["candidate_reservoir_dropped"] = reservoir_dropped
        diagnostics["unique_candidate_count"] = len(unique_candidates)
        diagnostics["rejection_reasons"] = rejection_reasons
        diagnostics["fuzzy_preview_count"] = len(fuzzy_previews)
        diagnostics["rejected_preview_count"] = len(rejected_previews)
        diagnostics["safe_rejected_preview_count"] = len(fuzzy_previews) + len(rejected_previews)
        diagnostics["fuzzy_previews"] = fuzzy_previews
        diagnostics["rejected_previews"] = rejected_previews
        diagnostics["image_pools"] = {
            "formal": {"count": len(results)},
            "fuzzy": {"count": len(fuzzy_previews)},
            "rejected": {"count": len(rejected_previews)},
        }
        diagnostics["family_fuzzy_preview_count"] = strategy_log["S-13"]["fuzzy_previews"]
        diagnostics["search_strategy_log"] = list(strategy_log.values())
        diagnostics["official_domains"] = list(official_domains(product))
        diagnostics["quality_note"] = (
            "Only validated, model-evidenced images are returned; shortfalls are not padded."
        )
        diagnostics["formal_target"] = limit
        diagnostics["formal_shortfall"] = max(0, limit - len(results))
        diagnostics["manual_review_required"] = bool(fuzzy_previews or rejected_previews)
        self.update_progress(
            task_id,
            phase="finalizing",
            phase_label="整理结果",
            percent=95,
            completed=1,
            total=1,
            message="图片校验完成，正在保存结果",
        )
        task_row = self.database.get_task(task_id)
        if not task_row:
            return
        finished_at = utc_now()
        terminal_status, terminal_error = self.terminal_status_for_search(
            candidate_count=len(candidates),
            formal_count=len(results),
            preview_count=len(fuzzy_previews) + len(rejected_previews),
            provider_failures=provider_failures,
            rejection_reasons=rejection_reasons,
        )
        terminal_phase = "failed" if terminal_error else "completed"
        terminal_label = "未完成" if terminal_error else "已完成"
        terminal_message = terminal_error or (
            f"已整理 {len(results)} 张正式图片；"
            f"候选池 {len(fuzzy_previews) + len(rejected_previews)} 张待人工划分"
        )
        terminal_progress = self._terminal_progress(
            task_row, terminal_phase, terminal_label, terminal_message
        )
        if not self.database.update_task_if_status(
            task_id,
            TaskStatus.processing,
            status=terminal_status,
            count=len(results),
            images_json=[item.model_dump(mode="json") for item in results],
            diagnostics_json=diagnostics,
            progress_json=terminal_progress,
            error=terminal_error or None,
            finished_at=finished_at,
        ):
            return
        await self.push_webhook(task_id)

    def store_rejected_preview(
        self,
        candidate: Candidate,
        reason: str,
        pool: str,
        preview: dict[str, object],
        seen_hashes: list[tuple[str, imagehash.ImageHash]],
    ) -> dict[str, object] | None:
        """Persist a safe, decoded rejected image for operator inspection."""
        content = preview.get("content")
        metadata = preview.get("metadata")
        if not isinstance(content, bytes) or not isinstance(metadata, dict):
            return None
        try:
            digest = hashlib.sha256(content).hexdigest()
            phash = imagehash.phash(metadata["image"])
            if digest in {item[0] for item in seen_hashes} or any(
                (phash - item[1]) <= self.settings.phash_dedup_distance for item in seen_hashes
            ):
                return None
            extension = str(metadata["extension"])
            object_path = self.settings.storage_dir / f"{digest}.{extension}"
            if not object_path.exists():
                object_path.write_bytes(content)
            self.database.put_object(
                digest,
                str(object_path),
                extension,
                int(metadata["width"]),
                int(metadata["height"]),
            )
            seen_hashes.append((digest, phash))
            final_url = str(preview.get("final_url") or candidate.image_url)
            return {
                "url": f"{self.settings.public_base_url.rstrip('/')}/files/{digest}.{extension}",
                "source_url": candidate.page_url or final_url,
                "source_domain": candidate.source_domain
                or domain_of(candidate.page_url or final_url),
                "query": candidate.query,
                "reason": reason,
                "pool": pool,
                "title": candidate.title,
                "width": int(metadata["width"]),
                "height": int(metadata["height"]),
                "provider": candidate.provider,
                "platform": candidate.platform,
                "media_origin": candidate.media_origin,
            }
        except (KeyError, OSError, TypeError, ValueError) as exc:
            logger.debug("rejected preview storage skipped: %s", exc)
            return None

    @staticmethod
    def search_strategy_log() -> dict[str, dict[str, object]]:
        return {
            "S-01": {
                "id": "S-01",
                "name": "基础型号与品牌别名",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "added_candidates": 0,
                "note": "原始型号、品牌别名、型号空格变体",
            },
            "S-02": {
                "id": "S-02",
                "name": "多语言与买家意图词",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "added_candidates": 0,
                "note": "review、晒单、买家秀、开箱、customer photo 等词",
            },
            "S-03": {
                "id": "S-03",
                "name": "社区与电商 site 定向",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "added_candidates": 0,
                "note": "Reddit、YouTube、B站、论坛和平台域名定向",
            },
            "S-04": {
                "id": "S-04",
                "name": "稀缺 SKU 追加检索轮次",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "added_candidates": 0,
                "note": "长 SKU 且地区后缀明显时追加查询波次",
            },
            "S-05": {
                "id": "S-05",
                "name": "来源页图片展开",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "added_candidates": 0,
                "note": "从已命中的商品页、评测页和晒单页提取其它图片",
            },
            "S-06": {
                "id": "S-06",
                "name": "大批量结果追加检索轮次",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "added_candidates": 0,
                "note": "请求 300/500 张时追加查询，避免大上限只有前三轮",
            },
            "S-07": {
                "id": "S-07",
                "name": "动态近邻型号与来源域名扩展",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "added_candidates": 0,
                "note": "从首轮命中结果提取相近型号和新来源域名，再做一轮定向搜索",
            },
            "S-08": {
                "id": "S-08",
                "name": "宽松模糊池留存",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "added_candidates": 0,
                "note": "品牌相符且型号前缀接近的可解码图片单独留存，包含尺寸不足候选",
            },
            "S-09": {
                "id": "S-09",
                "name": "深度来源页与图库链接展开",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "added_candidates": 0,
                "note": "100/300/500 档位扩大来源页数量，并提取图库原图、srcset 和懒加载链接",
            },
            "S-10": {
                "id": "S-10",
                "name": "图片 URL 原图与尺寸变体",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "added_candidates": 0,
                "note": "尝试去掉公开 CDN 的缩略图变体，救回原图尺寸不足的候选",
            },
            "S-11": {
                "id": "S-11",
                "name": "同站图库/评论页一跳扩展",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "added_candidates": 0,
                "note": "从已命中的页面找同站 gallery、review、comment、detail 链接，再扩展一跳",
            },
            "S-12": {
                "id": "S-12",
                "name": "页面嵌入式媒体清单",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "added_candidates": 0,
                "note": "提取页面 JSON、脚本和媒体数组中的公开图片 URL，补齐评论/图库资源",
            },
            "S-14": {
                "id": "S-14",
                "name": "目标模式图片搜索分页",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "added_candidates": 0,
                "note": "目标模式下对同一公开图片查询继续读取后续结果页，增加长尾候选但不降低正式池门槛",
            },
            "S-13": {
                "id": "S-13",
                "name": "品牌尺寸品类家族模糊池",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "added_candidates": 0,
                "note": "同品牌、同尺寸、同品类但型号证据不足的外观近邻图单独留存",
            },
            "S-16": {
                "id": "S-16",
                "name": "目标模式候选验证蓄水池",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "added_candidates": 0,
                "note": "100/300/500 档位扩大已发现候选的下载解码验证量，为三池提供更多真实候选",
            },
            "S-17": {
                "id": "S-17",
                "name": "型号写法与来源域形态扩展",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "added_candidates": 0,
                "note": "对紧凑 SKU 生成空格/连字符/边界拆分写法，并复用已发现来源域进行目标模式检索",
            },
            "S-18": {
                "id": "S-18",
                "name": "目标模式千张预览蓄水池",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "preview_items": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "目标模式把通过安全解码但未进入正式池的图片预览上限提高到千张级别，只扩大人工复核入口，不降低正式池门槛",
            },
            "S-19": {
                "id": "S-19",
                "name": "正式池外溢候选留存",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "preview_items": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "目标模式把已通过图片访问、解码、尺寸和型号评分但因正式池上限未选中的候选留存到模糊池，标记为正式池外溢",
            },
            "S-20": {
                "id": "S-20",
                "name": "目标模式 Bing 长尾分页",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "目标模式继续读取同一查询的第 4/5 页公开 Bing 图片结果，并与 S-14 基础分页分开统计",
            },
            "S-21": {
                "id": "S-21",
                "name": "目标模式深度验证水库",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "目标模式把已发现候选的下载、解码和证据验证量从 S-16 的 20 倍再扩到 30 倍，为模糊池和淘汰池提供更深的真实候选",
            },
            "S-22": {
                "id": "S-22",
                "name": "来源页第二跳图库深挖",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "从首跳相关页面继续发现第二跳图库、评测和晒单页面，新增候选仍经过公开 URL、解码、尺寸、型号证据和去重校验",
            },
            "S-23": {
                "id": "S-23",
                "name": "完整型号来源域查询矩阵",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "将完整品牌+型号与已验证来源域、review/customer photo/gallery 等意图词交叉检索，扩大来源但避免只用短型号片段",
            },
            "S-24": {
                "id": "S-24",
                "name": "多语言完整型号来源矩阵",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "将完整品牌+型号与 15 种语言的评测、买家秀、晒单、开箱和用户图片意图词交叉到已发现来源域，扩大目标模式长尾来源",
            },
            "S-25": {
                "id": "S-25",
                "name": "型号家族视觉近邻矩阵",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "使用目标型号和已观察到的同前缀 SKU 生成宽召回查询；品牌相符但型号不完整的安全图片只进入模糊池，不进入正式池",
            },
            "S-26": {
                "id": "S-26",
                "name": "核心候选优先评估",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "目标模式先给原始查询、完整型号矩阵和多语言完整型号矩阵分配更多验证槽位，再验证型号家族近邻；不减少模糊池和淘汰池，只降低扩展噪声挤占正式池的概率",
            },
            "S-27": {
                "id": "S-27",
                "name": "超深验证水库",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "目标模式把实际下载、解码和证据验证窗口从 S-21 的 30 倍扩到 50 倍，上限仍由 MAX_EVALUATION_CANDIDATES 控制；只增加模糊/淘汰预览机会，不放宽正式池门槛",
            },
            "S-29": {
                "id": "S-29",
                "name": "大容量预览蓄水池",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "preview_capacity": 0,
                "enabled": False,
                "note": "目标模式把模糊池和淘汰预览池容量提高到 6,000/6,000，验证规则不变；只解除预览数量截断，普通搜索仍使用较小上限",
            },
            "S-30": {
                "id": "S-30",
                "name": "超大候选蓄水池与极深验证",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "candidate_capacity": 0,
                "enabled": False,
                "note": "目标模式把候选蓄水池提高到 12,000，并把实际下载、解码和证据验证窗口从 S-27 的 50 倍扩到 80 倍；验证门槛不变，只增加长尾图片进入三池的机会",
            },
            "S-31": {
                "id": "S-31",
                "name": "分层超大蓄水池与极深验证",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "candidate_capacity": 0,
                "retained_candidates": 0,
                "core_candidates": 0,
                "near_candidates": 0,
                "broad_candidates": 0,
                "enabled": False,
                "note": "目标模式把候选蓄水池提高到 20,000，并按精确型号、品牌/型号近邻、宽召回长尾分层保留；在 S-30 的 80 倍之后新增 120 倍验证段，验证门槛不变，只增加长尾图片进入三池的机会",
            },
            "S-32": {
                "id": "S-32",
                "name": "宽召回安全图片先行预览",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "fast_tail_candidates": 0,
                "enabled": False,
                "note": "目标模式对宽召回层先做公开图片下载、魔数、Pillow、尺寸和去重校验，安全解码后直接进入模糊/淘汰预览；核心和近邻候选仍走完整来源证据链，正式池不接受宽召回快速路径",
            },
            "S-33": {
                "id": "S-33",
                "name": "公开来源域旋转检索",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "目标模式只在已发现的公开来源域内旋转品牌、品类、型号和买家图片意图词；放宽的是发现查询，不放宽图片安全、型号证据或正式池门槛",
            },
            "S-34": {
                "id": "S-34",
                "name": "公开页面图库扇出",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "enabled": False,
                "note": "目标模式从已发现的同品牌/品类公开评论、图库和商品页继续提取页面声明的图片与相关页；只读公开 HTML，不执行脚本、不绕过登录，新增图片仍需安全下载、解码、去重和池分类",
            },
            "S-35": {
                "id": "S-35",
                "name": "宽召回第二评估通道",
                "queries": 0,
                "candidates": 0,
                "validated_images": 0,
                "fuzzy_previews": 0,
                "rejected_previews": 0,
                "added_candidates": 0,
                "fast_tail_candidates": 0,
                "enabled": False,
                "note": "目标模式在主评估窗口之后追加一段只做公开下载、解码、尺寸和去重的宽召回评估；只允许宽召回候选进入模糊/淘汰预览，不进入正式池，独立记录下载成本和增量",
            },
        }

    @staticmethod
    def image_url_variants(url: str) -> list[str]:
        """Return conservative public image-URL upgrades, never new hosts."""
        variants: list[str] = []
        amazon_variant = re.sub(r"\._[A-Z]{2,}\d+_\.(?=[a-z0-9]+(?:\?|$))", ".", url, flags=re.I)
        if amazon_variant != url:
            variants.append(amazon_variant)
        wordpress_variant = re.sub(
            r"-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp)(?:\?|$))",
            "",
            url,
            flags=re.I,
        )
        if wordpress_variant != url:
            variants.append(wordpress_variant)
        if "x-oss-process=image/" in url or "image/resize" in url:
            original = url.split("?", 1)[0]
            if original != url:
                variants.append(original)
        return list(dict.fromkeys(variants))

    def expand_image_url_variants(self, candidates: list[Candidate]) -> list[Candidate]:
        expanded: list[Candidate] = []
        for candidate in candidates:
            for variant in self.image_url_variants(candidate.image_url):
                expanded.append(
                    candidate.model_copy(
                        update={"image_url": variant, "media_origin": "url_variant"}
                    )
                )
                if len(expanded) >= self.settings.image_url_variant_candidates:
                    return expanded
        return expanded

    def build_adaptive_fanout_queries(
        self, product: ProductIdentity, candidates: list[Candidate], existing: list[str]
    ) -> list[str]:
        """Build bounded follow-up queries from evidence already found.

        This does not guess arbitrary translations or crawl new hosts directly.
        It only reuses model-like tokens sharing a prefix with the requested SKU
        and public domains already returned by the active providers.
        """
        target = compact_text(product.model).lower()
        brand = product.brand.strip()
        if not target or not brand:
            return []
        existing_set = {item.casefold() for item in existing}
        related_codes: list[str] = []
        domain_scores: dict[str, int] = {}
        minimum_prefix = max(4, int(len(target) * 0.55))
        for candidate in candidates:
            evidence = ImageService.candidate_evidence(candidate)
            compact_evidence = compact_text(evidence).lower()
            codes = re.findall(r"[a-z0-9-]{4,}", evidence.lower())
            for raw_code in codes:
                code = compact_text(raw_code).lower()
                if (
                    code != target
                    and len(code) >= 4
                    and any(char.isalpha() for char in code)
                    and any(char.isdigit() for char in code)
                    and len(os.path.commonprefix((target, code.replace("-", ""))))
                    >= minimum_prefix
                    and code not in related_codes
                ):
                    related_codes.append(code)
            domain = candidate.source_domain or domain_of(candidate.page_url or candidate.image_url)
            if (
                domain
                and any(term in compact_evidence for term in brand_evidence_terms(product))
                and (
                    target in compact_evidence
                    or any(code in compact_evidence for code in related_codes)
                )
            ):
                domain_scores[domain] = domain_scores.get(domain, 0) + 1

        queries: list[str] = []
        for code in related_codes[: self.settings.adaptive_fanout_domains]:
            queries.extend(
                [
                    f"{brand} {code} review",
                    f"{brand} {code} product photo",
                ]
            )
        for domain, _score in sorted(
            domain_scores.items(), key=lambda item: (-item[1], item[0])
        )[: self.settings.adaptive_fanout_domains]:
            queries.extend(
                [
                    f"site:{domain} {brand} {product.model} review",
                    f"site:{domain} {brand} {product.model} owner photo",
                ]
            )
        queries.extend(
            [
                f"{brand} {product.model} gallery",
                f"{brand} {product.model} owner photo",
                f"{brand} {product.model} marketplace listing",
                f"{brand} {product.model} used photo",
            ]
        )
        return [
            item
            for item in dict.fromkeys(queries)
            if item.casefold() not in existing_set
        ][: self.settings.adaptive_fanout_queries]

    def build_query_shape_fanout_queries(
        self, product: ProductIdentity, candidates: list[Candidate], existing: list[str]
    ) -> list[str]:
        """Generate bounded spelling shapes for compact alphanumeric SKUs.

        Search indexes do not agree on whether a model is written as ``24G10ZNE``,
        ``24 G10 ZNE`` or ``24G10-ZNE``. This fanout also applies the same shapes
        to a small set of near-model codes already observed in result titles and
        URLs. It never changes scoring or promotes a shape match into the formal
        pool by itself.
        """
        target = compact_text(product.model)
        brand = product.brand.strip()
        if not target or not brand:
            return []
        existing_set = {item.casefold() for item in existing}

        def shapes(value: str) -> list[str]:
            compact = compact_text(value)
            if len(compact) < 4:
                return []
            values = [compact]
            values.extend(
                [
                    re.sub(r"([A-Za-z])(\d+)", r"\1 \2", compact),
                    re.sub(r"(\d+)([A-Za-z])", r"\1 \2", compact),
                    re.sub(r"(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])", " ", compact),
                    re.sub(r"(?<=[A-Za-z])(?=\d)", "-", compact),
                    re.sub(r"(?<=\d)(?=[A-Za-z])", "-", compact),
                ]
            )
            if len(compact) >= 7 and re.search(r"[A-Za-z]{2,}$", compact):
                values.append(compact[:-1])
            return list(dict.fromkeys(item.strip() for item in values if item.strip()))

        model_shapes = shapes(target)
        related_codes: list[str] = []
        minimum_prefix = max(4, int(len(target) * 0.55))
        for candidate in candidates:
            evidence = self.candidate_evidence(candidate)
            for raw_code in re.findall(r"[a-z0-9-]{4,}", evidence.lower()):
                code = compact_text(raw_code).lower()
                if (
                    code != target.lower()
                    and any(char.isalpha() for char in code)
                    and any(char.isdigit() for char in code)
                    and len(os.path.commonprefix((target.lower(), code.replace("-", ""))))
                    >= minimum_prefix
                    and code not in related_codes
                ):
                    related_codes.append(code)
        for code in related_codes[: self.settings.adaptive_fanout_domains]:
            model_shapes.extend(shapes(code)[:4])

        target_numbers = set(re.findall(r"\d{2,4}", target.lower()))
        domain_scores: dict[str, int] = {}
        for candidate in candidates:
            evidence = compact_text(self.candidate_evidence(candidate)).lower()
            domain = candidate.source_domain or domain_of(
                candidate.page_url or candidate.image_url
            )
            if domain and any(term in evidence for term in brand_evidence_terms(product)) and (
                target.lower() in evidence
                or any(number in evidence for number in target_numbers)
            ):
                domain_scores[domain] = domain_scores.get(domain, 0) + 1

        queries: list[str] = []
        for shape in list(dict.fromkeys(model_shapes))[:12]:
            queries.extend(
                [
                    f"{brand} {shape} review",
                    f"{brand} {shape} customer photo",
                ]
            )
        for domain, _score in sorted(
            domain_scores.items(), key=lambda item: (-item[1], item[0])
        )[: self.settings.adaptive_fanout_domains]:
            for shape in list(dict.fromkeys(model_shapes))[:2]:
                queries.append(f"site:{domain} {brand} {shape} photo")
        return [
            item
            for item in dict.fromkeys(queries)
            if item.casefold() not in existing_set
        ][: self.settings.query_shape_fanout_queries]

    def build_target_query_matrix(
        self, product: ProductIdentity, candidates: list[Candidate], existing: list[str]
    ) -> list[str]:
        """Build target-only queries that keep the complete SKU in every row.

        The matrix reuses domains already observed with both brand and full-model
        evidence. This produces more source diversity without turning short
        fragments such as ``G10`` into standalone searches.
        """
        brand = product.brand.strip()
        model = product.model.strip()
        compact_model = compact_text(model).lower()
        if not brand or not compact_model:
            return []
        existing_set = {item.casefold() for item in existing}
        domain_scores: dict[str, int] = {}
        brand_terms = brand_evidence_terms(product)
        for candidate in candidates:
            evidence = compact_text(self.candidate_evidence(candidate)).lower()
            domain = candidate.source_domain or domain_of(
                candidate.page_url or candidate.image_url
            )
            if not domain:
                continue
            has_brand = any(term in evidence for term in brand_terms)
            has_model = compact_model in evidence or any(
                compact_text(alias).lower() in evidence for alias in product.model_aliases
            )
            if has_brand and has_model:
                domain_scores[domain] = domain_scores.get(domain, 0) + 1

        domains = [
            domain
            for domain, _score in sorted(
                domain_scores.items(), key=lambda item: (-item[1], item[0])
            )[: self.settings.target_query_matrix_domains]
        ]
        intents = [
            "review",
            "customer photo",
            "owner photo",
            "user review",
            "unboxing",
            "gallery",
            "product detail",
            "buyer photo",
        ]
        model_forms = list(dict.fromkeys([model, *product.model_aliases]))[:3]
        queries: list[str] = []
        for domain in domains:
            for intent in intents:
                queries.append(f"site:{domain} {brand} {model} {intent}")
        for model_form in model_forms:
            for intent in intents[:4]:
                queries.append(f"{brand} {model_form} {intent}")
        return [
            item
            for item in dict.fromkeys(queries)
            if item.casefold() not in existing_set
        ][: self.settings.target_query_matrix_queries]

    def build_multilingual_query_matrix(
        self, product: ProductIdentity, candidates: list[Candidate], existing: list[str]
    ) -> list[str]:
        """Cross full model forms with multilingual buyer-intent terms."""
        brand_forms = list(dict.fromkeys([product.brand, *product.brand_aliases]))[:3]
        model_forms = list(dict.fromkeys([product.model, *product.model_aliases]))[:3]
        if not brand_forms or not model_forms:
            return []
        existing_set = {item.casefold() for item in existing}
        domain_scores: dict[str, int] = {}
        compact_model = compact_text(product.model).lower()
        brand_terms = brand_evidence_terms(product)
        for candidate in candidates:
            evidence = compact_text(self.candidate_evidence(candidate)).lower()
            domain = candidate.source_domain or domain_of(
                candidate.page_url or candidate.image_url
            )
            if not domain:
                continue
            if (
                any(term in evidence for term in brand_terms)
                and (
                    compact_model in evidence
                    or any(compact_text(alias).lower() in evidence for alias in model_forms)
                )
            ):
                domain_scores[domain] = domain_scores.get(domain, 0) + 1
        domains = [
            domain
            for domain, _score in sorted(
                domain_scores.items(), key=lambda item: (-item[1], item[0])
            )[: self.settings.target_multilingual_matrix_domains]
        ]
        intents = [
            "review",
            "customer photo",
            "owner photo",
            "unboxing",
            "gallery",
            "buyer photo",
            "评测",
            "买家秀",
            "实拍",
            "晒单",
            "reseña",
            "foto del comprador",
            "улучшенный обзор",
            "отзыв",
            "avis",
            "photo client",
            "ulasan",
            "foto pembeli",
            "avaliação",
            "foto do cliente",
            "レビュー",
            "購入者写真",
            "обзор",
            "фото покупателя",
            "مراجعة",
            "صور العملاء",
            "समीक्षा",
            "ग्राहक फोटो",
            "đánh giá",
            "ảnh người mua",
            "inceleme",
            "müşteri fotoğrafı",
        ]
        rows: list[list[str]] = []
        for domain in domains:
            rows.append(
                [
                    f"site:{domain} {brand_form} {model_form} {intent}"
                    for brand_form in brand_forms[:2]
                    for model_form in model_forms[:2]
                    for intent in intents
                ]
            )
        if not rows:
            rows.append(
                [
                    f"{brand_form} {model_form} {intent}"
                    for brand_form in brand_forms
                    for model_form in model_forms
                    for intent in intents
                ]
            )
        queries: list[str] = []
        max_row_length = max(len(row) for row in rows)
        for index in range(max_row_length):
            for row in rows:
                if index < len(row):
                    queries.append(row[index])
        return [
            item
            for item in dict.fromkeys(queries)
            if item.casefold() not in existing_set
        ][: self.settings.target_multilingual_matrix_queries]

    def build_visual_neighbor_query_matrix(
        self, product: ProductIdentity, candidates: list[Candidate], existing: list[str]
    ) -> list[str]:
        """Build a broad, explicitly fuzzy query lattice from observed SKU stems.

        The stems come from the requested model or model-like codes already
        present in returned evidence. This lets adjacent SKUs contribute safe
        previews, but it never changes the exact-model scoring rule used by the
        formal pool.
        """
        brand_forms = list(dict.fromkeys([product.brand, *product.brand_aliases]))[:3]
        target = compact_text(product.model).lower()
        if not brand_forms or len(target) < 4:
            return []
        existing_set = {item.casefold() for item in existing}
        minimum_prefix = max(4, int(len(target) * 0.4))
        stems: list[str] = []

        def add_stem(value: str) -> None:
            compact = compact_text(value).lower()
            if len(compact) < 4 or not any(char.isdigit() for char in compact):
                return
            if compact not in stems:
                stems.append(compact)

        for model_form in [product.model, *product.model_aliases]:
            compact = compact_text(model_form).lower()
            add_stem(compact[:minimum_prefix])
            add_stem(compact[: min(len(compact), max(5, int(len(compact) * 0.55)))])
            for token in re.findall(r"[a-z0-9]+", compact):
                if len(token) >= 4 and any(char.isdigit() for char in token):
                    add_stem(token)

        domain_scores: dict[str, int] = {}
        brand_terms = brand_evidence_terms(product)
        for candidate in candidates:
            evidence = self.candidate_evidence(candidate)
            compact_evidence = compact_text(evidence).lower()
            domain = candidate.source_domain or domain_of(
                candidate.page_url or candidate.image_url
            )
            if not domain or not any(term in compact_evidence for term in brand_terms):
                continue
            matched_family = False
            for raw_code in re.findall(r"[a-z0-9][a-z0-9-]{3,}", evidence.lower()):
                code = compact_text(raw_code).lower()
                if len(os.path.commonprefix((target, code))) >= minimum_prefix:
                    add_stem(code[:minimum_prefix])
                    add_stem(code[: min(len(code), max(5, int(len(code) * 0.55)))])
                    matched_family = True
            if matched_family or target in compact_evidence:
                domain_scores[domain] = domain_scores.get(domain, 0) + 1

        stems = stems[:12]
        domains = [
            domain
            for domain, _score in sorted(
                domain_scores.items(), key=lambda item: (-item[1], item[0])
            )[: self.settings.target_family_query_domains]
        ]
        intents = [
            "product photo",
            "review",
            "customer photo",
            "owner photo",
            "unboxing",
            "gallery",
            "buyer photo",
            "实拍",
            "晒单",
            "买家秀",
            "reseña",
            "foto del comprador",
            "отзыв",
            "фото покупателя",
            "レビュー",
            "購入者写真",
            "مراجعة",
            "صور العملاء",
            "समीक्षा",
            "ग्राहक फोटो",
            "đánh giá",
            "ảnh người mua",
            "inceleme",
            "müşteri fotoğrafı",
        ]
        rows: list[list[str]] = []
        for domain in domains:
            rows.append(
                [
                    f"site:{domain} {brand} {stem} {intent}"
                    for brand in brand_forms[:2]
                    for stem in stems
                    for intent in intents
                ]
            )
        if not rows:
            rows.append(
                [
                    f"{brand} {stem} {intent}"
                    for brand in brand_forms
                    for stem in stems
                    for intent in intents
                ]
            )
        queries: list[str] = []
        max_row_length = max(len(row) for row in rows)
        for index in range(max_row_length):
            for row in rows:
                if index < len(row):
                    queries.append(row[index])
        return [
            item
            for item in dict.fromkeys(queries)
            if item.casefold() not in existing_set
        ][: self.settings.target_family_query_queries]

    def build_source_domain_carousel_queries(
        self, product: ProductIdentity, candidates: list[Candidate], existing: list[str]
    ) -> list[str]:
        """Use discovered public domains as a bounded broad-recall carousel.

        The earlier source matrix only reuses domains whose candidate already
        contains the exact model. That is excellent for precision but misses a
        common web pattern: a gallery or resale page names the brand and
        category in its title, while the model is present only in an image,
        caption, or a neighboring page. S-33 asks those *already observed*
        public domains for broad image-intent pages. It never invents a host,
        opens a private page, or changes the formal evidence threshold.
        """
        brand_forms = list(dict.fromkeys([product.brand, *product.brand_aliases]))[:2]
        model_forms = list(dict.fromkeys([product.model, *product.model_aliases]))[:2]
        if not brand_forms or not model_forms:
            return []
        existing_set = {item.casefold() for item in existing}
        category_markers = (
            "monitor",
            "display",
            "gaming",
            "speaker",
            "audio",
            "soundbar",
            "purifier",
            "vacuum",
            "camera",
            "laptop",
            "phone",
            "tablet",
            "fan",
            "显示器",
            "屏幕",
            "音箱",
            "空气净化",
            "吸尘器",
            "相机",
            "笔记本",
            "手机",
            "平板",
        )
        intent_markers = (
            "review",
            "customer photo",
            "owner photo",
            "product gallery",
            "buyer photo",
            "used listing",
            "unboxing photos",
            "晒单",
            "实拍",
            "买家秀",
            "gallery",
            "foto del comprador",
            "購入者写真",
        )
        domain_scores: dict[str, int] = {}
        domain_categories: dict[str, dict[str, int]] = {}
        target_compact = compact_text(product.model).lower()
        for candidate in candidates:
            evidence = compact_text(self.candidate_evidence(candidate)).lower()
            domain = candidate.source_domain or domain_of(
                candidate.page_url or candidate.image_url
            )
            if not domain:
                continue
            has_brand = any(term in evidence for term in brand_evidence_terms(product))
            has_family_signal = self.is_family_fuzzy_candidate(candidate, product)
            has_intent_signal = any(marker in evidence for marker in intent_markers)
            query_signal = compact_text(candidate.query).lower()
            if not has_brand and not any(
                compact_text(form).lower() in query_signal for form in brand_forms
            ):
                continue
            if not (
                has_family_signal
                or has_intent_signal
                or target_compact in evidence
                or candidate.media_origin in {"family_query", "search_pagination"}
            ):
                continue
            domain_scores[domain] = domain_scores.get(domain, 0) + (2 if has_brand else 1)
            categories = domain_categories.setdefault(domain, {})
            for marker in category_markers:
                if marker in evidence:
                    categories[marker] = categories.get(marker, 0) + 1

        domains = [
            domain
            for domain, _score in sorted(
                domain_scores.items(), key=lambda item: (-item[1], item[0])
            )[: self.settings.target_source_carousel_domains]
        ]
        if not domains:
            return []
        queries: list[str] = []
        for domain in domains:
            categories = domain_categories.get(domain, {})
            category = (
                sorted(categories, key=lambda item: (-categories[item], item))[0]
                if categories
                else "product"
            )
            # Keep one exact-model row for pages that expose the SKU only in a
            # caption, then spend the remaining rows on category/family intent
            # terms that are more likely to reveal public photo galleries.
            for brand in brand_forms:
                queries.extend(
                    [
                        f"site:{domain} {brand} {model_forms[0]} customer photo",
                        f"site:{domain} {brand} {model_forms[0]} gallery",
                        f"site:{domain} {brand} {category} owner photo",
                        f"site:{domain} {brand} {category} used listing",
                        f"site:{domain} {brand} {category} buyer photo",
                        f"site:{domain} {brand} {category} unboxing photos",
                    ]
                )
        return [
            item
            for item in dict.fromkeys(queries)
            if item.casefold() not in existing_set
        ][: self.settings.target_source_carousel_queries]

    @staticmethod
    def is_rare_sku(product: ProductIdentity) -> bool:
        model = compact_text(product.model)
        suffix = re.search(r"[a-z]{3,}$", model)
        return len(model) >= 8 and bool(suffix)

    @staticmethod
    def query_strategy_id(query: str) -> str:
        normalized = query.lower()
        if "site:" in normalized:
            return "S-03"
        if any(
            marker in normalized
            for marker in (
                "review",
                "photo",
                "晒单",
                "买家秀",
                "实拍",
                "开箱",
                "测评",
                "unboxing",
                "hands-on",
            )
        ):
            return "S-02"
        return "S-01"

    def pagination_strategy_id(self, candidate: Candidate) -> str:
        """Separate target-mode Bing pages after the S-14 baseline tail."""
        if (
            candidate.search_page > self.settings.target_bing_pages_per_query
            and candidate.search_page > 0
        ):
            return "S-20"
        return "S-14"

    @staticmethod
    def rejected_pool(candidate: Candidate, product: ProductIdentity, reason: str) -> str:
        """Keep related, decoded near-model images visible without formal promotion."""
        if reason not in {
            "insufficient_model_evidence",
            "image long edge is below minimum",
            "wide_tail_preview",
        }:
            return "rejected"
        evidence = compact_text(ImageService.candidate_evidence(candidate)).lower()
        brand_present = any(term in evidence for term in brand_evidence_terms(product))
        if not brand_present:
            return "rejected"
        if candidate.media_origin == "family_query" or candidate.media_origin.startswith("broad_"):
            return "fuzzy"
        if ImageService.is_family_fuzzy_candidate(candidate, product):
            return "fuzzy"
        return "rejected"

    @staticmethod
    def is_family_fuzzy_candidate(candidate: Candidate, product: ProductIdentity) -> bool:
        evidence_raw = ImageService.candidate_evidence(candidate)
        evidence = compact_text(evidence_raw).lower()
        target = compact_text(product.model).lower()
        model_codes = re.findall(r"[a-z0-9]+", evidence_raw.lower())
        minimum_prefix = max(4, int(len(target) * 0.55))
        if any(compact_text(alias).lower() in evidence for alias in product.model_aliases) or any(
            len(os.path.commonprefix((target, code.replace("-", "")))) >= minimum_prefix
            for code in model_codes
        ):
            return True
        target_numbers = set(re.findall(r"\d{2,4}", target))
        family_markers = (
            "monitor",
            "display",
            "gaming",
            "lcd",
            "fhd",
            "qhd",
            "speaker",
            "soundbar",
            "audio",
            "purifier",
            "air cleaner",
            "vacuum",
            "camera",
            "laptop",
            "phone",
            "tablet",
            "fan",
            "电竞",
            "显示器",
            "屏幕",
            "音箱",
            "扬声器",
            "空气净化",
            "吸尘器",
            "相机",
            "笔记本",
            "手机",
            "平板",
            "240hz",
            "165hz",
            "144hz",
        )
        return bool(
            target_numbers
            and any(number in evidence for number in target_numbers)
            and any(marker in evidence for marker in family_markers)
        )

    async def expand_source_pages(
        self,
        candidates: list[Candidate],
        product: ProductIdentity,
        *,
        max_pages: int | None = None,
        max_images_per_page: int | None = None,
        expand_related_pages: bool = False,
        related_page_limit: int | None = None,
        allow_broad_seeds: bool = False,
    ) -> tuple[list[Candidate], list[Candidate]]:
        """Extract additional images from already relevant public source pages.

        Image search engines often expose only one or two assets from a review,
        listing, or buyer-photo page. This bounded expansion visits a small set
        of pages that already contain exact model evidence, then feeds their
        declared images back through the normal download, decode, evidence, and
        deduplication checks. With ``allow_broad_seeds`` the caller may add
        already-observed same-brand/category pages for preview-only recall; the
        page is still public HTML and all images use the same safety pipeline.
        It deliberately does not bypass authentication or execute page scripts.
        """
        page_seeds: dict[str, Candidate] = {}
        page_limit = self.settings.page_expansion_pages if max_pages is None else max_pages
        image_limit = (
            self.settings.page_expansion_images_per_page
            if max_images_per_page is None
            else max_images_per_page
        )
        model_terms = [compact_text(product.model), *map(compact_text, product.model_aliases)]
        for candidate in candidates:
            page_url = candidate.page_url.strip()
            if not page_url or page_url == candidate.image_url:
                continue
            rough = compact_text(self.candidate_evidence(candidate))
            if any(term and term in rough for term in model_terms):
                pass
            elif not allow_broad_seeds or not self.is_broad_page_seed(candidate, product):
                continue
            page_seeds.setdefault(page_url, candidate)
            if len(page_seeds) >= page_limit:
                break

        async def expand_one(
            page_url: str, seed: Candidate, collect_related: bool = False
        ) -> tuple[list[Candidate], list[tuple[str, Candidate]]]:
            try:
                validate_public_url(page_url, self.settings.allow_synthetic_dns)
                async with self.evidence_sem:
                    response = await self.client.get(page_url, follow_redirects=True)
                if response.status_code >= 400 or "text/html" not in response.headers.get(
                    "content-type", ""
                ):
                    return [], []
                page = parse_page(response.text[:1_000_000], str(response.url))
                page_evidence = f"{page.title} {page.text[:20_000]}".strip()
                expanded: list[Candidate] = []
                for image_url in page.image_urls[:image_limit]:
                    if image_url == seed.image_url:
                        continue
                    if not image_url.lower().startswith(("http://", "https://")):
                        continue
                    expanded.append(
                        seed.model_copy(
                            update={
                                "image_url": image_url,
                                "page_url": str(response.url),
                                "title": f"{seed.title} {page.title}".strip()[:1000],
                                "media_origin": (
                                    "embedded_media"
                                    if image_url in page.embedded_image_urls
                                    else "source_page"
                                ),
                                "model_evidence": list(
                                    dict.fromkeys(
                                        [*seed.model_evidence, page.title, page_evidence]
                                    )
                                ),
                            }
                        )
                    )
                related = []
                if collect_related:
                    related = [
                        (related_url, seed.model_copy(update={"page_url": related_url}))
                        for related_url in page.related_page_urls
                    ]
                return expanded, related
            except Exception as exc:
                logger.debug("source page expansion rejected %s: %s", page_url, exc)
                return [], []

        pages = await asyncio.gather(
            *(
                expand_one(page_url, seed, collect_related=expand_related_pages)
                for page_url, seed in page_seeds.items()
            )
        )
        expanded_candidates = [candidate for group, _related in pages for candidate in group]
        related_seeds: dict[str, Candidate] = {}
        effective_related_page_limit = (
            self.settings.related_page_expansion_pages
            if related_page_limit is None
            else related_page_limit
        )
        if expand_related_pages and effective_related_page_limit > 0:
            for _group, related_group in pages:
                for related_url, seed in related_group:
                    related_seeds.setdefault(related_url, seed)
                    if len(related_seeds) >= effective_related_page_limit:
                        break
                if len(related_seeds) >= effective_related_page_limit:
                    break
        related_pages = await asyncio.gather(
            *(expand_one(page_url, seed) for page_url, seed in related_seeds.items())
        )
        related_candidates = [candidate for group, _related in related_pages for candidate in group]
        return expanded_candidates, related_candidates

    @staticmethod
    def is_broad_page_seed(candidate: Candidate, product: ProductIdentity) -> bool:
        """Allow only observed, public same-brand/category pages into S-34."""
        evidence = compact_text(ImageService.candidate_evidence(candidate)).lower()
        query = compact_text(candidate.query).lower()
        brand_present = any(term in evidence for term in brand_evidence_terms(product))
        if not brand_present:
            brand_present = any(
                compact_text(alias).lower() in query
                for alias in [product.brand, *product.brand_aliases]
                if alias
            )
        if not brand_present:
            return False
        category_markers = (
            "monitor",
            "display",
            "gaming",
            "speaker",
            "audio",
            "purifier",
            "vacuum",
            "camera",
            "laptop",
            "phone",
            "tablet",
            "显示器",
            "屏幕",
            "音箱",
            "空气净化",
            "吸尘器",
            "相机",
            "笔记本",
            "手机",
            "平板",
        )
        intent_markers = (
            "review",
            "photo",
            "gallery",
            "listing",
            "unboxing",
            "晒单",
            "实拍",
            "买家秀",
            "buyer",
            "owner",
        )
        return any(marker in evidence or marker in query for marker in category_markers) and any(
            marker in evidence or marker in query for marker in intent_markers
        )

    async def evaluate_candidate(
        self,
        candidate: Candidate,
        product: ProductIdentity,
        image_mode: str = "all",
        confidence_threshold: float = 0.62,
        fast_tail: bool = False,
        fast_tail_strategy: str = "S-32",
    ) -> dict[str, object]:
        content: bytes | None = None
        content_type = ""
        final_url = candidate.image_url
        try:
            if image_mode == "real_photo" and candidate.image_class != "real_photo":
                raise ImageRejected("candidate is not classified as a real photo")
            if image_mode == "catalog" and candidate.image_class == "real_photo":
                raise ImageRejected("candidate is classified as a real photo")
            content, content_type, final_url = await self.download_image(candidate.image_url)
            metadata = self.inspect_image(content, content_type)
            evidence = self.candidate_evidence(candidate)
            if fast_tail:
                return {
                    "candidate": candidate,
                    "rejected_reason": "wide_tail_preview",
                    "fast_tail": True,
                    "fast_tail_strategy": fast_tail_strategy,
                    "preview": {
                        "content": content,
                        "final_url": final_url,
                        "metadata": metadata,
                    },
                }
            target = compact_text(product.model)
            rough = compact_text(evidence)
            if target not in rough or not self.has_brand_evidence(candidate, product, rough):
                evidence = await self.collect_evidence(candidate, product, evidence)
            confidence, score, _reason = self.score_candidate(
                candidate, product, evidence, metadata
            )
            if confidence < confidence_threshold:
                return {
                    "candidate": candidate,
                    "rejected_reason": "insufficient_model_evidence",
                    "preview": {
                        "content": content,
                        "final_url": final_url,
                        "metadata": metadata,
                    },
                }
            digest = hashlib.sha256(content).hexdigest()
            phash = imagehash.phash(metadata["image"])
            return {
                "candidate": candidate,
                "content": content,
                "final_url": final_url,
                "metadata": metadata,
                "confidence": confidence,
                "score": score,
                "digest": digest,
                "phash": phash,
            }
        except (
            ImageRejected,
            SSRFBlocked,
            httpx.HTTPError,
            OSError,
            UnidentifiedImageError,
        ) as exc:
            logger.debug("candidate rejected: %s", exc)
            if isinstance(exc, ImageRejected):
                reason = str(exc)
            elif isinstance(exc, SSRFBlocked):
                reason = "ssrf_blocked"
            elif isinstance(exc, UnidentifiedImageError):
                reason = "invalid_image"
            elif isinstance(exc, httpx.HTTPError):
                reason = "download_error"
            else:
                reason = "image_validation_error"
            result: dict[str, object] = {"candidate": candidate, "rejected_reason": reason}
            if content and reason == "image long edge is below minimum":
                try:
                    result["preview"] = {
                        "content": content,
                        "final_url": final_url,
                        "metadata": self.inspect_image(content, content_type, allow_small=True),
                    }
                except (ImageRejected, OSError, UnidentifiedImageError):
                    pass
            return result

    @staticmethod
    def quality_identity_terms(product: ProductIdentity) -> tuple[str, ...]:
        """产品上本来就印着的字(品牌、型号),质量检查里不算海报字。"""
        terms = [product.brand, product.model, *product.model_aliases, *brand_evidence_terms(product)]
        return tuple(dict.fromkeys(term for term in terms if term))

    async def rank_by_listing_quality(
        self, ordered: list[dict[str, object]], product: ProductIdentity, limit: int
    ) -> list[dict[str, object]]:
        """型号已经对上的候选里,前 limit×QUALITY_HEADROOM 张逐张看图打分(水印、海报字、拼图、人像、小图、
        白底),干净的排前面,正式池按这个顺序取。之后的不评,原序排在后面。"""
        head = ordered[: max(limit, 1) * QUALITY_HEADROOM]
        rest = ordered[len(head):]
        terms = self.quality_identity_terms(product)
        sem = asyncio.Semaphore(QUALITY_WORKERS)

        async def one(item: dict[str, object]) -> None:
            async with sem:
                try:
                    item["quality"] = await asyncio.to_thread(
                        assess_quality, item["content"], identity_terms=terms
                    )
                except Exception as exc:  # 一张评不了不挡别的,当没评
                    logger.debug("quality assess failed: %s", exc)

        await asyncio.gather(*(one(item) for item in head))
        rank = {"good": 0, "ok": 1, "bad": 2}

        def key(item: dict[str, object]) -> tuple[int, float]:
            quality = item.get("quality")
            if quality is None:
                return (1, -float(item["score"]))
            return (rank.get(quality.grade, 1), -(quality.score + float(item["score"]) * 0.2))

        return sorted(head, key=key) + rest

    @staticmethod
    def diversify_results(items: list[dict[str, object]]) -> list[dict[str, object]]:
        """Interleave source groups so a large result set is not one-source heavy."""
        groups: dict[str, list[dict[str, object]]] = {}
        for item in items:
            candidate = item["candidate"]
            key = candidate.platform or candidate.source_domain or candidate.provider or "unknown"
            groups.setdefault(key, []).append(item)
        for group in groups.values():
            group.sort(key=lambda item: float(item["score"]), reverse=True)

        ordered: list[dict[str, object]] = []
        while groups:
            keys = sorted(
                groups,
                key=lambda key: float(groups[key][0]["score"]),
                reverse=True,
            )
            for key in keys:
                ordered.append(groups[key].pop(0))
                if not groups[key]:
                    del groups[key]
        return ordered

    @staticmethod
    def unique_candidates(candidates: list[Candidate]) -> list[Candidate]:
        seen: set[str] = set()
        result = []
        for candidate in candidates:
            key = normalize_image_url_key(candidate.image_url)
            if key not in seen:
                seen.add(key)
                result.append(candidate)
        return result

    def candidate_reservoir_cap(self, limit: int, target_mode: bool) -> int:
        """Bound in-memory candidates while retaining a large target reservoir."""
        if target_mode:
            return max(
                5_000,
                min(
                    20_000,
                    limit * self.settings.target_candidate_reservoir_multiplier,
                ),
            )
        return max(1_000, min(5_000, limit * 20))

    def extend_candidate_reservoir(
        self,
        candidates: list[Candidate],
        additions: list[Candidate],
        product: ProductIdentity,
        limit: int,
        target_mode: bool,
    ) -> int:
        """Append candidates and prune only after preserving query/source diversity."""
        existing_count = len(candidates)
        allowed_additions: list[Candidate] = []
        for candidate in additions:
            blocked_domain = self.blocked_domain_for_candidate(candidate)
            if blocked_domain:
                self.blocked_domain_hits[blocked_domain] = (
                    self.blocked_domain_hits.get(blocked_domain, 0) + 1
                )
                continue
            if self.is_offtopic_candidate(candidate, product):
                self.offtopic_candidate_count += 1
                continue
            allowed_additions.append(candidate)
        before = existing_count + len(allowed_additions)
        candidates.extend(allowed_additions)
        cap = self.candidate_reservoir_cap(limit, target_mode)
        if len(candidates) <= cap:
            return 0
        if target_mode:
            candidates[:] = self.stratify_target_reservoir(
                self.unique_candidates(candidates), product, cap
            )
            return max(0, before - len(candidates))
        old_candidates = self.diversify_candidates(
            self.unique_candidates(candidates[:existing_count])
        )
        new_candidates = self.diversify_candidates(
            self.unique_candidates(candidates[existing_count:])
        )
        interleaved: list[Candidate] = []
        while old_candidates or new_candidates:
            # Give the newly discovered wave a slot first. This prevents a
            # large earlier wave from starving the strategy being measured.
            if new_candidates:
                interleaved.append(new_candidates.pop(0))
            if old_candidates:
                interleaved.append(old_candidates.pop(0))
        candidates[:] = interleaved[:cap]
        return max(0, before - len(candidates))

    @staticmethod
    def model_tokens(product: ProductIdentity) -> tuple[str, ...]:
        """Distinctive model words, e.g. "magic", "trackpad" for "MAGIC TRACKPAD 4"."""
        tokens: list[str] = []
        for term in [product.model, *product.model_aliases]:
            if not term:
                continue
            tokens.append(compact_text(term))
            tokens.extend(re.findall(r"[a-z0-9\u4e00-\u9fff]+", normalize_text(term)))
        return tuple(
            dict.fromkeys(token for token in tokens if len(token) > 1 and not token.isdigit())
        )

    def is_offtopic_candidate(self, candidate: Candidate, product: ProductIdentity) -> bool:
        """Drop search hits whose title/URLs carry no model word before downloading.

        Off-target queries return pages like political news or anime posters; the
        brand alone is not enough ("苹果" also matches fruit stock photos).
        """
        if not candidate.title.strip():
            return False
        tokens = self.model_tokens(product)
        if not tokens:
            return False
        # 从已经按型号命中的页面/查询扩展出来的图库，标题里不一定重复型号；
        # 这些交给下载后的证据校验，不要在预过滤提前丢掉。
        if candidate.media_origin in {
            "embedded_media",
            "deep_related_page",
            "broad_related_page",
            "family_query",
            "source_domain_query",
            "url_variant",
        }:
            return False
        domain = candidate.source_domain or domain_of(candidate.page_url or candidate.image_url)
        if domain in official_domains(product):
            return False
        evidence = compact_text(self.candidate_evidence(candidate))
        return not any(token in evidence for token in tokens)

    def blocked_domain_for_candidate(self, candidate: Candidate) -> str | None:
        """Return the configured domain rule matching a candidate, if any."""
        if not self.blocked_domains:
            return None
        values = [
            candidate.source_domain,
            domain_of(candidate.page_url),
            domain_of(candidate.image_url),
        ]
        for value in values:
            host = str(value or "").strip().lower().removeprefix("www.")
            if not host:
                continue
            for blocked in self.blocked_domains:
                if host == blocked or host.endswith(f".{blocked}"):
                    return blocked
        return None

    def stratify_target_reservoir(
        self,
        candidates: list[Candidate],
        product: ProductIdentity,
        cap: int,
    ) -> list[Candidate]:
        """Keep a balanced target reservoir instead of retaining arrival order only."""
        buckets: dict[str, list[Candidate]] = {"core": [], "near": [], "broad": []}
        for candidate in candidates:
            buckets[self.candidate_reservoir_bucket(candidate, product)].append(candidate)
        # Keep enough exact/near evidence to protect the formal pool, while
        # reserving a quarter of the reservoir for intentionally broad recall
        # that can feed the rejected preview pool.
        desired_budgets = {
            "core": int(cap * 0.45),
            "near": int(cap * 0.30),
            "broad": cap - int(cap * 0.45) - int(cap * 0.30),
        }
        budgets = {
            key: min(desired_budgets[key], len(values))
            for key, values in buckets.items()
        }
        # Reassign unused strata quota to populated strata so the reservoir
        # remains as full as possible when a query has no near-model hits.
        remaining = min(cap, len(candidates)) - sum(budgets.values())
        while remaining > 0:
            grew = False
            for key in ("core", "near", "broad"):
                if budgets[key] < len(buckets[key]):
                    budgets[key] += 1
                    remaining -= 1
                    grew = True
                    if remaining == 0:
                        break
            if not grew:
                break
        selected: list[Candidate] = []
        for bucket_name in ("core", "near", "broad"):
            values = self.diversify_candidates(buckets[bucket_name])
            selected.extend(self.evenly_sample_candidates(values, budgets[bucket_name]))
        return self.diversify_candidates(selected)[:cap]

    @staticmethod
    def evenly_sample_candidates(
        candidates: list[Candidate], budget: int
    ) -> list[Candidate]:
        """Sample across the whole wave so early and late source waves survive."""
        if budget <= 0 or not candidates:
            return []
        if len(candidates) <= budget:
            return candidates
        if budget == 1:
            return [candidates[-1]]
        last_index = len(candidates) - 1
        indexes = {
            int(round(index * last_index / (budget - 1))) for index in range(budget)
        }
        selected = [candidate for index, candidate in enumerate(candidates) if index in indexes]
        return selected[:budget]

    @staticmethod
    def candidate_reservoir_bucket(
        candidate: Candidate, product: ProductIdentity
    ) -> str:
        """Classify candidates for retention only; it never changes acceptance rules."""
        evidence = compact_text(ImageService.candidate_evidence(candidate))
        model_terms = [product.model, *product.model_aliases]
        exact_terms = [compact_text(term) for term in model_terms if term]
        if any(term and term in evidence for term in exact_terms):
            return "core"
        brand_terms = [compact_text(term) for term in brand_evidence_terms(product)]
        brand_present = any(term and term in evidence for term in brand_terms)
        model_tokens = re.findall(r"[a-z0-9\u4e00-\u9fff]+", compact_text(product.model))
        stems = {
            token[: max(4, len(token) - 3)]
            for token in model_tokens
            if len(token) >= 5 and any(char.isdigit() for char in token)
        }
        if brand_present and any(stem in evidence for stem in stems):
            return "near"
        return "broad"

    def candidate_reservoir_bucket_counts(
        self, candidates: list[Candidate], product: ProductIdentity
    ) -> dict[str, int]:
        counts = {"core": 0, "near": 0, "broad": 0}
        for candidate in candidates:
            counts[self.candidate_reservoir_bucket(candidate, product)] += 1
        return counts

    @staticmethod
    def diversify_candidates(candidates: list[Candidate]) -> list[Candidate]:
        """Interleave query/source groups before costly image validation."""
        groups: dict[str, list[Candidate]] = {}
        for candidate in candidates:
            key = "|".join(
                [
                    candidate.query or "unknown-query",
                    candidate.platform or candidate.source_domain or candidate.provider,
                ]
            )
            groups.setdefault(key, []).append(candidate)
        ordered: list[Candidate] = []
        while groups:
            for key in list(groups):
                ordered.append(groups[key].pop(0))
                if not groups[key]:
                    del groups[key]
        return ordered

    def prioritize_target_candidates(
        self,
        candidates: list[Candidate],
        matrix_query_set: set[str],
        multilingual_query_set: set[str],
        target_mode: bool = False,
    ) -> list[Candidate]:
        """Interleave expansion strategies while protecting core validation slots."""
        buckets: dict[str, list[Candidate]] = {
            "S-25": [],
            "S-24": [],
            "S-23": [],
            "S-22": [],
            "base": [],
        }
        for candidate in candidates:
            if candidate.media_origin == "family_query":
                strategy_id = "S-25"
            elif candidate.query in multilingual_query_set:
                strategy_id = "S-24"
            elif candidate.query in matrix_query_set:
                strategy_id = "S-23"
            elif candidate.media_origin == "deep_related_page":
                strategy_id = "S-22"
            else:
                strategy_id = "base"
            buckets[strategy_id].append(candidate)
        for key, values in buckets.items():
            buckets[key] = self.diversify_candidates(values)
        ordered: list[Candidate] = []
        # S-26 keeps the broad recall strategies in the evaluation stream, but
        # gives the requested model's ordinary/full-model queries more slots
        # before the intentionally noisy family-neighbor wave. This only
        # changes validation order; all safe rejected previews remain pooled.
        schedule = (
            ("base", "S-23", "S-24", "base", "S-23", "S-24", "S-22", "S-25")
            if target_mode
            else ("S-25", "S-24", "S-23", "S-22", "base")
        )
        while any(buckets.values()):
            for key in schedule:
                if buckets[key]:
                    ordered.append(buckets[key].pop(0))
        return ordered

    async def download_image(self, url: str) -> tuple[bytes, str, str]:
        current = url
        async with self.download_sem:
            for _ in range(5):
                validate_public_url(current, self.settings.allow_synthetic_dns)
                async with self.client.stream("GET", current, follow_redirects=False) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise ImageRejected("redirect without location")
                        current = str(httpx.URL(current).join(location))
                        continue
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                    content_length = response.headers.get("content-length")
                    if content_length and int(content_length) > self.settings.max_image_bytes:
                        raise ImageRejected("image exceeds configured byte limit")
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > self.settings.max_image_bytes:
                            raise ImageRejected("image exceeds configured byte limit")
                        chunks.append(chunk)
                    content = b"".join(chunks)
                    if not content.startswith(
                        (b"\xff\xd8", b"\x89PNG", b"RIFF", b"GIF8", b"\x00\x00\x01\x00")
                    ):
                        raise ImageRejected("response is not a recognized image file")
                    return content, content_type, current
        raise ImageRejected("too many redirects")

    def inspect_image(
        self, content: bytes, content_type: str, *, allow_small: bool = False
    ) -> dict[str, object]:
        if len(content) > self.settings.max_image_bytes:
            raise ImageRejected("image too large")
        image = Image.open(io.BytesIO(content))
        if image.width * image.height > self.settings.max_image_pixels:
            raise ImageRejected("image exceeds pixel limit")
        image.load()
        if not allow_small and max(image.width, image.height) < self.settings.min_long_edge:
            raise ImageRejected("image long edge is below minimum")
        fmt = (
            (image.format or mimetypes.guess_extension(content_type) or "jpg")
            .lower()
            .removeprefix(".")
        )
        if fmt == "jpeg":
            fmt = "jpg"
        return {
            "image": image.convert("RGB"),
            "width": image.width,
            "height": image.height,
            "extension": fmt,
        }

    @staticmethod
    def candidate_evidence(candidate: Candidate) -> str:
        evidence = " ".join(
            [
                candidate.title,
                candidate.page_url,
                candidate.image_url,
                *candidate.model_evidence,
            ]
        )
        return evidence

    async def collect_evidence(
        self, candidate: Candidate, product: ProductIdentity, evidence: str = ""
    ) -> str:
        evidence = evidence or self.candidate_evidence(candidate)
        if not candidate.page_url:
            return evidence
        try:
            validate_public_url(candidate.page_url, self.settings.allow_synthetic_dns)
            async with self.evidence_sem:
                response = await self.client.get(candidate.page_url, follow_redirects=True)
            if response.status_code < 400 and "text/html" in response.headers.get(
                "content-type", ""
            ):
                page = parse_page(response.text[:1_000_000], str(response.url))
                evidence += f" {page.title} {page.text[:20_000]}"
        except Exception:
            pass
        return evidence

    def score_candidate(
        self,
        candidate: Candidate,
        product: ProductIdentity,
        evidence: str,
        metadata: dict[str, object],
    ) -> tuple[float, float, str]:
        normalized_evidence = compact_text(evidence)
        model_terms = list(
            dict.fromkeys(
                compact_text(item) for item in [product.model, *product.model_aliases] if item
            )
        )
        domain = candidate.source_domain or domain_of(candidate.page_url or candidate.image_url)
        official = domain in official_domains(product)
        brand_present = official or any(
            term in normalized_evidence for term in brand_evidence_terms(product)
        )
        if not brand_present:
            return 0.0, 0.0, "missing brand evidence"
        readable_evidence = normalize_text(evidence)

        def _variant_suffix_after_model(term: str) -> str | None:
            """型号后面隔空格/短横线的短后缀也算变体：24G2 Z / 24G2 SP / 24G2 V2。"""
            chunks = re.findall(r"[a-z]+|[0-9]+|[一-鿿]+", term)
            if not chunks:
                return None
            body = r"[\s\-_/]*".join(re.escape(chunk) for chunk in chunks)
            match = re.search(rf"(?<![a-z0-9]){body}(?![a-z0-9])", readable_evidence)
            if match is None:
                return None
            rest = readable_evidence[match.end():]
            token_match = re.match(r"[\s\-_/]*([a-z]{1,5})(?![a-z0-9])", rest)
            if token_match is None:
                token_match = re.match(r"[\s\-_/]*([a-z]{1,3}\d{1,2})(?![a-z0-9])", rest)
            if token_match is None:
                return None
            token = token_match.group(1)
            brand_terms = {
                normalize_text(item)
                for item in [product.brand, *product.brand_aliases]
                if item
            }
            if token in _MODEL_BENIGN_SUFFIXES or token in brand_terms:
                return None
            if (
                token in _MODEL_VARIANT_SUFFIXES
                or len(token) <= 3
                or re.fullmatch(r"[a-z]{1,3}\d{1,2}", token)
            ):
                return token
            return None

        def _bounded_model_pattern(term: str) -> re.Pattern[str] | None:
            # 按字母/数字/中文分段,"24g2" -> 24·g·2,这样 24 G2 / 24-G2 / 24G2 都能匹配
            chunks = re.findall(r"[a-z]+|[0-9]+|[一-鿿]+", term)
            if not chunks:
                return None
            body = r"[\s\-_/]*".join(re.escape(chunk) for chunk in chunks)
            # 24 G2 / 24-G2 / 24G2 都算命中；24G2 不能命中 24G2Z，4 不能命中 4 Lite。
            return re.compile(rf"(?<![a-z0-9]){body}(?![a-z0-9])")

        model_patterns = [p for p in (_bounded_model_pattern(t) for t in model_terms) if p]
        exact = any(pattern.search(readable_evidence) for pattern in model_patterns)
        token_hits_by_term = [
            sum(token in normalized_evidence for token in re.findall(r"[a-z0-9\u4e00-\u9fff]+", term) if len(token) > 1)
            for term in model_terms
        ]
        token_hits = max(token_hits_by_term, default=0)
        token_count = max(
            1,
            max(
                (
                    len([token for token in re.findall(r"[a-z0-9\u4e00-\u9fff]+", term) if len(token) > 1])
                    for term in model_terms
                ),
                default=1,
            ),
        )
        confidence = 0.96 if exact else 0.55 + (0.35 * token_hits / token_count)
        if official:
            confidence = min(0.995, confidence + 0.03)
        # 24G2 命中 24G2Z、4 命中 4 Lite 这类“更长变体”不是同款，强降权。
        near_model = any(
            code != term and code.startswith(term) and len(code) > len(term)
            for term in model_terms
            for code in re.findall(r"[a-z0-9]{2,}", readable_evidence)
        )
        # 24G2 Z / 24G2 SP / 24G2 V2 这种带分隔符的变体也要认出来。
        variant_suffix = next(
            (suffix for term in model_terms if (suffix := _variant_suffix_after_model(term))),
            None,
        )
        variant = near_model or bool(variant_suffix)
        if variant and exact:
            exact = False
        if variant and not exact:
            confidence *= 0.55
        model_codes = set(re.findall(r"\b[a-z]{1,8}\d[a-z0-9-]{2,}\b", evidence.lower()))
        if model_codes and not any(
            term and term in code.replace("-", "") for term in model_terms for code in model_codes
        ):
            confidence *= 0.55
        long_edge = max(int(metadata["width"]), int(metadata["height"]))
        score = confidence * 100 + (40 if official else 0) + min(long_edge / 100, 30)
        if variant and not exact:
            return confidence, score, "near model variant"
        return confidence, score, "exact model evidence" if exact else "partial model evidence"

    @staticmethod
    def has_brand_evidence(candidate: Candidate, product: ProductIdentity, rough: str) -> bool:
        domain = candidate.source_domain or domain_of(candidate.page_url or candidate.image_url)
        return domain in official_domains(product) or any(
            term in rough for term in brand_evidence_terms(product)
        )

    @staticmethod
    def detect_watermark(candidate: Candidate) -> str:
        text = f"{candidate.title} {candidate.image_url}".lower()
        if "watermark" in text or "logo-overlay" in text:
            return "suspected"
        return "unknown"

    async def push_webhook(self, task_id: str) -> None:
        url = self.settings.result_webhook_url
        if not url:
            return
        row = self.database.get_task(task_id)
        if not row:
            return
        headers = {"Content-Type": "application/json"}
        if self.settings.result_webhook_token:
            headers["Authorization"] = f"Bearer {self.settings.result_webhook_token}"
        payload = {
            "task_id": task_id,
            "query": row["query"],
            "status": row["status"],
            "images": json.loads(row["images_json"]),
        }
        for attempt in range(self.settings.webhook_max_retries + 1):
            try:
                response = await self.client.post(url, json=payload, headers=headers)
                if response.status_code < 400:
                    return
            except httpx.HTTPError:
                pass
            if attempt < self.settings.webhook_max_retries:
                await asyncio.sleep(2**attempt)
