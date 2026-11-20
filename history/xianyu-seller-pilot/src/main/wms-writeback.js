import { createHash } from 'node:crypto'

// Correction fields belong to the crawl/search workflow. They are never sent
// to the inventory API by the correction action itself.
export const CORRECTION_FIELDS = Object.freeze(['brand', 'model', 'keyword', 'search_terms', 'aliases'])

// Only these product-description fields may cross the API write boundary.
// 可写字段 = 服务端窄接口 SkuMarketInfoIn 的那三个（product_name/brand/model）。
// search_terms 曾经在这张表里，但服务端从来没有这个字段——送过去被静默丢掉，
// 窄接口 extra=forbid 之后更会直接 422。与其在客户端假装能写，不如这里就不收。
export const API_WRITEBACK_FIELDS = Object.freeze(['product_name', 'brand', 'model'])
export const FORBIDDEN_WRITEBACK_FIELDS = Object.freeze([
  'spu_code', 'spuCode', 'sku_code', 'skuCode', 'spec',
  'sale_price', 'selling_price', 'price', 'suggest_price', 'cost_price',
  'purchase_price', 'listing_price', 'listingPrice'
])

function text(value) {
  return String(value ?? '').trim()
}

function cleanList(value, limit = 12) {
  const values = Array.isArray(value) ? value : [value]
  return [...new Set(values.flatMap((item) => String(item ?? '').split(/[\n,，;；]/).map(text)).filter(Boolean))].slice(0, limit)
}

function cleanField(value) {
  return text(value).slice(0, 240)
}

function canonicalPatch(patch = {}, fields = CORRECTION_FIELDS) {
  const output = {}
  for (const field of fields) {
    if (patch?.[field] === undefined) continue
    if (field === 'aliases' || field === 'search_terms') output[field] = cleanList(patch[field])
    else output[field] = cleanField(patch[field])
  }
  return output
}

function rejectForbiddenPatch(patch = {}, { allowCorrectionAliases = false } = {}) {
  const forbidden = Object.keys(patch || {}).filter((field) => {
    if (allowCorrectionAliases && field === 'aliases') return false
    return FORBIDDEN_WRITEBACK_FIELDS.includes(field) || field === 'spec'
  })
  if (forbidden.length) throw new Error(`API 回写禁止字段：${forbidden.join(', ')}`)
}

/** Sanitize fields used to correct a failed crawl. This does not authorize API writeback. */
export function sanitizeWmsCorrectionPatch(patch = {}) {
  // Correction is a local search-side operation. Ignore legacy identity and
  // price keys instead of allowing them to become a writeback payload; the
  // API sanitizer below remains strict and throws on those keys.
  const filtered = Object.fromEntries(Object.entries(patch || {}).filter(([field]) => (
    !FORBIDDEN_WRITEBACK_FIELDS.includes(field) && field !== 'spec'
  )))
  return canonicalPatch(filtered)
}

export function correctionVersionFor(patch = {}) {
  const normalized = sanitizeWmsCorrectionPatch(patch)
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 24)
}

export function assertExplicitWmsCorrection({ taskId = '', skuCode = '', confirm = false, patch = {} } = {}) {
  if (!text(taskId)) throw new Error('WMS 修正缺少任务 ID')
  if (!text(skuCode)) throw new Error('WMS 修正缺少 SKU')
  if (confirm !== true) throw new Error('WMS 搜索信息修正必须人工确认')
  const sanitized = sanitizeWmsCorrectionPatch(patch)
  if (!Object.keys(sanitized).length) throw new Error('没有可保存的搜索修正字段')
  return sanitized
}

/** Fields accepted by the upstream product-description PATCH. */
export function sanitizeWmsApiWritebackPatch(patch = {}) {
  rejectForbiddenPatch(patch)
  const output = {}
  for (const field of API_WRITEBACK_FIELDS) {
    if (patch?.[field] === undefined) continue
    output[field] = field === 'search_terms' ? cleanList(patch[field]) : cleanField(patch[field])
  }
  if (!Object.keys(output).length) throw new Error('没有可回写的 API 商品信息')
  return output
}

export function buildWmsCorrectionAudit({
  task = {}, skuCode = '', before = {}, after = {}, operator = 'manual',
  reason = '', correctionVersion = '', queueIntent = 'review_pending', result = 'saved',
  source = 'manual', verified = false, recollectKey = null
} = {}) {
  const patch = canonicalPatch(after)
  const beforePatch = canonicalPatch(before)
  return {
    action: 'wms_correction',
    at: new Date().toISOString(),
    operator: text(operator).slice(0, 48) || 'manual',
    source: text(source) || 'manual',
    taskId: text(task.id),
    spuCode: text(task.spuCode || task.spu_code).toUpperCase(),
    skuCode: text(skuCode),
    correctionVersion: text(correctionVersion) || correctionVersionFor(patch),
    before: beforePatch,
    after: patch,
    reason: text(reason).slice(0, 240),
    queueIntent: text(queueIntent) || 'review_pending',
    result: text(result) || 'saved',
    // Legacy readers used these two names; retain them as derived aliases so
    // history remains readable without reviving the old direct-write flow.
    getVerified: verified === true,
    recollectKey: text(recollectKey) || null
  }
}

export function buildWmsWritebackAudit({
  task = {}, skuCode = '', patch = {}, before = {}, response = {}, verified = false,
  operator = 'manual', idempotencyKey = '', reason = '', result = verified ? 'verified' : 'failed',
  expectedVersion = null
} = {}) {
  // Audit must remain append-only even when the attempted patch is invalid.
  // The request path records the rejected shape as an empty safe payload; it
  // must not throw a second time while trying to record the first failure.
  let safePatch = {}
  try { safePatch = sanitizeWmsApiWritebackPatch(patch) } catch {}
  return {
    action: 'wms_api_writeback',
    at: new Date().toISOString(),
    operator: text(operator).slice(0, 48) || 'manual',
    taskId: text(task.id),
    spuCode: text(task.spuCode || task.spu_code).toUpperCase(),
    skuCode: text(skuCode),
    idempotencyKey: text(idempotencyKey),
    expectedVersion: expectedVersion == null ? null : text(expectedVersion),
    before: compactApiSnapshot(before),
    requested: safePatch,
    response: compactApiSnapshot(response),
    verified: verified === true,
    verifiedAt: verified === true ? new Date().toISOString() : null,
    result: text(result) || 'failed',
    reason: text(reason).slice(0, 240)
  }
}

/** Deterministic GET verification used by the main-process adapter and offline fixtures. */
export function assertVerifiedWmsWriteback({ task = {}, skuCode = '', patch = {}, before = {}, after = {}, afterHeaders = {}, expectedVersion = null } = {}) {
  const safePatch = sanitizeWmsApiWritebackPatch(patch)
  if (text(after?.sku_code) !== text(skuCode)) throw new Error('API 回写后 GET SKU 不一致')
  if (text(after?.status).toUpperCase() !== 'IN_STOCK') throw new Error('API 回写后 GET SKU 已不在库')
  if (text(after?.spu_code || after?.spuCode).toUpperCase() !== text(task.spuCode || task.spu_code).toUpperCase()) throw new Error('API 回写后 GET 返回的 SPU 与当前任务不一致')
  for (const [field, expected] of Object.entries(safePatch)) {
    const actual = field === 'search_terms' ? cleanList(after[field]) : text(after[field])
    const wanted = field === 'search_terms' ? cleanList(expected) : text(expected)
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`API 回写后 GET 校验失败：${field}`)
  }
  const beforeVersion = versionOf(before)
  const afterVersion = versionOf(after, afterHeaders)
  if (expectedVersion != null && beforeVersion != null && text(expectedVersion) !== text(beforeVersion)) throw new Error('API 回写前版本已变化，请重新复核')
  if (afterVersion == null || !text(afterVersion)) throw new Error('API 回写后 GET 缺少版本，未更新本地缓存')
  return { ok: true, item: after, beforeVersion, afterVersion }
}

function compactApiSnapshot(row = {}) {
  const output = {}
  for (const field of ['sku_code', 'spu_code', 'product_name', 'brand', 'model', 'search_terms', 'updated_at', 'version', 'etag', 'status']) {
    if (row?.[field] !== undefined) output[field] = field === 'search_terms' ? cleanList(row[field]) : cleanField(row[field])
  }
  return output
}

function versionOf(row = {}, headers = {}) {
  const inline = [row.updated_at, row.updatedAt, row.version, row.revision, row.etag, row.ETag].find(value => text(value))
  if (inline) return inline
  if (typeof headers?.get === 'function') return headers.get('etag') || headers.get('x-version') || null
  const values = Object.keys(headers || {})
    .filter((key) => ['etag', 'x-version'].includes(String(key).toLowerCase()))
    .map((key) => headers[key])
    .find(value => text(value))
  return values || null
}

export { API_WRITEBACK_FIELDS as ALLOWED_FIELDS, compactApiSnapshot }
