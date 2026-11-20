from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class TaskStatus(StrEnum):
    queued = "queued"
    processing = "processing"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class SearchTier(StrEnum):
    strict = "strict"
    balanced = "balanced"
    broad = "broad"


class ReviewStatus(StrEnum):
    pending = "pending"
    in_progress = "in_progress"
    approved = "approved"
    needs_changes = "needs_changes"


class TaskLane(StrEnum):
    """The canonical operator-facing lane for a task.

    ``history`` is intentionally not a work queue: cancelled tasks stay
    archived there, while every active or completed task is either good or
    bad.  Keeping this mapping explicit prevents each UI from inventing its
    own interpretation of status and review state.
    """

    good = "good"
    bad = "bad"
    history = "history"


def resolve_task_lane(
    status: TaskStatus | str, review_status: ReviewStatus | str = ReviewStatus.pending
) -> TaskLane:
    status_value = getattr(status, "value", status)
    review_value = getattr(review_status, "value", review_status)
    if status_value == TaskStatus.failed.value or (
        status_value == TaskStatus.completed.value
        and review_value == ReviewStatus.needs_changes.value
    ):
        return TaskLane.bad
    if status_value == TaskStatus.cancelled.value:
        return TaskLane.history
    return TaskLane.good


class ProviderState(StrEnum):
    healthy = "healthy"
    degraded = "degraded"
    auth_required = "auth_required"
    rate_limited = "rate_limited"
    temporarily_disabled = "temporarily_disabled"
    unsupported = "unsupported"


class SearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=200)
    limit: int = Field(default=20, ge=1, le=500)
    locale: str | None = Field(default=None, max_length=16)
    image_mode: str = Field(default="all", pattern="^(all|catalog|real_photo)$")
    platforms: list[str] = Field(default_factory=list, max_length=50)
    refresh: bool = False
    search_tier: SearchTier = SearchTier.balanced
    # listing：上架选图用的深抓模式。limit<50 时也开翻页/变体/自适应扩展。
    # auto/fast 保持旧行为，旧调用方不受影响。
    profile: str = Field(default="auto", pattern="^(auto|fast|listing)$")
    # 缓存下限：已完成的旧任务结果少于这个数时不复用，避免薄结果被缓存一整天。
    min_results: int = Field(default=0, ge=0, le=500)
    # 召回/匹配规则版本；规则改了要 bump，旧缓存自动失效。
    recall_version: int = Field(default=1, ge=1)

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        return " ".join(value.split())


class SearchAccepted(BaseModel):
    task_id: str
    status: TaskStatus


class TaskRetryRequest(BaseModel):
    query: str | None = Field(default=None, max_length=200)

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        if len(cleaned) < 2:
            raise ValueError("query must contain at least 2 characters")
        return cleaned


class SearchTierPolicy(BaseModel):
    label: str = Field(min_length=1, max_length=20)
    confidence_threshold: float = Field(default=0.62, ge=0.0, le=1.0)
    first_pass_multiplier: int = Field(default=8, ge=1, le=50)


class SearchPolicy(BaseModel):
    version: int = Field(default=1, ge=1)
    tiers: dict[SearchTier, SearchTierPolicy]


class SearchPolicyUpdate(BaseModel):
    tiers: dict[SearchTier, SearchTierPolicy]


def default_search_policy() -> SearchPolicy:
    return SearchPolicy(
        version=1,
        tiers={
            SearchTier.strict: SearchTierPolicy(
                label="严格", confidence_threshold=0.72, first_pass_multiplier=5
            ),
            SearchTier.balanced: SearchTierPolicy(
                label="平衡", confidence_threshold=0.62, first_pass_multiplier=8
            ),
            SearchTier.broad: SearchTierPolicy(
                label="宽松", confidence_threshold=0.55, first_pass_multiplier=14
            ),
        },
    )


class PoolDecision(BaseModel):
    image_key: str = Field(min_length=1, max_length=2000)
    pool: str = Field(pattern="^(formal|candidate)$")


class PoolDecisionRequest(BaseModel):
    decisions: list[PoolDecision] = Field(default_factory=list, max_length=5000)
    note: str = Field(default="", max_length=1000)


class BlockedDomainRequest(BaseModel):
    domain: str = Field(min_length=3, max_length=255)
    note: str = Field(default="", max_length=500)


class ProductIdentity(BaseModel):
    original_query: str
    brand: str
    model: str
    aliases: list[str] = Field(default_factory=list)
    brand_key: str = ""
    brand_aliases: list[str] = Field(default_factory=list)
    model_aliases: list[str] = Field(default_factory=list)
    official_domains: list[str] = Field(default_factory=list)
    supported_locales: list[str] = Field(default_factory=list)


class Candidate(BaseModel):
    image_url: str
    page_url: str = ""
    provider: str
    source_domain: str = ""
    source_type: str = "web"
    title: str = ""
    width: int = 0
    height: int = 0
    query: str = ""
    search_page: int = 0
    platform: str = ""
    media_origin: str = "unknown"
    image_class: str = "unknown"
    real_photo_confidence: float = 0.0
    review_url: str = ""
    review_id: str = ""
    model_evidence: list[str] = Field(default_factory=list)
    discovered_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ImageResult(BaseModel):
    url: str
    source_url: str
    source_domain: str
    source_type: str
    width: int
    height: int
    watermark: str
    product_confidence: float
    score: float
    provider: str
    platform: str = ""
    media_origin: str = "unknown"
    image_class: str = "unknown"
    real_photo_confidence: float = 0.0
    review_url: str = ""
    review_id: str = ""
    # 上架用图质量(app/quality.py):good 能直接用 / ok 凑合 / bad 别自动用;空 = 没评过(老任务)
    quality_score: float = 0.0
    quality_grade: str = ""
    quality_flags: list[str] = Field(default_factory=list)


class TaskResponse(BaseModel):
    task_id: str
    query: str
    original_query: str = ""
    query_history: list[str] = Field(default_factory=list)
    brand: str = ""
    model: str = ""
    image_mode: str = "all"
    search_tier: SearchTier = SearchTier.balanced
    locale: str | None = None
    limit: int = 20
    profile: str = "auto"
    min_results: int = 0
    recall_version: int = 1
    status: TaskStatus
    lane: TaskLane = TaskLane.good
    count: int = 0
    images: list[ImageResult] = Field(default_factory=list)
    candidate_images: list[dict[str, Any]] = Field(default_factory=list)
    retry_snapshots: list[dict[str, Any]] = Field(default_factory=list)
    pool_decisions: dict[str, str] = Field(default_factory=dict)
    diagnostics: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    progress: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    assignee: str = ""
    review_status: ReviewStatus = ReviewStatus.pending
    reviewer: str = ""
    review_note: str = ""
    reviewed_at: str | None = None


class TaskSummary(BaseModel):
    task_id: str
    query: str
    original_query: str = ""
    query_history: list[str] = Field(default_factory=list)
    brand: str = ""
    model: str = ""
    image_mode: str = "all"
    search_tier: SearchTier = SearchTier.balanced
    locale: str | None = None
    limit: int = 20
    profile: str = "auto"
    min_results: int = 0
    recall_version: int = 1
    status: TaskStatus
    lane: TaskLane = TaskLane.good
    count: int = 0
    progress: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    assignee: str = ""
    review_status: ReviewStatus = ReviewStatus.pending
    reviewer: str = ""
    review_note: str = ""
    reviewed_at: str | None = None


class EmployeeReviewRequest(BaseModel):
    decision: ReviewStatus = Field(..., description="approved or needs_changes")
    note: str = Field(default="", max_length=1000)

    @field_validator("decision")
    @classmethod
    def validate_decision(cls, value: ReviewStatus) -> ReviewStatus:
        if value not in {ReviewStatus.approved, ReviewStatus.needs_changes}:
            raise ValueError("decision must be approved or needs_changes")
        return value


class EmployeeTaskSummary(TaskSummary):
    batch_id: str | None = None
    batch_row: int | None = None
    batch_spu: str = ""


class TaskQueueResponse(BaseModel):
    tasks: list[TaskSummary] = Field(default_factory=list)
    active_count: int = 0


class BatchItemSummary(BaseModel):
    task_id: str
    row_number: int
    spu: str = ""
    query: str
    original_query: str = ""
    query_history: list[str] = Field(default_factory=list)
    search_tier: SearchTier = SearchTier.balanced
    status: TaskStatus
    lane: TaskLane = TaskLane.good
    count: int = 0
    progress: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    review_status: ReviewStatus = ReviewStatus.pending
    review_note: str = ""
    updated_at: str | None = None


class BatchSummary(BaseModel):
    batch_id: str
    filename: str
    total: int
    completed: int = 0
    processing: int = 0
    queued: int = 0
    failed: int = 0
    needs_changes: int = 0
    cancelled: int = 0
    percent: float = 0.0
    settled_percent: float = 0.0
    elapsed_seconds: float = 0.0
    estimated_seconds: float = 0.0
    eta_seconds: float = 0.0
    eta_at: str | None = None
    status: str
    result_limit: int = 20
    image_mode: str = "all"
    search_tier: SearchTier = SearchTier.balanced
    locale: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class BatchResponse(BatchSummary):
    items: list[BatchItemSummary] = Field(default_factory=list)


class EmployeeWorkbenchResponse(BaseModel):
    employee: str
    date: str
    batch: BatchSummary | None = None
    total: int = 0
    crawl_completed: int = 0
    review_pending: int = 0
    review_in_progress: int = 0
    review_approved: int = 0
    review_needs_changes: int = 0
    tasks: list[EmployeeTaskSummary] = Field(default_factory=list)


class BatchListResponse(BaseModel):
    batches: list[BatchSummary] = Field(default_factory=list)


class CredentialUpdate(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)


class LoginRequest(BaseModel):
    password: str


class OrchestrationToggle(BaseModel):
    enabled: bool
