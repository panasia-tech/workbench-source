/**
 * 闲鱼上新本机 SQLite（node:sqlite DatabaseSync）
 * 存：推送/检查/抢单日志、已推 ID、卖家明文映射、列表快照
 *
 * 改表/加列：不要只改 SCHEMA_SQL。须同步抬 schema 版本并追加迁移，见
 * `sxjk-local-db-schema-migrations.js` 与规则 `sxjk-local-sqlite-schema.mdc`。
 *
 * 所有 prepare/exec 经 wrap 后打印 `[本机SQL]`，便于排查。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** @type {DatabaseSync | null} */
let dbInstance = null
/** @type {string} */
let dbPathCached = ''

const SQL_LOG_SQL_MAX = 240
const SQL_LOG_ARG_MAX = 160

/**
 * @param {unknown} v
 */
function clipSqlLogValue(v) {
  if (v == null) return v
  if (typeof v === 'string') {
    if (v.length <= SQL_LOG_ARG_MAX) return v
    return `${v.slice(0, SQL_LOG_ARG_MAX)}…(${v.length})`
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v
  try {
    const s = JSON.stringify(v)
    if (s.length <= SQL_LOG_ARG_MAX) return s
    return `${s.slice(0, SQL_LOG_ARG_MAX)}…(${s.length})`
  } catch {
    return String(v)
  }
}

/**
 * @param {string} op
 * @param {string} sql
 * @param {unknown[]} [args]
 */
export function logSxjkLocalSql(op, sql, args) {
  const oneLine = String(sql || '')
    .replace(/\s+/g, ' ')
    .trim()
  const shown =
    oneLine.length > SQL_LOG_SQL_MAX
      ? `${oneLine.slice(0, SQL_LOG_SQL_MAX)}…(${oneLine.length})`
      : oneLine
  if (Array.isArray(args) && args.length) {
    console.log(`[本机SQL] ${op}`, shown, args.map(clipSqlLogValue))
  } else {
    console.log(`[本机SQL] ${op}`, shown)
  }
}

/**
 * @param {import('node:sqlite').StatementSync} stmt
 * @param {string} sql
 */
function wrapSxjkLocalStatementWithSqlLog(stmt, sql) {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      if (prop === 'run' || prop === 'get' || prop === 'all') {
        return (...args) => {
          logSxjkLocalSql(String(prop), sql, args)
          return target[prop](...args)
        }
      }
      const val = Reflect.get(target, prop, receiver)
      return typeof val === 'function' ? val.bind(target) : val
    }
  })
}

/**
 * 包装 DatabaseSync：exec / prepare→run|get|all 均打印 SQL
 * @param {DatabaseSync} db
 * @returns {DatabaseSync}
 */
export function wrapSxjkLocalDbWithSqlLog(db) {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'exec') {
        return (sql) => {
          logSxjkLocalSql('exec', sql)
          return target.exec(sql)
        }
      }
      if (prop === 'prepare') {
        return (sql) => {
          const stmt = target.prepare(sql)
          return wrapSxjkLocalStatementWithSqlLog(stmt, sql)
        }
      }
      const val = Reflect.get(target, prop, receiver)
      return typeof val === 'function' ? val.bind(target) : val
    }
  })
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS migrate_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS log_entries (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  at TEXT NOT NULL,
  at_ms INTEGER NOT NULL DEFAULT 0,
  task_id TEXT NOT NULL DEFAULT '',
  monitor_id TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  success INTEGER NOT NULL DEFAULT 0,
  dingtalk_skipped INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  ok_flag INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_log_entries_kind_at ON log_entries(kind, at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_log_entries_kind_task ON log_entries(kind, task_id);
CREATE INDEX IF NOT EXISTS idx_log_entries_kind_monitor ON log_entries(kind, monitor_id);

CREATE TABLE IF NOT EXISTS pushed_item_ids (
  scope TEXT NOT NULL,
  item_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (scope, item_id)
);
CREATE INDEX IF NOT EXISTS idx_pushed_item_ids_scope_seq ON pushed_item_ids(scope, seq);

CREATE TABLE IF NOT EXISTS seller_plain_map (
  seller_key TEXT PRIMARY KEY,
  plain_user_id TEXT NOT NULL,
  nick TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listing_snapshots (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  saved_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS app_local_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pc_client_pref (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  listen_poll_interval_sec REAL NOT NULL DEFAULT 300,
  shop_poll_interval_sec REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT ''
);
`

export const LOG_KIND = {
  push: 'push',
  pollCheck: 'poll_check',
  grab: 'grab',
  shopPush: 'shop_push'
}

export const PUSHED_SCOPE = {
  global: 'global',
  shop: 'shop'
}

/**
 * @param {string} dbFilePath
 * @returns {DatabaseSync}
 */
export function openSxjkLocalDb(dbFilePath) {
  const fp = String(dbFilePath || '').trim()
  if (!fp) throw new Error('sxjk local db path empty')
  if (dbInstance && dbPathCached === fp) return dbInstance
  if (dbInstance) {
    try {
      dbInstance.close()
    } catch {
      /* */
    }
    dbInstance = null
  }
  mkdirSync(dirname(fp), { recursive: true })
  const raw = new DatabaseSync(fp)
  const db = wrapSxjkLocalDbWithSqlLog(raw)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA_SQL)
  dbInstance = db
  dbPathCached = fp
  return db
}

/** @returns {DatabaseSync} */
export function getSxjkLocalDb() {
  if (!dbInstance) throw new Error('sxjk local db not opened')
  return dbInstance
}

export function getSxjkLocalDbPath() {
  return dbPathCached
}

export function closeSxjkLocalDb() {
  if (!dbInstance) return
  try {
    dbInstance.close()
  } catch {
    /* */
  }
  dbInstance = null
  dbPathCached = ''
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 */
export function getMigrateMeta(db, key) {
  const row = db.prepare('SELECT value FROM migrate_meta WHERE key = ?').get(String(key))
  return row ? String(row.value || '') : ''
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {string} value
 */
export function setMigrateMeta(db, key, value) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO migrate_meta(key, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(String(key), String(value), now)
}

/**
 * @param {DatabaseSync} db
 * @param {() => any} fn
 */
export function runInTransaction(db, fn) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* */
    }
    throw e
  }
}

/**
 * @param {unknown} entry
 */
export function parseAtMs(entry) {
  const t = Date.parse(String(entry?.at || ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 * @returns {object[]}
 */
export function readLogEntries(db, kind) {
  const rows = db
    .prepare(
      `SELECT payload_json FROM log_entries WHERE kind = ? ORDER BY at_ms DESC, id DESC`
    )
    .all(String(kind))
  const out = []
  for (const row of rows) {
    try {
      const j = JSON.parse(String(row.payload_json || ''))
      if (j && typeof j === 'object') out.push(j)
    } catch {
      /* skip bad row */
    }
  }
  return out
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 * @param {object} entry
 * @param {{ maxLogs?: number }} [opts]
 */
export function insertLogEntry(db, kind, entry, opts = {}) {
  const id = String(entry?.id || '').trim()
  if (!id) throw new Error('log entry missing id')
  const at = String(entry?.at || new Date().toISOString())
  const atMs = parseAtMs({ at })
  const taskId = String(entry?.taskId || '').trim()
  const monitorId = String(entry?.monitorId || '').trim()
  const keyword = String(entry?.keyword || '').trim()
  const success = entry?.success === false || entry?.success === '0' ? 0 : entry?.success ? 1 : 0
  const dingtalkSkipped =
    entry?.dingtalkSkipped === true || entry?.dingtalkSkipped === '1' || entry?.dingtalkSkipped === 1
      ? 1
      : 0
  const itemCount = Math.max(0, Math.min(500, parseInt(entry?.itemCount, 10) || 0))
  const okFlag = entry?.ok ? 1 : 0
  const payload = JSON.stringify(entry)
  db.prepare(
    `INSERT INTO log_entries(
      kind, id, at, at_ms, task_id, monitor_id, keyword, success, dingtalk_skipped, item_count, ok_flag, payload_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(kind, id) DO UPDATE SET
      at=excluded.at, at_ms=excluded.at_ms, task_id=excluded.task_id, monitor_id=excluded.monitor_id,
      keyword=excluded.keyword, success=excluded.success, dingtalk_skipped=excluded.dingtalk_skipped,
      item_count=excluded.item_count, ok_flag=excluded.ok_flag, payload_json=excluded.payload_json`
  ).run(
    String(kind),
    id,
    at,
    atMs,
    taskId,
    monitorId,
    keyword,
    success,
    dingtalkSkipped,
    itemCount,
    okFlag,
    payload
  )
  const maxLogs = opts.maxLogs
  if (Number.isFinite(maxLogs) && maxLogs > 0) {
    trimLogEntries(db, kind, maxLogs)
  }
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 * @param {object[]} entries newest-first
 * @param {{ maxLogs?: number }} [opts]
 */
export function replaceAllLogEntries(db, kind, entries, opts = {}) {
  const k = String(kind)
  const maxLogs = Number.isFinite(opts.maxLogs) && opts.maxLogs > 0 ? opts.maxLogs : null
  const list = Array.isArray(entries) ? entries : []
  const sliced = maxLogs != null ? list.slice(0, maxLogs) : list
  const tx = () => {
    db.prepare('DELETE FROM log_entries WHERE kind = ?').run(k)
    const stmt = db.prepare(
      `INSERT INTO log_entries(
        kind, id, at, at_ms, task_id, monitor_id, keyword, success, dingtalk_skipped, item_count, ok_flag, payload_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    for (const entry of sliced) {
      const id = String(entry?.id || '').trim()
      if (!id) continue
      const at = String(entry?.at || '')
      stmt.run(
        k,
        id,
        at,
        parseAtMs({ at }),
        String(entry?.taskId || '').trim(),
        String(entry?.monitorId || '').trim(),
        String(entry?.keyword || '').trim(),
        entry?.success === false || entry?.success === '0' ? 0 : entry?.success ? 1 : 0,
        entry?.dingtalkSkipped === true || entry?.dingtalkSkipped === '1' || entry?.dingtalkSkipped === 1
          ? 1
          : 0,
        Math.max(0, Math.min(500, parseInt(entry?.itemCount, 10) || 0)),
        entry?.ok ? 1 : 0,
        JSON.stringify(entry)
      )
    }
  }
  runInTransaction(db, tx)
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 * @param {number} maxLogs
 */
export function trimLogEntries(db, kind, maxLogs) {
  const k = String(kind)
  const n = Math.max(1, Math.floor(maxLogs))
  const countRow = db.prepare('SELECT COUNT(*) AS c FROM log_entries WHERE kind = ?').get(k)
  const c = Number(countRow?.c || 0)
  if (c <= n) return
  const drop = c - n
  db.prepare(
    `DELETE FROM log_entries WHERE rowid IN (
      SELECT rowid FROM log_entries WHERE kind = ? ORDER BY at_ms ASC, id ASC LIMIT ?
    )`
  ).run(k, drop)
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 */
export function clearLogEntries(db, kind) {
  db.prepare('DELETE FROM log_entries WHERE kind = ?').run(String(kind))
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 * @param {Set<string>|string[]} ids
 * @returns {number}
 */
export function deleteLogEntriesByIds(db, kind, ids) {
  const idSet = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids.map(String) : [])
  if (!idSet.size) return 0
  const stmt = db.prepare('DELETE FROM log_entries WHERE kind = ? AND id = ?')
  let deleted = 0
  runInTransaction(db, () => {
    for (const id of idSet) {
      const r = stmt.run(String(kind), String(id))
      deleted += Number(r.changes || 0)
    }
  })
  return deleted
}

/**
 * @param {DatabaseSync} db
 * @param {string} scope
 * @returns {string[]}
 */
export function getPushedItemIds(db, scope) {
  const rows = db
    .prepare('SELECT item_id FROM pushed_item_ids WHERE scope = ? ORDER BY seq ASC')
    .all(String(scope))
  return rows.map((r) => String(r.item_id || '').trim()).filter(Boolean)
}

/**
 * @param {DatabaseSync} db
 * @param {string} scope
 * @param {string[]} ids newest-first
 * @param {number} [maxIds]
 */
export function replacePushedItemIds(db, scope, ids, maxIds = 5000) {
  const s = String(scope)
  const seen = new Set()
  const list = []
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    list.push(id)
    if (list.length >= maxIds) break
  }
  runInTransaction(db, () => {
    db.prepare('DELETE FROM pushed_item_ids WHERE scope = ?').run(s)
    const stmt = db.prepare(
      'INSERT INTO pushed_item_ids(scope, item_id, seq) VALUES(?,?,?)'
    )
    for (let i = 0; i < list.length; i++) {
      stmt.run(s, list[i], i)
    }
  })
  return list
}

/**
 * @param {DatabaseSync} db
 * @param {string} scope
 * @param {unknown} newIds
 * @param {number} [maxIds]
 */
export function appendPushedItemIds(db, scope, newIds, maxIds = 5000) {
  const existing = getPushedItemIds(db, scope)
  const seen = new Set()
  const out = []
  for (const raw of [...(Array.isArray(newIds) ? newIds : []), ...existing]) {
    const id = String(raw || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= maxIds) break
  }
  return replacePushedItemIds(db, scope, out, maxIds)
}

/**
 * @param {DatabaseSync} db
 * @param {string} scope
 * @param {Set<string>} removeSet
 * @returns {number} removed count
 */
export function prunePushedItemIds(db, scope, removeSet) {
  if (!removeSet?.size) return 0
  const existing = getPushedItemIds(db, scope)
  const next = existing.filter((id) => !removeSet.has(id))
  const removed = existing.length - next.length
  replacePushedItemIds(db, scope, next)
  return removed
}

/**
 * @param {DatabaseSync} db
 * @returns {{ v: number, entries: Record<string, object> }}
 */
export function loadSellerPlainMap(db) {
  const rows = db
    .prepare('SELECT seller_key, plain_user_id, nick, avatar, updated_at FROM seller_plain_map')
    .all()
  /** @type {Record<string, object>} */
  const entries = {}
  for (const row of rows) {
    const k = String(row.seller_key || '').trim()
    if (!k) continue
    entries[k] = {
      plainUserId: String(row.plain_user_id || '').trim(),
      ...(row.nick ? { nick: String(row.nick) } : {}),
      ...(row.avatar ? { avatar: String(row.avatar) } : {}),
      updatedAt: String(row.updated_at || '')
    }
  }
  return { v: 1, entries }
}

/**
 * @param {DatabaseSync} db
 * @param {Record<string, object>} entries
 */
export function replaceSellerPlainMap(db, entries) {
  runInTransaction(db, () => {
    db.prepare('DELETE FROM seller_plain_map').run()
    const stmt = db.prepare(
      `INSERT INTO seller_plain_map(seller_key, plain_user_id, nick, avatar, updated_at)
       VALUES(?,?,?,?,?)`
    )
    for (const [k, v] of Object.entries(entries || {})) {
      const key = String(k || '').trim()
      if (!key) continue
      stmt.run(
        key,
        String(v?.plainUserId || '').trim(),
        String(v?.nick || '').trim(),
        String(v?.avatar || '').trim(),
        String(v?.updatedAt || new Date().toISOString())
      )
    }
  })
}

/**
 * @param {DatabaseSync} db
 * @param {{ sellerKey: string, plainUserId: string, nick?: string, avatar?: string, updatedAt?: string }} row
 */
export function upsertSellerPlainMapEntry(db, row) {
  db.prepare(
    `INSERT INTO seller_plain_map(seller_key, plain_user_id, nick, avatar, updated_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(seller_key) DO UPDATE SET
       plain_user_id=excluded.plain_user_id,
       nick=excluded.nick,
       avatar=excluded.avatar,
       updated_at=excluded.updated_at`
  ).run(
    String(row.sellerKey),
    String(row.plainUserId),
    String(row.nick || ''),
    String(row.avatar || ''),
    String(row.updatedAt || new Date().toISOString())
  )
}

/**
 * @param {DatabaseSync} db
 * @param {string[]} dropKeys
 */
export function deleteSellerPlainMapKeys(db, dropKeys) {
  const stmt = db.prepare('DELETE FROM seller_plain_map WHERE seller_key = ?')
  runInTransaction(db, () => {
    for (const k of dropKeys) stmt.run(String(k))
  })
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 * @param {string} id
 * @returns {object|null}
 */
export function readListingSnapshot(db, kind, id) {
  const row = db
    .prepare('SELECT payload_json FROM listing_snapshots WHERE kind = ? AND id = ?')
    .get(String(kind), String(id))
  if (!row) return null
  try {
    return JSON.parse(String(row.payload_json || ''))
  } catch {
    return null
  }
}

/**
 * @param {DatabaseSync} db
 * @param {object} payload
 */
export function writeListingSnapshot(db, payload) {
  const kind = String(payload?.kind || '').trim()
  const id = String(payload?.id || '').trim()
  if (!kind || !id) throw new Error('listing snapshot missing kind/id')
  db.prepare(
    `INSERT INTO listing_snapshots(kind, id, fingerprint, saved_at, payload_json)
     VALUES(?,?,?,?,?)
     ON CONFLICT(kind, id) DO UPDATE SET
       fingerprint=excluded.fingerprint,
       saved_at=excluded.saved_at,
       payload_json=excluded.payload_json`
  ).run(
    kind,
    id,
    String(payload?.fingerprint || ''),
    String(payload?.savedAt || new Date().toISOString()),
    JSON.stringify(payload)
  )
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 * @param {string} id
 */
export function deleteListingSnapshot(db, kind, id) {
  db.prepare('DELETE FROM listing_snapshots WHERE kind = ? AND id = ?').run(
    String(kind),
    String(id)
  )
}

/**
 * @param {DatabaseSync} db
 * @param {'all'|'task'|'shop'} scope
 */
export function clearListingSnapshots(db, scope) {
  if (scope === 'all') {
    db.prepare('DELETE FROM listing_snapshots').run()
    return
  }
  db.prepare('DELETE FROM listing_snapshots WHERE kind = ?').run(String(scope))
}

/**
 * 本机 KV（节流时间戳等）
 * @param {DatabaseSync} db
 * @param {string} key
 * @returns {string}
 */
export function getAppLocalState(db, key) {
  const k = String(key || '').trim()
  if (!k) return ''
  const row = db.prepare('SELECT value FROM app_local_state WHERE key = ?').get(k)
  return row ? String(row.value || '') : ''
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {string|number} value
 */
export function setAppLocalState(db, key, value) {
  const k = String(key || '').trim()
  if (!k) throw new Error('app_local_state key empty')
  const now = new Date().toISOString()
  const nowMs = Date.now()
  db.prepare(
    `INSERT INTO app_local_state(key, value, updated_at, updated_at_ms) VALUES(?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       value=excluded.value,
       updated_at=excluded.updated_at,
       updated_at_ms=excluded.updated_at_ms`
  ).run(k, String(value ?? ''), now, nowMs)
}

const LISTEN_POLL_SEC_DEFAULT = 300
const SHOP_POLL_SEC_DEFAULT = 1
const LISTEN_POLL_SEC_MIN = 3
const SHOP_POLL_MS_MIN = 100
const SHOP_POLL_MS_MAX = 86_400_000
const SHOP_POLL_MS_DEFAULT = 1000
const POLL_SEC_MAX = 86_400

function roundPollSec1(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return NaN
  return Math.round(n * 10) / 10
}

function clampListenPollSec(raw) {
  const n = roundPollSec1(raw)
  if (!Number.isFinite(n)) return LISTEN_POLL_SEC_DEFAULT
  return Math.min(POLL_SEC_MAX, Math.max(LISTEN_POLL_SEC_MIN, n))
}

function clampShopPollMs(rawMs) {
  const n = Math.floor(Number(rawMs))
  if (!Number.isFinite(n)) return SHOP_POLL_MS_DEFAULT
  return Math.min(SHOP_POLL_MS_MAX, Math.max(SHOP_POLL_MS_MIN, n))
}

function clampShopPollSec(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return SHOP_POLL_SEC_DEFAULT
  return clampShopPollMs(Math.round(n * 1000)) / 1000
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ exists: boolean, listen_poll_interval_sec: number, shop_poll_interval_sec: number, shop_poll_interval_ms: number }}
 */
export function getPcClientPref(db) {
  const row = db
    .prepare(
      'SELECT listen_poll_interval_sec, shop_poll_interval_sec FROM pc_client_pref WHERE id = 1'
    )
    .get()
  if (!row) {
    return {
      exists: false,
      listen_poll_interval_sec: LISTEN_POLL_SEC_DEFAULT,
      shop_poll_interval_sec: SHOP_POLL_SEC_DEFAULT,
      shop_poll_interval_ms: SHOP_POLL_MS_DEFAULT
    }
  }
  const shopSec = clampShopPollSec(row.shop_poll_interval_sec)
  return {
    exists: true,
    listen_poll_interval_sec: clampListenPollSec(row.listen_poll_interval_sec),
    shop_poll_interval_sec: shopSec,
    shop_poll_interval_ms: clampShopPollMs(Math.round(shopSec * 1000))
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ listen_poll_interval_sec?: number, shop_poll_interval_sec?: number, shop_poll_interval_ms?: number }} patch
 */
export function upsertPcClientPref(db, patch = {}) {
  const cur = getPcClientPref(db)
  const listen = Object.prototype.hasOwnProperty.call(patch, 'listen_poll_interval_sec')
    ? clampListenPollSec(patch.listen_poll_interval_sec)
    : cur.listen_poll_interval_sec
  let shop
  if (Object.prototype.hasOwnProperty.call(patch, 'shop_poll_interval_ms')) {
    shop = clampShopPollMs(patch.shop_poll_interval_ms) / 1000
  } else if (Object.prototype.hasOwnProperty.call(patch, 'shop_poll_interval_sec')) {
    shop = clampShopPollSec(patch.shop_poll_interval_sec)
  } else {
    shop = cur.shop_poll_interval_sec
  }
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO pc_client_pref(id, listen_poll_interval_sec, shop_poll_interval_sec, updated_at)
     VALUES(1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       listen_poll_interval_sec=excluded.listen_poll_interval_sec,
       shop_poll_interval_sec=excluded.shop_poll_interval_sec,
       updated_at=excluded.updated_at`
  ).run(listen, shop, now)
  return {
    exists: true,
    listen_poll_interval_sec: listen,
    shop_poll_interval_sec: shop,
    shop_poll_interval_ms: clampShopPollMs(Math.round(shop * 1000))
  }
}
