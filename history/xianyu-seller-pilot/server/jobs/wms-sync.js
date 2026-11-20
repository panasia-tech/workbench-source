"use strict"

const { createWmsClient, safeError } = require('../wms/client.js')

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

function text(value) { return String(value ?? '').trim() }

function safeReason(error, fallback = 'WMS 同步失败') {
  return text(error?.safeReason || error?.message || fallback)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*[^\s,;)}]+/gi, '$1=[REDACTED]')
    .slice(0, 240) || fallback
}

function configurationStatus(config = {}) {
  const wms = config.wms || {}
  const rest = Boolean(wms.restUsername && wms.restPassword)
  const mcp = Boolean(wms.mcpUrl && wms.mcpKey)
  const source = ['auto', 'rest', 'mcp'].includes(wms.source) ? wms.source : 'auto'
  return { source, rest, mcp, configured: source === 'rest' ? rest : source === 'mcp' ? mcp : rest || mcp }
}

async function loadRules() {
  return import('../../src/main/wms-match.js')
}

function createServerWmsSyncService({ db, config, now = () => new Date().toISOString(), intervalMs = DEFAULT_INTERVAL_MS, client = null } = {}) {
  if (!db) throw new Error('WMS sync database is required')
  let running = false
  let timer = null
  let inFlight = null
  let current = db.getWmsSyncState()
  const resolvedClient = client || createWmsClient(config?.wms || {})

  function publish(patch = {}) {
    current = db.setWmsSyncState(patch)
    return current
  }

  async function attempt({ reason = 'manual' } = {}) {
    const status = configurationStatus(config)
    if (!status.configured) return publish({ status: 'unconfigured', source: '', safeError: '', lastAttemptAt: null })
    const startedAt = now()
    publish({ status: 'syncing', source: status.source, lastAttemptAt: startedAt, safeError: '' })
    try {
      let snapshot = null
      let usedSource = ''
      let restError = null

      // REST is preferred in auto mode.  A REST outage may fall back to MCP,
      // but an explicitly selected REST source must fail closed rather than
      // silently switching to a different credential or data contract.
      if (status.source !== 'mcp' && status.rest) {
        try {
          const token = (await resolvedClient.adminLogin()).token
          snapshot = await resolvedClient.fetchAllInventory({ token })
          usedSource = 'rest'
        } catch (error) {
          restError = error
          if (status.source === 'rest') throw error
        }
      }
      if (!snapshot && status.mcp) {
        if (typeof resolvedClient.fetchMcpInventory !== 'function') {
          throw Object.assign(new Error('服务器 WMS MCP 客户端不可用'), { code: 'wms_mcp_client_missing' })
        }
        snapshot = await resolvedClient.fetchMcpInventory()
        usedSource = restError ? 'mcp-fallback' : 'mcp'
      }
      if (!snapshot) throw restError || Object.assign(new Error('服务器 WMS 没有可用的同步通道'), { code: 'wms_transport_unavailable' })
      const rules = await loadRules()
      const normalized = snapshot.items.map(rules.enrichSkuBrand ? rules.enrichSkuBrand : (row) => row)
      const valid = rules.normalizeInStockSkus(normalized)
      const catalog = rules.buildSpuCatalog(valid)
      const syncedAt = now()
      publish({ status: 'synced', source: usedSource, skuTotal: valid.length, spuTotal: catalog.items.length, invalidSpuRows: catalog.invalidRows.length, lastAttemptAt: startedAt, lastSuccessAt: syncedAt, safeError: '' })
      db.replaceWmsInventory(valid, { source: usedSource, spuTotal: catalog.items.length, invalidSpuRows: catalog.invalidRows.length, syncedAt })
      db.audit({ actorId: null, action: 'wms.sync.success', entityType: 'wms_inventory', entityId: null, metadata: { reason, source: usedSource, skuTotal: valid.length, spuTotal: catalog.items.length } })
      current = db.getWmsSyncState()
      return current
    } catch (error) {
      const safe = safeReason(error)
      current = publish({ status: 'failed', source: status.source, lastAttemptAt: startedAt, safeError: safe })
      db.audit({ actorId: null, action: 'wms.sync.failed', entityType: 'wms_inventory', entityId: null, metadata: { reason, source: status.source, error: safe } })
      throw safeError(error, safe)
    }
  }

  function refresh(options = {}) {
    if (inFlight) return inFlight
    inFlight = attempt(options).finally(() => { inFlight = null })
    return inFlight
  }

  function start() {
    if (running) return current
    running = true
    timer = setInterval(() => { void refresh({ reason: 'interval' }).catch(() => {}) }, Math.max(30_000, Number(intervalMs) || DEFAULT_INTERVAL_MS))
    timer?.unref?.()
    if (configurationStatus(config).configured) void refresh({ reason: 'startup' }).catch(() => {})
    return current
  }

  async function stop() {
    running = false
    if (timer) clearInterval(timer)
    timer = null
    if (inFlight) await inFlight.catch(() => {})
    return current
  }

  return {
    start,
    stop,
    refresh,
    getState: () => db.getWmsSyncState(),
    // Expose the already-configured server-only client to authenticated
    // writeback routes; credentials never leave this process.
    getClient: () => resolvedClient,
    isRunning: () => running,
    isConfigured: () => configurationStatus(config),
    getInFlight: () => inFlight
  }
}

module.exports = { DEFAULT_INTERVAL_MS, configurationStatus, createServerWmsSyncService, safeReason }
