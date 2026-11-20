from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "product-image-service"
    host: str = "127.0.0.1"
    port: int = 8090
    public_base_url: str = "http://127.0.0.1:8090"
    data_dir: Path = Path("./data")
    storage_dir: Path = Path("./storage")
    database_path: Path = Path("./data/catalog.sqlite3")
    wallpaper_root: Path = Path("/Volumes/wallpaper")
    wallpaper_output_dir: Path = Path("/Volumes/wallpaper/steam-images-1000/images")
    wallpaper_runner_script: Path = Path("/Volumes/wallpaper/.run_wallpaper_bulk.py")
    wallpaper_free_margin_percent: float = Field(default=1.0, ge=0.5, le=10.0)
    orchestration_manifest_path: Path = Path("./config/orchestration.json")
    orchestration_state_path: Path = Path("./data/orchestration_state.json")
    brand_catalog_path: Path = Path("./config/brand_aliases.json")
    market_catalog_path: Path = Path("./config/market_platforms.json")
    log_level: str = "INFO"
    admin_auth_mode: str = "local_dev"
    employee_access_token: str = ""

    admin_password: str = "change-me-now"
    admin_session_secret: str = "change-me-session-secret"
    credential_encryption_key: str = ""

    brave_search_api_key: str = ""
    google_api_key: str = ""
    google_cx: str = ""
    searxng_url: str = ""
    reddit_client_id: str = ""
    reddit_client_secret: str = ""
    reddit_user_agent: str = "product-image-service/0.1 by local-admin"
    douyin_access_token: str = ""
    douyin_device_id: str = ""
    xhs_adapter_url: str = ""
    xhs_cookie: str = ""
    gallery_dl_bin: str = "gallery-dl"
    playwright_enabled: bool = False

    enabled_providers: str = (
        "official,bing_public,brave,google,searxng,reddit,douyin,xiaohongshu,gallery_dl,playwright"
    )
    min_long_edge: int = Field(default=600, ge=64)
    max_image_bytes: int = Field(default=15 * 1024 * 1024, ge=1024)
    max_image_pixels: int = Field(default=30_000_000, ge=1_000_000)
    download_concurrency: int = Field(default=6, ge=1, le=32)
    # pHash 去重距离：越小越严格、保留的同款角度越多。老值 6 会把不同角度的同款误删。
    phash_dedup_distance: int = Field(default=4, ge=0, le=16)
    provider_query_budget: int = Field(default=12, ge=3, le=32)
    provider_retry_attempts: int = Field(default=2, ge=0, le=3)
    provider_retry_backoff_seconds: float = Field(default=0.5, ge=0, le=5)
    task_retry_limit: int = Field(default=3, ge=0, le=10)
    bing_endpoint: str = "https://www.bing.com/images/search"
    bing_pages_per_query: int = Field(default=1, ge=1, le=5)
    # 上架选图的 listing 档：每查询翻 2 页，比默认多拿一轮，但不进入 100 张目标矩阵。
    listing_bing_pages_per_query: int = Field(default=2, ge=1, le=5)
    target_bing_pages_per_query: int = Field(default=3, ge=1, le=5)
    target_bing_tail_pages_per_query: int = Field(default=5, ge=1, le=5)
    max_query_rounds: int = Field(default=3, ge=1, le=4)
    rare_sku_extra_query_rounds: int = Field(default=5, ge=0, le=5)
    bulk_result_extra_query_rounds: int = Field(default=2, ge=0, le=4)
    adaptive_fanout_queries: int = Field(default=24, ge=0, le=64)
    adaptive_fanout_domains: int = Field(default=8, ge=0, le=16)
    query_shape_fanout_queries: int = Field(default=32, ge=0, le=96)
    target_query_matrix_queries: int = Field(default=64, ge=0, le=128)
    target_query_matrix_domains: int = Field(default=12, ge=0, le=24)
    target_query_matrix_rounds: int = Field(default=4, ge=0, le=8)
    target_multilingual_matrix_queries: int = Field(default=128, ge=0, le=256)
    target_multilingual_matrix_domains: int = Field(default=24, ge=0, le=48)
    target_multilingual_matrix_rounds: int = Field(default=8, ge=0, le=12)
    target_family_query_queries: int = Field(default=96, ge=0, le=192)
    target_family_query_domains: int = Field(default=24, ge=0, le=48)
    target_family_query_rounds: int = Field(default=6, ge=0, le=12)
    target_source_carousel_queries: int = Field(default=192, ge=0, le=384)
    target_source_carousel_domains: int = Field(default=40, ge=0, le=64)
    target_source_carousel_rounds: int = Field(default=4, ge=0, le=12)
    target_broad_page_expansion_pages: int = Field(default=0, ge=0, le=96)
    target_broad_page_images_per_page: int = Field(default=80, ge=1, le=100)
    target_broad_related_page_limit: int = Field(default=0, ge=0, le=64)
    max_evaluation_candidates: int = Field(default=5000, ge=50, le=5000)
    target_evaluation_multiplier: int = Field(default=20, ge=5, le=40)
    deep_target_evaluation_multiplier: int = Field(default=30, ge=20, le=40)
    target_ultra_evaluation_multiplier: int = Field(default=50, ge=30, le=50)
    target_extreme_evaluation_multiplier: int = Field(default=80, ge=50, le=80)
    target_mega_evaluation_multiplier: int = Field(default=120, ge=80, le=120)
    target_max_evaluation_candidates: int = Field(default=12000, ge=50, le=12000)
    target_fast_tail_evaluation_candidates: int = Field(default=1200, ge=0, le=16000)
    target_candidate_reservoir_multiplier: int = Field(default=200, ge=60, le=200)
    evaluation_batch_size: int = Field(default=250, ge=25, le=500)
    page_expansion_pages: int = Field(default=16, ge=0, le=64)
    page_expansion_images_per_page: int = Field(default=20, ge=1, le=100)
    deep_source_expansion_pages: int = Field(default=32, ge=0, le=64)
    deep_source_expansion_images_per_page: int = Field(default=40, ge=1, le=100)
    related_page_expansion_pages: int = Field(default=16, ge=0, le=32)
    target_second_hop_pages: int = Field(default=32, ge=0, le=64)
    target_second_hop_related_pages: int = Field(default=32, ge=0, le=64)
    target_second_hop_images_per_page: int = Field(default=60, ge=1, le=100)
    embedded_media_urls: int = Field(default=300, ge=0, le=500)
    image_url_variant_candidates: int = Field(default=24, ge=0, le=64)
    max_fuzzy_previews: int = Field(default=500, ge=0, le=500)
    max_rejected_previews: int = Field(default=300, ge=0, le=500)
    target_max_fuzzy_previews: int = Field(default=12000, ge=0, le=12000)
    target_max_rejected_previews: int = Field(default=12000, ge=0, le=12000)
    max_browser_workers: int = Field(default=1, ge=1, le=2)
    task_poll_seconds: float = Field(default=0.5, gt=0.05, le=10)
    result_webhook_url: str = ""
    result_webhook_token: str = ""
    webhook_max_retries: int = Field(default=3, ge=0, le=10)
    cache_ttl_seconds: int = Field(default=86_400, ge=0)
    allow_synthetic_dns: bool = False

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def enabled_provider_names(self) -> set[str]:
        return {item.strip() for item in self.enabled_providers.split(",") if item.strip()}

    def prepare_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.prepare_directories()
    return settings
