// Durable WMS/API-SPU state boundary.
//
// The renderer never reads this module.  It exists so the resident sync
// service has one small, testable place for schema migration, metadata
// sanitisation and last-good snapshot bookkeeping.  The default adapter uses
// task-store's electron-store instance; tests can inject plain read/write
// functions and therefore never need a live Electron window or credentials.

export const WMS_SYNC_SCHEMA_VERSION = 1
export const WMS_STALE_AFTER_MS = 24 * 60 * 60 * 1000

const SAFE_ERROR_RE = /((?:authorization|bearer|token|password|secret|session|cookie|api[_-]?key|access[_-]?key)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi

function text(value) {
  return String(value ?? '').trim()
}

export function safeWmsPersistenceError(value, fallback = 'WMS 同步失败') {
  const raw = value instanceof Error ? value.message : value?.message || value?.safeReason || value
  const message = text(raw).replace(SAFE_ERROR_RE, '$1=[REDACTED]').replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]')
  if (!message) return fallback
  if (/ENOENT|ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(message)) return fallback
  return message.slice(0, 240)
}

export function emptyWmsSyncState({ now = null, source = '' } = {}) {
  return {
    schemaVersion: WMS_SYNC_SCHEMA_VERSION,
    source: text(source),
    status: 'unconfigured',
    lastAttemptAt: null,
    lastSuccessAt: null,
    stale: false,
    retry: 0,
    nextRetryAt: null,
    safeError: '',
    attempt: 0,
    counts: { skuTotal: 0, spuTotal: 0, invalidSpuRows: 0 },
    snapshotHash: '',
    updatedAt: now || null
  }
}

function numberOr(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

export function sanitizeWmsSyncState(input = {}, { now = Date.now() } = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const lastSuccessAt = raw.lastSuccessAt || null
  const lastSuccessMs = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN
  const stale = Number.isFinite(lastSuccessMs) ? now - lastSuccessMs > WMS_STALE_AFTER_MS : false
  const counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : raw
  const status = ['unconfigured', 'syncing', 'synced', 'stale', 'failed'].includes(raw.status) ? raw.status : 'unconfigured'
  const result = {
    schemaVersion: WMS_SYNC_SCHEMA_VERSION,
    source: text(raw.source),
    status: stale && status === 'synced' ? 'stale' : status,
    lastAttemptAt: raw.lastAttemptAt || null,
    lastSuccessAt,
    stale,
    retry: Math.min(3, Math.max(0, Math.floor(numberOr(raw.retry)))),
    nextRetryAt: raw.nextRetryAt || null,
    safeError: safeWmsPersistenceError(raw.safeError || '', ''),
    attempt: Math.max(0, Math.floor(numberOr(raw.attempt))),
    counts: {
      skuTotal: Math.floor(numberOr(counts.skuTotal ?? counts.total)),
      spuTotal: Math.floor(numberOr(counts.spuTotal)),
      invalidSpuRows: Math.floor(numberOr(counts.invalidSpuRows))
    },
    snapshotHash: text(raw.snapshotHash).slice(0, 128),
    updatedAt: raw.updatedAt || null
  }
  // A stale snapshot remains useful.  It is never represented as an empty
  // cache and a failed refresh must not erase its success timestamp.
  if (result.stale && result.status === 'synced') result.status = 'stale'
  return result
}

export function snapshotCounts(rows = [], catalog = null) {
  const list = Array.isArray(rows) ? rows : []
  return {
    skuTotal: list.length,
    spuTotal: Number(catalog?.items?.length) || 0,
    invalidSpuRows: Number(catalog?.invalidRows?.length) || 0
  }
}

export function createWmsPersistence({
  readState = () => null,
  writeState = () => {},
  readSnapshot = () => [],
  writeSnapshot = () => {},
  now = () => Date.now()
} = {}) {
  let state = sanitizeWmsSyncState(readState() || {}, { now: now() })

  const persist = (next) => {
    state = sanitizeWmsSyncState({ ...state, ...next, updatedAt: new Date(now()).toISOString() }, { now: now() })
    writeState(state)
    return state
  }

  return {
    getState() {
      state = sanitizeWmsSyncState(readState() || state, { now: now() })
      return { ...state, counts: { ...state.counts } }
    },
    setState(next) {
      return persist(next)
    },
    saveSnapshot(rows, nextState = {}) {
      // The caller validates a complete IN_STOCK response before reaching this
      // boundary.  Write the snapshot first, then its metadata; on exceptions
      // the old metadata still points at the previous complete snapshot.
      writeSnapshot(Array.isArray(rows) ? rows : [])
      return persist(nextState)
    },
    readSnapshot() {
      const rows = readSnapshot()
      return Array.isArray(rows) ? rows : []
    },
    migrateLegacy({ legacyState = {}, legacySecrets = {}, saveSecrets = null, clearLegacySecrets = null } = {}) {
      const legacy = legacyState && typeof legacyState === 'object' ? legacyState : {}
      const secrets = legacySecrets && typeof legacySecrets === 'object' ? legacySecrets : {}
      let secretMigrated = false
      let secretBlocked = false
      const hasSecrets = [secrets.mcpKey, secrets.restUsername, secrets.restPassword].some((value) => text(value))
      if (hasSecrets) {
        if (typeof saveSecrets === 'function' && saveSecrets(secrets) === true) {
          secretMigrated = true
          if (typeof clearLegacySecrets === 'function') clearLegacySecrets()
        } else {
          // Never copy secrets to a new plaintext location when safe storage
          // is unavailable.  Leave the old record untouched for recovery.
          secretBlocked = true
        }
      }
      const legacySyncedAt = legacy.lastSuccessAt || legacy.wmsSyncedAt || null
      const migrated = sanitizeWmsSyncState({
        ...state,
        ...legacy,
        lastSuccessAt: legacySyncedAt,
        status: legacySyncedAt ? 'synced' : state.status,
        counts: legacy.counts || { skuTotal: numberOr(legacy.skuTotal), spuTotal: numberOr(legacy.spuTotal) }
      }, { now: now() })
      persist(migrated)
      return { ok: !secretBlocked, changed: true, secretMigrated, secretBlocked, state: migrated }
    }
  }
}

// Production adapter. Kept lazy so pure Node regressions can inject their own
// stores without loading Electron's safeStorage implementation.
export function createTaskStoreWmsPersistence(taskStore) {
  if (!taskStore) throw new TypeError('taskStore is required')
  return createWmsPersistence({
    readState: () => taskStore.getWmsSyncState?.() || null,
    writeState: (state) => taskStore.setWmsSyncState?.(state),
    readSnapshot: () => taskStore.getWmsSkus?.() || [],
    writeSnapshot: (rows) => taskStore.setWmsSkus?.(rows)
  })
}

export function migrateTaskStoreWmsState(taskStore) {
  if (!taskStore) throw new TypeError('taskStore is required')
  const current = taskStore.getWmsSyncState?.() || {}
  const syncedAt = taskStore.getWmsSyncedAt?.() || null
  const rows = taskStore.getWmsSkus?.() || []
  if (current.lastSuccessAt || !syncedAt) return { ok: true, changed: false, state: current }
  const next = sanitizeWmsSyncState({
    ...current,
    source: current.source || 'legacy-cache',
    status: 'synced',
    lastSuccessAt: syncedAt,
    counts: { ...(current.counts || {}), skuTotal: Array.isArray(rows) ? rows.length : 0 }
  })
  taskStore.setWmsSyncState?.(next)
  return { ok: true, changed: true, state: next }
}
