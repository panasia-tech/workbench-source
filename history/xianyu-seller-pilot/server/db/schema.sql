PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'read_only')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_profiles (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('fake', 'adspower', 'camoufox')),
  vendor_profile_id TEXT NOT NULL,
  label TEXT NOT NULL,
  user_data_dir TEXT,
  proxy_label TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'disabled', 'blocked')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  control_requested TEXT CHECK (control_requested IN ('pause') OR control_requested IS NULL),
  profile_id TEXT,
  operator_id TEXT,
  worker_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  retry_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (profile_id) REFERENCES browser_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_profile ON jobs(profile_id, created_at);

-- A durable lock joins manual H5 browser control and server Workers. The
-- lease expires with the owning process/job so a crashed worker cannot strand
-- a profile forever, and the primary key prevents two owners across processes.
CREATE TABLE IF NOT EXISTS browser_profile_locks (
  profile_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES browser_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_browser_profile_locks_expiry ON browser_profile_locks(lease_expires_at);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  job_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  profile_id TEXT,
  interval_ms INTEGER NOT NULL CHECK (interval_ms >= 1000),
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES browser_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS job_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_cursor ON job_events(job_id, cursor);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Server-side workbench authority. These tables replace the employee-local
-- electron-store/JSONL projection for the H5 path while keeping the desktop
-- client available as a rollback surface during migration.
CREATE TABLE IF NOT EXISTS workbench_settings (
  id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS task_collections (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  imported_at TEXT NOT NULL,
  archived_at TEXT,
  created_by TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_collections_status ON task_collections(status, imported_at);

CREATE TABLE IF NOT EXISTS workbench_tasks (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  category TEXT,
  brand TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  alias TEXT,
  spu_code TEXT,
  reference_price REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  search_keywords_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES task_collections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workbench_tasks_collection ON workbench_tasks(collection_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workbench_tasks_spu ON workbench_tasks(spu_code);

-- Operator identity/review metadata belongs to the server projection, not the
-- imported Excel row.  Keeping it in an override table preserves the source
-- collection and all historical result rows while allowing a corrected task
-- to be used by the next explicit re-collection.
CREATE TABLE IF NOT EXISTS workbench_task_overrides (
  task_id TEXT PRIMARY KEY,
  override_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (task_id) REFERENCES workbench_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_workbench_task_overrides_updated ON workbench_task_overrides(updated_at DESC);

CREATE TABLE IF NOT EXISTS workbench_runs (
  id TEXT PRIMARY KEY,
  collection_id TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
  total INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  empty INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  invalid_price INTEGER NOT NULL DEFAULT 0,
  risk_control INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_by TEXT,
  FOREIGN KEY (collection_id) REFERENCES task_collections(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_workbench_runs_started ON workbench_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS workbench_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  price REAL,
  reason TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES workbench_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES workbench_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workbench_results_task_created ON workbench_results(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workbench_results_run ON workbench_results(run_id, created_at);

CREATE TABLE IF NOT EXISTS spu_policies (
  spu_code TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (1, 'bootstrap');
INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (2, 'schedules');
INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (3, 'job retry_at');
INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (4, 'h5 workbench authority');
INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (5, 'durable job pause intent');

-- Server-side seller evidence workbench. The employee browser receives only
-- these projections; paths, cookies and provider debug payloads stay on the
-- server/worker boundary.
CREATE TABLE IF NOT EXISTS seller_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
  total INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  incomplete INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_by TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_seller_runs_started ON seller_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS seller_sources (
  id TEXT PRIMARY KEY,
  seller_id TEXT,
  seller_url TEXT NOT NULL,
  seller_name TEXT,
  main_content TEXT,
  main_type TEXT,
  category TEXT,
  board TEXT,
  board_name TEXT,
  source_board_ranks TEXT,
  source_rank INTEGER,
  source_ordinal INTEGER,
  source_slot_count INTEGER,
  cities TEXT,
  excel_row INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  reason_code TEXT,
  reason TEXT,
  active_count INTEGER,
  expected_active INTEGER,
  sold_count INTEGER,
  expected_sold INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  snapshot_artifact_id TEXT,
  snapshot_at TEXT,
  last_run_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seller_sources_status ON seller_sources(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_sources_seller ON seller_sources(seller_id);

CREATE TABLE IF NOT EXISTS seller_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  run_id TEXT,
  item_id TEXT,
  title TEXT,
  category TEXT,
  branch TEXT,
  price REAL,
  item_status TEXT,
  item_url TEXT,
  captured_at TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (source_id) REFERENCES seller_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES seller_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_seller_items_source ON seller_items(source_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS seller_settings (
  id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Server-authoritative WMS inventory snapshot.  The raw upstream response is
-- retained per SKU for audit/readback, while the sync state is a single durable
-- record so H5 can distinguish a live snapshot from an unconfigured/failed one.
CREATE TABLE IF NOT EXISTS wms_inventory_items (
  sku_code TEXT PRIMARY KEY,
  spu_code TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wms_inventory_spu ON wms_inventory_items(spu_code);

CREATE TABLE IF NOT EXISTS wms_sync_state (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unconfigured',
  source TEXT,
  sku_total INTEGER NOT NULL DEFAULT 0,
  spu_total INTEGER NOT NULL DEFAULT 0,
  invalid_spu_rows INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  safe_error TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (6, 'server seller workbench authority');
INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (7, 'server WMS inventory snapshot');
INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (8, 'server workbench task overrides');
INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (9, 'durable browser profile locks');
