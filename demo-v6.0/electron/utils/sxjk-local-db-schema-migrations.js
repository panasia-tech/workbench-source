/**
 * 本机 sxjk-local.sqlite 的 schema 版本与增量迁移。
 * 改表结构时：抬 SCHEMA_VERSION + 追加一条 MIGRATIONS，并同步改 SCHEMA_SQL（给全新安装）。
 * 详见 .cursor/rules/sxjk-local-sqlite-schema.mdc
 */
import { getMigrateMeta, setMigrateMeta, runInTransaction } from './sxjk-local-db.js'

/**
 * 当前代码期望的 schema 版本（整数，从 1 起）。
 * 每次有破坏性/结构性变更必须 +1，并追加对应 MIGRATIONS 项。
 */
export const SXJK_LOCAL_SCHEMA_VERSION = 4

/**
 * 仅存放 version >= 2 的增量步骤；version 必须连续、不可改历史项。
 * @type {{ version: number, name: string, up: (db: import('node:sqlite').DatabaseSync) => void }[]}
 */
export const SXJK_LOCAL_SCHEMA_MIGRATIONS = [
  {
    version: 2,
    name: 'app_local_state',
    up(db) {
      db.exec(`
CREATE TABLE IF NOT EXISTS app_local_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);
`)
    }
  },
  {
    version: 3,
    name: 'pc_client_pref',
    up(db) {
      db.exec(`
CREATE TABLE IF NOT EXISTS pc_client_pref (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  listen_poll_interval_sec INTEGER NOT NULL DEFAULT 300,
  shop_poll_interval_sec INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT ''
);
`)
    }
  },
  {
    version: 4,
    name: 'pc_client_pref_poll_interval_real',
    up(db) {
      db.exec(`
CREATE TABLE pc_client_pref_v4 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  listen_poll_interval_sec REAL NOT NULL DEFAULT 300,
  shop_poll_interval_sec REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT ''
);
INSERT INTO pc_client_pref_v4 (id, listen_poll_interval_sec, shop_poll_interval_sec, updated_at)
SELECT id,
  CAST(listen_poll_interval_sec AS REAL),
  CAST(shop_poll_interval_sec AS REAL),
  updated_at
FROM pc_client_pref;
DROP TABLE pc_client_pref;
ALTER TABLE pc_client_pref_v4 RENAME TO pc_client_pref;
`)
    }
  }
]

/**
 * 在 openSxjkLocalDb 执行完 CREATE TABLE IF NOT EXISTS 之后调用。
 * - 无 schema_version：视为基线 1（首装或 JSON 迁库后的旧库）
 * - 再按序执行 version = cur+1 的迁移，写回 migrate_meta.schema_version
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function applySxjkLocalSchemaMigrations(db) {
  let cur = parseInt(getMigrateMeta(db, 'schema_version') || '0', 10)
  if (!Number.isFinite(cur) || cur < 0) cur = 0

  if (cur === 0) {
    setMigrateMeta(db, 'schema_version', '1')
    cur = 1
    console.log('[本机SQL] schema_version 初始化为 1')
  }

  const sorted = [...SXJK_LOCAL_SCHEMA_MIGRATIONS].sort((a, b) => a.version - b.version)
  for (const step of sorted) {
    const v = Number(step?.version)
    if (!Number.isFinite(v) || v < 2) {
      throw new Error(`[本机SQL] 非法迁移 version: ${step?.name || v}`)
    }
    if (v <= cur) continue
    if (v !== cur + 1) {
      throw new Error(`[本机SQL] 迁移版本不连续: db=${cur} next=${v} (${step.name})`)
    }
    try {
      runInTransaction(db, () => {
        step.up(db)
        setMigrateMeta(db, 'schema_version', String(v))
      })
      cur = v
      console.log(`[本机SQL] schema 升级到 ${v} (${step.name})`)
    } catch (e) {
      console.error(`[本机SQL] schema 升级失败 ${cur}→${v} (${step.name})`, e)
      throw e
    }
  }

  if (cur !== SXJK_LOCAL_SCHEMA_VERSION) {
    throw new Error(
      `[本机SQL] schema 版本不一致: db=${cur} code=${SXJK_LOCAL_SCHEMA_VERSION}（缺迁移或常量未抬）`
    )
  }
}
