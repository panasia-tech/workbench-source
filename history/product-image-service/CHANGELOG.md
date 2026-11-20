# Changelog

## Unreleased

- Refined `/wallpaper/remote` into a camera-first, human-guided phone UI and changed the 100-frame export to capture JPEGs directly from the live camera preview every 100ms, avoiding iPhone video seek/decode distortion.
- Added the passive, full-viewport Wallpaper Display H5 at `/wallpaper/player` plus a phone capture page at `/wallpaper/remote`. A pairing-code WebSocket synchronizes phone-camera recording with the computer's fixed 100-frame / 10-second playback; the phone extracts 100 JPEG frames and downloads them as a ZIP, while the computer page has no controls or local recorder.
- Added a local HTTPS reverse proxy on port `8443` for iPhone Safari camera capture; the existing HTTP service on port `8090` remains available for local management.
- Added an access-controlled fixed 100-frame playlist/file API with rotating batches and pairing-session/WebSocket control messages.
- Added an isolated Wallpaper download route on macOS: a localhost-only Mihomo process, per-process proxychains wrapper, fixed large-traffic node, conservative DepotDownloader concurrency, and a watchdog that switches download-only nodes or stops on Steam authentication rate limits; GPT and daily traffic remain outside the download route.
- Added a live `/wallpaper` mobile-first management console for the external Steam wallpaper runner. The H5 reads real disk/image/process state, serves the image-only gallery, and exposes authenticated start/stop controls; video projects are skipped, missing `STEAM_API_KEY` is shown as an explicit auth-required state, and Steam credentials remain outside the page.
- Closed the queue regression loop: the bad lane now includes both crawl failures and completed tasks marked `needs_changes`; batch items expose review status/notes, and approval returns a task to the good lane. Bad-lane refresh patches rows by task ID and preserves the operator's scroll anchor; retrying from that lane no longer forces a jump to the table head.
- Centralized task ownership in the API `lane` field (`good`, `bad`, or `history`) so admin, batch, and employee views cannot independently mix task states.
- Added database-level good/bad bucket queries that filter before applying the API limit, so abnormal tasks cannot be hidden behind unrelated completed rows. Verified the live local service after restart with 98 pytest checks, Ruff, JavaScript syntax, and headless Chrome DOM/scroll/order regression.
- Consolidated task handling into explicit good/bad lanes. `bucket=good` contains queued, processing, and completed work; `bucket=bad` contains only failed, retryable work. Admin batch details and the employee workbench now expose the same two-list model, and a successful retry moves the task back to the good lane's retry-priority section.
- Reclassified 24 historical tasks that were incorrectly marked completed despite having no formal, fuzzy, or rejected pool into the bad lane with actionable retry reasons; preserved their original image and diagnostics data and kept an external SQLite backup.
- Closed the unfinished-task workflow: failed tasks are now queryable through `GET /v1/images/tasks?status=failed`, shown in a dedicated admin “异常队列” with failure reasons, editable retry names, name history, formal-image counts, and explicit “重新搜索/查看详情” actions. A retry removes the item from the abnormal queue and places it in the prioritized active queue.
- Fixed batch refresh flicker: batch cards are now patched by batch ID without rebuilding the list or its open completed/pending detail panel. Request sequencing also prevents an older refresh response from overwriting newer progress.
- Fixed employee workbench flicker: removed the double render during every sync and changed the employee task list to keyed in-place updates that retain the selected task and queue scroll position.
- Fixed retry data loss: retries now snapshot the previous formal/fuzzy/rejected pools in `diagnostics.retry_snapshots` before starting a fresh active attempt; admin and employee details expose the historical pools for preview. Restored four explicitly identified tasks whose pools had already been cleared by the old retry path from the external SQLite backup, without changing their current query, failure reason, status, or retry history.
- Fixed queue refresh flicker after retry: existing task rows are now patched in place by task ID, while only new, completed, or reordered rows are inserted, moved, or removed; scroll and focus recovery remain as a fallback. Retries are now placed at the absolute top of the visible queue, ahead of processing and ordinary queued tasks, with a visible divider; admin/employee HTML responses are no-store so a browser cannot keep serving the old embedded script.
- Fixed retries that produced no formal, fuzzy, or rejected images: they now finish as unfinished with actionable rejection reasons and appear in the batch pending list; pending-list headers now have a clear divider.
- Fixed queue auto-refresh jumping the task workspace back to the top while an operator scrolls: unchanged payloads skip DOM replacement, visible task anchors are restored after updates, and an active cancel control keeps focus.
- Improved mobile layouts for both admin and employee workbenches: touch-sized controls, stacked intake/review actions, two-column image previews, safe-area spacing, compact navigation, and narrow-screen overflow protection at 320–480px widths.
- Reclassified 25 historical products in `batch_spu_brand_model_20260828` as unfinished when their formal plus fuzzy pools total 30 images or fewer; original pools and diagnostics remain intact, and no retry was started.
- Added an admin-managed blocked-domain list. A blocked domain and its subdomains are filtered before candidate pooling, with per-task blocked-domain hit counts preserved in diagnostics; the settings UI supports adding, updating notes, refreshing, and removing domains.
- Replaced the fixed 20-formal-image completion gate with three configurable first-pass tiers (`strict`, `balanced`, `broad`). Each task stores the selected tier and policy version; a completed search can now wait for human pool review even when the formal pool is smaller.
- Added persisted formal/candidate pool decisions. Admin and employee result views can preview every safe fuzzy/rejected image and move selected images between pools; decisions survive refresh and are cleared only by a fresh retry.
- Added `/admin/search-policy` read/update endpoints and an admin editor for the three tier thresholds and first-pass multipliers.
- Restored 73 rows in `batch_spu_brand_model_20260828` that were incorrectly failed by the retired threshold to completed, reviewable tasks while preserving each legacy error in `diagnostics.legacy_shortfall_error`.
- Enforced the formal-image threshold: any task with fewer than 20 validated formal images is now `failed`/未完成 with a precise shortfall reason; the 2026-08-28 batch was reclassified from 170 completed rows to 97 completed and 73 unfinished rows without deleting stored images or diagnostics.
- Added editable retry names. Single-task retry accepts an optional JSON `query`, preserves the original name, and exposes the complete `query_history` plus per-attempt previous/next names in admin and employee history views.
- Added real retry/requeue controls for failed tasks: administrators and employees can retry one task, while batch cards can requeue all failed children without rerunning completed rows. Each retry clears stale formal results, keeps diagnostics and retry history, and stops after the configurable TASK_RETRY_LIMIT (default 3).
- Reclassified the 32 zero-result tasks in the 2026-08-28 batch as unfinished/failed with per-task reasons, and surfaced those reasons in the admin batch list and employee task detail view; the original diagnostics and objects were retained.
- Added settings-driven retries for transient Provider network failures; exhausted outages now mark empty tasks as `failed` with provider diagnostics instead of silently reporting completed zero-result tasks, while validation-only shortfalls remain completed.
- Guarded admin history/batch result loading with request sequencing and task-ID checks so stale responses cannot overwrite the selected task's result workspace; the workspace now records the rendered task ID.
- Fixed migrated task results whose stored image URLs still pointed to a local `127.0.0.1` origin; API responses now rewrite internal file URLs to the active public base so historical previews work after server migration.
- Standardized the Alibaba ECS public image base to `http://127.0.0.1:8000`; the legacy `images.panasia.fun` host is not used by the workbench.
- Deployed the employee workbench to Alibaba Cloud ECS behind the existing `panel.panasia.fun` HTTPS entry; the application container is private to the Caddy network and uses production authentication settings.
- Retired the unused OpenClaw container from the ECS and preserved its files in a dated disabled directory for rollback; existing `demo.panasia.fun` routing remains unchanged.
- Added optional `EMPLOYEE_ACCESS_TOKEN` protection for the employee page and APIs, so a temporary public tunnel can be shared without exposing the employee workbench anonymously; the token is exchanged for an HttpOnly cookie on first open.
- Added an independent employee workbench at `/employee`: an employee can upload the daily intake Excel once, automatically create and queue all model crawl tasks, monitor today's progress, claim unassigned completed tasks, preview returned images and submit an approval or needs-changes review.
- Added persisted task ownership and review lifecycle fields (`assignee`, `review_status`, reviewer, note and timestamp), plus employee intake/workbench/claim/review APIs. Existing administrator imports and task queues remain compatible.
- Reordered result pools to formal → fuzzy → rejected and made both fuzzy and rejected preview pools expanded by default for immediate review.
- Added an always-visible fuzzy-query strip above the candidate/预选词 details; terms are derived from actual fuzzy-preview hits and remain clickable for reuse.
- Grouped result diagnostics into one compact “检索详情” disclosure card; summaries, classifications, candidate queries and strategy logs now expand only when requested.
- Removed the outer rounded console frame and white canvas block so the admin workspace reads as an open, full-bleed control surface; borders and elevation now belong only to meaningful module cards.
- Refactored the admin workbench into a console-style overview with focused module workspaces for search, batches, queue, history and settings; modules no longer stack into one long page.
- Changed result viewing to open at the top of the in-page result workspace; candidate pools remain available through an explicit “查看候选池” action instead of forcing a scroll to the bottom.
- Added overview cards for active tasks, latest batch completion, history count and batch completion rate, plus module navigation badges and compact mobile fallback.
- Added clickable candidate search-term buttons to the admin workbench; clicking one fills the query field and starts a new search.
- Added a task queue view with queue position, live phase progress, elapsed time and conservative/dynamic ETA display.
- Added cancellation for queued and active retrieval tasks; cancelled tasks are terminal and do not overwrite later results.
- Added task progress timestamps and queue/cancel API endpoints: `GET /v1/images/tasks` and `POST /v1/images/tasks/{task_id}/cancel`.
- Added a history-task entry with a visible “查看结果” button; completed tasks can reopen their formal, fuzzy and rejected preview pools, while cancelled tasks explain why no final pool is available.
- Added persisted Excel batch imports with per-row SPU/task association, batch cancellation, batch progress counts/percentages, and separate admin lists for completed and unfinished items.

## 0.2.0 - 2026-08-19 (V23 final)

- Finalized the target-mode three-pool retrieval pipeline with S-35 fast-tail second-pass previews.
- Kept S-34 public-page fan-out available but disabled by default after its low-yield smoke result.
- Recorded the final AOC 24G10ZNE smoke: formal 11, fuzzy 150, rejected 668, 829 total images.

## Experimental: high-coverage-retrieval-20260819 - 2026-08-19

- Added bounded multi-wave query execution with community and marketplace `site:` hints.
- Added candidate interleaving and deeper validation for 50/100-image tasks.
- Added bounded source-page image expansion for public review, listing and article pages.
- Added an admin entry for safe previews of decoded rejected candidates, with reason and source metadata.
- Added three result pools: formal images, fuzzy/near-model previews and rejected previews; only the formal pool enters the API result list.
- Added admin limits 30/50/100/300/500 and recorded strategy IDs S-01 through S-06 with query/candidate/validated counts.
- Added S-04 rare-SKU expansion and S-06 bulk-result expansion, both bounded and visible in diagnostics.
- Added experimental S-07 adaptive fanout from near-model tokens and newly discovered source domains.
- Added experimental S-08 wide fuzzy-pool retention for decoded near-model and below-size candidates, with a separate 300-item fuzzy preview cap.
- Added experimental S-09 deep source-page/gallery expansion and S-10 conservative public CDN URL-variant recovery.
- Added experimental S-11 same-site one-hop gallery/review/comment expansion and S-12 embedded media-manifest extraction.
- Added experimental S-13 family fuzzy retention for same-brand, same-size/category near-model previews without formal-pool promotion.
- Added experimental S-14 target-mode Bing result pagination and explicit pagination strategy attribution.
- Added experimental S-16 target-mode evaluation reservoir expansion, increasing the number of already-found candidates that receive download/decode validation.
- Added experimental S-17 query-shape fanout for compact SKU spacing, hyphenation, boundary splits and discovered source domains.
- Added experimental S-18 target-mode preview reservoirs with independent 1000-item fuzzy/rejected caps; formal scoring remains unchanged.
- Added experimental S-19 formal-pool overflow retention for validated candidates that miss the requested formal result limit; overflow items are labeled and kept preview-only.
- Added experimental S-20 target-mode Bing tail pagination through pages 4 and 5 with separate candidate attribution.
- Added experimental S-21 deep target validation reservoir with 30x candidate validation and 3000/3000 preview caps.
- Added experimental S-22 second-hop source-page expansion for public galleries, reviews and related pages.
- Added experimental S-23 full-model/source-domain/intent query matrix for target-mode recall.
- Added experimental S-24 multilingual full-model/source-domain/intent matrix.
- Added experimental S-25 model-family visual-neighbor recall into preview-only pools.
- Added experimental S-26 core-candidate-first validation ordering to protect formal-pool slots while retaining expansion previews.
- Added experimental S-27 ultra-deep target validation reservoir with a bounded 5000-candidate evaluation window.
- Added experimental S-29 large fuzzy/rejected preview reservoirs with 6000/6000 target-mode capacities.
- Added experimental S-30 with a 12000-candidate reservoir, an 8000-candidate target evaluation window and an 80x extreme validation segment; a real AOC 24G10ZNE run produced 6,920 safe previews but took about 34 minutes, so it remains an asynchronous deep-retrieval experiment.
- Added experimental S-31 with a stratified 20000-candidate reservoir, a 12000-candidate target evaluation window and 12000/12000 preview caps; a constrained smoke confirmed core/near/broad diagnostics and task persistence, while the full run exceeded 55 minutes without completion and remains un-deployed.
- Added experimental S-33 public source-domain carousel queries; an AOC smoke produced 569 safe images (formal 7, fuzzy 64, rejected 498) at the cost of a much longer query phase, so it remains target-mode only.
- Added experimental S-34 public-page gallery fan-out from already observed same-brand/category pages; it added 55 page candidates in the smoke but no confirmed safe-preview increase, so it remains optional and disabled by setting its page budget to zero.
- Added final V23 S-35 second fast-tail evaluation channel; after the main target window it evaluates additional broad candidates using only safe download/decode/size/dedup checks and keeps them preview-only. The final controlled smoke evaluated 600 main plus 300 extra candidates and produced 829 total safe images (formal 11, fuzzy 150, rejected 668); the default extra window is 1200 and is configurable.
- Added experimental S-32 fast wide-tail previews: broad-recall candidates can be safely downloaded, decoded and deduplicated into fuzzy/rejected preview pools without bypassing formal evidence checks; the constrained smoke produced 471 safe previews (formal 10, fuzzy 168, rejected 303), while the full run was intentionally stopped before completion and is not counted.
- Added graceful cancellation for active retrieval tasks during service shutdown and fixed final evaluation batches so they never exceed the configured candidate limit.
- Added streaming validation and a bounded, new-wave-preserving candidate reservoir for long target-mode tasks.
- Raised default fuzzy/rejected preview caps to 500/300 on the experimental branch; both pools remain preview-only.
- Recorded live sample results and performance trade-offs in `docs/EXPERIMENTAL_HIGH_COVERAGE_2026-08-19.md`.
- Kept all changes isolated on the experiment branch; this is not a stable release.

## 0.1.1 - 2026-08-19

- Added a data-driven multilingual brand/model query planner for 15 languages.
- Added curated aliases for the requested ASUS/ROG, SANC, Dyson, Xiaomi and major global brands.
- Added market-aware platform eligibility diagnostics and locale-isolated task caching.
- Added Unicode normalization and model-alias evidence scoring without inventing unknown translations.
- Added the admin language selector, query-plan diagnostics, market catalog and maintenance guide.

## 0.1.0 - 2026-08-18

- Initial standalone product image retrieval service.
- Added asynchronous task API, pluggable providers, image validation, deduplication, local storage and admin credential configuration.
- Added Docker deployment, security controls, research notes and test scaffolding.
- Added an integrated lightweight search workbench with organized summaries, source distribution, image previews and copyable notes.
- Added an editable platform orchestration manifest and admin control plane with platform/component counts, health labels, enable/disable overrides and reload support.
- Added `image_mode` and platform-scoped task planning so real-photo, catalog-image and all-image searches remain cache-isolated.
- Updated the Docker profile for an 8C16G host with a single browser worker and persisted orchestration configuration.
- Restored the default all-image search path, added 20/50/100 result limits and image classification/source contribution summaries.
- Added the unified Adapter registry with bounded parallel execution and local-development-only admin access bypass.
