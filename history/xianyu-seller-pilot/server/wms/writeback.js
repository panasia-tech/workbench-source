"use strict"

let rulesPromise = null

function loadRules() {
  if (!rulesPromise) rulesPromise = import('../../src/main/wms-match.js').then(match => import('../../src/main/wms-writeback.js').then(writeback => ({ match, writeback })))
  return rulesPromise
}

function text(value) { return String(value ?? '').trim() }

function safeReason(error) {
  let message = text(error?.safeReason || error?.message || 'WMS 回写失败')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*[^\s,;)}]+/gi, '$1=[REDACTED]')
  try {
    const parsed = new URL(message)
    for (const key of [...parsed.searchParams.keys()]) if (/(key|token|secret|password|passwd|auth|session|cookie)/i.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    message = parsed.toString()
  } catch {}
  return message.slice(0, 240) || 'WMS 回写失败'
}

function headerValue(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return text(headers.get(name) || headers.get(name.toLowerCase()))
  const wanted = String(name).toLowerCase()
  const key = Object.keys(headers).find(item => String(item).toLowerCase() === wanted)
  return key ? text(headers[key]) : ''
}

function responseItem(response) {
  const data = response?.data ?? response?.item ?? response ?? {}
  return data?.item && typeof data.item === 'object' ? data.item : data
}

function versionOf(item, headers = {}) {
  const inline = [item?.updated_at, item?.updatedAt, item?.version, item?.revision, item?.etag, item?.ETag].find(value => text(value))
  return inline || headerValue(headers, 'etag') || headerValue(headers, 'x-version') || null
}

function appendAudit(existing, audit) {
  return [...(Array.isArray(existing) ? existing.slice(-19) : []), audit].slice(-20)
}

/**
 * Execute the same safe WMS identity contract as the desktop path, but keep
 * credentials and the HTTP client inside the server process.  This function
 * intentionally returns a blocked/failed DTO instead of throwing: the route
 * can persist the audit without leaking upstream credentials to H5.
 */
async function executeWmsIdentityWriteback({ client, task, skuCode, patch = {}, operator = 'server', now = () => new Date().toISOString() } = {}) {
  const { match, writeback } = await loadRules()
  const code = text(skuCode)
  let allowed
  let before = {}
  let after = {}
  let expectedVersion = null
  let idempotencyKey = ''
  let putIssued = false
  let operatorText = text(operator).slice(0, 48) || 'server'

  try {
    try {
      match.assertWritebackTaskReady(task || {}, code)
    } catch (error) {
      // All task-level preconditions are an intentional zero-write block,
      // not an upstream failure. Preserve the original message/code while
      // allowing the HTTP route to return 409 and persist the audit.
      throw Object.assign(error, { blocked: true, code: error?.code || 'wms_writeback_precondition_failed' })
    }
    try {
      allowed = writeback.sanitizeWmsApiWritebackPatch(patch)
    } catch (error) {
      throw Object.assign(error, { blocked: true, code: error?.code || 'wms_writeback_patch_invalid' })
    }
    if (!client || typeof client.adminLogin !== 'function' || typeof client.fetchInventorySku !== 'function' || typeof client.updateInventorySku !== 'function') {
      throw Object.assign(new Error('服务器 WMS 写回客户端不可用'), { code: 'wms_writeback_unavailable', blocked: true })
    }
    const admin = await client.adminLogin()
    if (!admin?.token) throw Object.assign(new Error('WMS 管理登录未返回有效令牌'), { code: 'wms_token_missing', blocked: true })
    const beforeResponse = await client.fetchInventorySku(code, { token: admin.token })
    before = responseItem(beforeResponse)
    if (text(before?.sku_code || before?.skuCode) !== code || text(before?.status).toUpperCase() !== 'IN_STOCK') {
      throw Object.assign(new Error('API 回写前 GET 未确认该 SKU 仍在库，已阻止 PATCH'), { code: 'wms_writeback_precondition_failed', blocked: true })
    }
    if (match.canonicalSpu(before?.spu_code || before?.spuCode || before?.barcode || before?.spu?.Barcode) !== match.canonicalSpu(task.spuCode || task.spu_code)) {
      throw Object.assign(new Error('API 回写前 GET 返回的 SPU 与当前任务不一致，已阻止 PATCH'), { code: 'wms_writeback_spu_mismatch', blocked: true })
    }
    expectedVersion = versionOf(before, beforeResponse?.headers)
    if (expectedVersion == null || !text(expectedVersion)) {
      throw Object.assign(new Error('API 未提供 updated_at/version/ETag，不能安全回写'), { code: 'wms_version_missing', blocked: true })
    }
    idempotencyKey = `${text(task.id)}:${text(task.correctionVersion) || writeback.correctionVersionFor(allowed)}:${code}`
    putIssued = true
    await client.updateInventorySku(code, allowed, {
      token: admin.token,
      expectedVersion,
      etag: headerValue(beforeResponse?.headers, 'etag') || text(before?.etag || before?.ETag)
    })
    const afterResponse = await client.fetchInventorySku(code, { token: admin.token })
    after = responseItem(afterResponse)
    writeback.assertVerifiedWmsWriteback({ task, skuCode: code, patch: allowed, before, after, afterHeaders: afterResponse?.headers, expectedVersion })
    const audit = writeback.buildWmsWritebackAudit({ task, skuCode: code, patch: allowed, before, response: after, operator: operatorText, idempotencyKey, expectedVersion, verified: true, result: 'verified' })
    return { ok: true, status: 'verified', putIssued: true, skuCode: code, item: after, patch: allowed, expectedVersion: text(expectedVersion), audit }
  } catch (error) {
    const reason = safeReason(error)
    let auditPatch = allowed || {}
    if (!Object.keys(auditPatch).length) {
      try { auditPatch = writeback.sanitizeWmsApiWritebackPatch(patch) } catch { auditPatch = {} }
    }
    const audit = writeback.buildWmsWritebackAudit({ task: task || {}, skuCode: code, patch: auditPatch, before, response: after, operator: operatorText, idempotencyKey, expectedVersion, verified: false, result: error?.blocked ? 'blocked' : 'failed', reason })
    return { ok: false, status: error?.blocked ? 'blocked' : 'failed', putIssued, skuCode: code, patch: auditPatch, expectedVersion: expectedVersion == null ? null : text(expectedVersion), reason, audit, errorCode: error?.code || 'wms_writeback_failed' }
  }
}

async function blockedWmsWritebackAudit({ task = {}, skuCode = '', patch = {}, operator = 'server', reason = '', errorCode = 'wms_writeback_blocked' } = {}) {
  const { writeback } = await loadRules()
  let safePatch = {}
  try { safePatch = writeback.sanitizeWmsApiWritebackPatch(patch) } catch {}
  return {
    ...writeback.buildWmsWritebackAudit({
      task,
      skuCode: text(skuCode),
      patch: safePatch,
      operator,
      verified: false,
      result: 'blocked',
      reason: safeReason({ message: reason })
    }),
    errorCode: text(errorCode).slice(0, 80) || 'wms_writeback_blocked'
  }
}

function normalizeVerifiedInventory(item, fallback = {}) {
  return {
    ...fallback,
    ...(item && typeof item === 'object' ? item : {}),
    sku_code: text(item?.sku_code || item?.skuCode || fallback.sku_code || fallback.skuCode),
    spu_code: text(item?.spu_code || item?.spuCode || item?.barcode || fallback.spu_code || fallback.spuCode),
    status: text(item?.status || fallback.status).toUpperCase()
  }
}

module.exports = { appendAudit, blockedWmsWritebackAudit, executeWmsIdentityWriteback, headerValue, normalizeVerifiedInventory, responseItem, versionOf }
