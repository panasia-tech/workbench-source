// Application-lifecycle WMS synchronisation.
//
// This module owns the only background sync operation.  Pages, the scheduler
// and tray actions call refresh(); none of them create timers or talk to the
// upstream directly.  The implementation is dependency-injected so the
// retry/cache contract can be exercised without Electron or a real WMS key.

import * as taskStore from './task-store.js'
import { createTaskStoreWmsPersistence, emptyWmsSyncState, safeWmsPersistenceError, sanitizeWmsSyncState } from './wms-persistence.js'

export const WMS_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
export const WMS_RETRY_DELAY_MS = 15 * 60 * 1000
export const WMS_MAX_RETRIES = 3

function iso(now) {
  return new Date(now()).toISOString()
}

function defaultNow() {
  return Date.now()
}

async function defaultSync(options) {
  const { syncWmsSkus } = await import('./wms.js')
  return syncWmsSkus(options)
}

async function defaultIsConfigured() {
  const [store, task, erpSync] = await Promise.all([
    import('./store.js'),
    import('./task-store.js'),
    import('./erp-sync.js')
  ])
  const settings = task.getSettings()
  const secrets = store.getWmsSecrets()
  const source = settings.wmsSource || 'auto'
  // REST 只读现在用工作台自己的 ERP 登录态就能跑（服务端已放行 CRAWLER 读在库型号），
  // 所以「已登录」本身就算配好了；单独的管理账号只是回写和老机器的兼容路径。
  //
  // 这个判定必须与 resolveRestReadToken 真正能拿到令牌的条件一致：那边除了现成的
  // token，还会用私有凭据（erp-private.json / 环境变量）静默登录。少算这一项，
  // 装好但还没点过登录的机器会一直停在「尚未配置」，连试都不试。
  const privateCredentials = erpSync.readErpCredentials?.() || {}
  const canLogin = Boolean(store.getToken() || (privateCredentials.username && privateCredentials.password))
  const rest = Boolean((secrets.restUsername && secrets.restPassword) || canLogin)
  const mcp = Boolean(settings.wmsMcpUrl && secrets.mcpKey)
  return source === 'rest' ? rest : source === 'mcp' ? mcp : rest || mcp
}

function snapshotCounts(result, persistence) {
  const counts = result?.counts || {}
  const rows = persistence.readSnapshot()
  return {
    skuTotal: Number.isFinite(Number(result?.skuTotal)) ? Number(result.skuTotal) : (Number(counts.skuTotal) || rows.length),
    spuTotal: Number.isFinite(Number(result?.spuTotal)) ? Number(result.spuTotal) : (Number(counts.spuTotal) || 0),
    invalidSpuRows: Number.isFinite(Number(result?.invalidSpuRows)) ? Number(result.invalidSpuRows) : (Number(counts.invalidSpuRows) || 0)
  }
}

export function createWmsSyncService({
  sync = defaultSync,
  isConfigured = defaultIsConfigured,
  persistence = createTaskStoreWmsPersistence(taskStore),
  now = defaultNow,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
  retryDelayMs = WMS_RETRY_DELAY_MS,
  intervalMs = WMS_SYNC_INTERVAL_MS,
  maxRetries = WMS_MAX_RETRIES,
  onState = null
} = {}) {
  let current = sanitizeWmsSyncState(persistence.getState?.() || emptyWmsSyncState(), { now: now() })
  let inFlight = null
  let retryTimer = null
  let intervalTimer = null
  let controller = null
  let running = false
  let emitter = typeof onState === 'function' ? onState : null

  const publish = (patch = {}) => {
    current = sanitizeWmsSyncState({ ...current, ...patch }, { now: now() })
    persistence.setState?.(current)
    const dto = {
      ...current,
      counts: { ...current.counts },
      available: current.counts.spuTotal > 0,
      syncedAt: current.lastSuccessAt
    }
    try { emitter?.(dto) } catch { /* UI event delivery must not break sync */ }
    return dto
  }

  const clearRetry = () => {
    if (retryTimer != null) clearTimeoutFn(retryTimer)
    retryTimer = null
  }

  const scheduleRetry = () => {
    clearRetry()
    if (!running || current.retry > maxRetries) return
    const dueAt = now() + retryDelayMs
    publish({ nextRetryAt: new Date(dueAt).toISOString() })
    retryTimer = setTimeoutFn(() => {
      retryTimer = null
      if (running) void refresh({ reason: 'retry' })
    }, retryDelayMs)
    retryTimer?.unref?.()
  }

  const attempt = async ({ reason = 'manual', ...syncOptions } = {}) => {
    if (typeof isConfigured === 'function' && !(await isConfigured())) {
      clearRetry()
      return publish({ status: 'unconfigured', source: '', safeError: '', nextRetryAt: null })
    }
    controller = new AbortController()
    const attemptNumber = Math.max(0, Number(current.attempt) || 0) + 1
    publish({ status: 'syncing', lastAttemptAt: iso(now), attempt: attemptNumber, safeError: '', nextRetryAt: null })
    try {
      const result = await sync({ ...syncOptions, reason, signal: controller.signal })
      if (controller.signal.aborted) return getState()
      const lastSuccessAt = result?.syncedAt || iso(now)
      const counts = snapshotCounts(result, persistence)
      clearRetry()
      return publish({
        status: 'synced',
        source: result?.source || current.source,
        lastSuccessAt,
        stale: false,
        retry: 0,
        nextRetryAt: null,
        safeError: '',
        counts,
        snapshotHash: result?.snapshotHash || current.snapshotHash
      })
    } catch (error) {
      if (controller.signal.aborted) return getState()
      // Keep the stored counter capped for the UI, but calculate the next
      // ordinal separately so the third retry does not schedule a fourth one.
      const retryOrdinal = (Number(current.retry) || 0) + 1
      const retry = Math.min(maxRetries, retryOrdinal)
      const safeError = safeWmsPersistenceError(error, 'WMS 同步失败')
      const next = publish({ status: 'failed', retry, safeError, nextRetryAt: null })
      if (retryOrdinal <= maxRetries) scheduleRetry()
      return next
    } finally {
      controller = null
    }
  }

  function refresh(options = {}) {
    if (inFlight) return inFlight
    // A manual refresh is an explicit intent, not a second timer.  If it is
    // called after a failure, preserve the bounded retry count and let a
    // successful response reset it; this keeps audit metadata honest.
    inFlight = attempt(options).finally(() => { inFlight = null })
    return inFlight
  }

  function start() {
    if (running) return getState()
    running = true
    if (intervalTimer == null) {
      intervalTimer = setIntervalFn(() => { void refresh({ reason: 'interval' }) }, intervalMs)
      intervalTimer?.unref?.()
    }
    void refresh({ reason: 'startup' })
    return getState()
  }

  async function stop() {
    running = false
    clearRetry()
    if (intervalTimer != null) clearIntervalFn(intervalTimer)
    intervalTimer = null
    if (controller) controller.abort()
    if (inFlight) await inFlight
    publish({ nextRetryAt: null })
    return getState()
  }

  function getState() {
    current = sanitizeWmsSyncState(persistence.getState?.() || current, { now: now() })
    return {
      ...current,
      counts: { ...current.counts },
      available: current.counts.spuTotal > 0,
      syncedAt: current.lastSuccessAt,
      running
    }
  }

  return {
    start,
    stop,
    refresh,
    getState,
    setEmitter(next) { emitter = typeof next === 'function' ? next : null },
    isRunning: () => running,
    getInFlight: () => inFlight
  }
}

let singleton = null

export function getWmsSyncService() {
  if (!singleton) singleton = createWmsSyncService()
  return singleton
}

export function resetWmsSyncServiceForTests() {
  singleton = null
}
