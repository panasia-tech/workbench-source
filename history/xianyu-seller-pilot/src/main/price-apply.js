import crypto from 'node:crypto'

import { PRICE_POLICY_VERSION } from './price-candidate.js'

/**
 * The listing price write path is intentionally separate from the inventory
 * snapshot.  `suggest_price` is a cost-derived fact; it is never used as the
 * current listing price and never becomes a write target by accident.
 */
export const LISTING_UPDATE_FIELDS = Object.freeze([
  'title',
  'desc',
  'price',
  'original_price',
  'express_fee',
  'images',
  'item_biz_type',
  'sp_biz_type',
  'channel_cat_id',
  'stuff_status'
])

const DEFAULT_POLICY = Object.freeze({
  policyVersion: PRICE_POLICY_VERSION,
  freshnessHours: 24,
  minimumSampleCount: 3,
  maxSpreadRatio: 0.25
})

export class PriceApplyError extends Error {
  constructor(reason, message = reason, details = {}) {
    super(message)
    this.name = 'PriceApplyError'
    this.reason = reason
    this.details = details
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function finitePositive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function timestamp(value) {
  if (typeof value === 'number') {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value
    return Number.isFinite(milliseconds) ? milliseconds : null
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isoNow(value = Date.now()) {
  const parsed = timestamp(value)
  return new Date(parsed === null ? Date.now() : parsed).toISOString()
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex')
}

function headerValue(headers = {}, name) {
  if (!headers || typeof headers !== 'object') return null
  const expected = String(name).toLowerCase()
  const key = Object.keys(headers).find((candidate) => String(candidate).toLowerCase() === expected)
  return key ? headers[key] : null
}

/** Return the current price from the listing DTO only, never from suggest_price. */
export function currentListingPrice(listing = {}) {
  return finitePositive(listing?.price)
}

/**
 * Extract the concurrency contract offered by the upstream GET.  A plain
 * updated_at is usable as an If-Unmodified-Since guard; ETag/version are
 * preferred and are sent as If-Match/X-Expected-Version.
 */
export function listingConcurrencyContract(listing = {}, headers = {}) {
  const etag = text(listing?.etag || headerValue(headers, 'etag'))
  if (etag) return { value: etag, kind: 'etag', header: 'If-Match' }
  const version = listing?.version ?? listing?.revision ?? headerValue(headers, 'x-version')
  if (version !== null && version !== undefined && text(version)) {
    return { value: String(version), kind: 'version', header: 'X-Expected-Version' }
  }
  const updatedAt = listing?.updated_at ?? listing?.updatedAt
  if (updatedAt !== null && updatedAt !== undefined && text(updatedAt)) {
    return { value: String(updatedAt), kind: 'updated_at', header: 'If-Unmodified-Since' }
  }
  const headerUpdatedAt = headerValue(headers, 'last-modified')
  if (headerUpdatedAt) return { value: String(headerUpdatedAt), kind: 'last-modified', header: 'If-Unmodified-Since' }
  return null
}

export function conditionalHeaders(contract, idempotencyKey) {
  if (!contract?.header || !text(contract.value)) return null
  const key = text(idempotencyKey)
  if (!key) return null
  return {
    [contract.header]: contract.value,
    'Idempotency-Key': key
  }
}

/**
 * Merge the selected price into the complete GET DTO first.  This preserves
 * unknown fields in the in-memory evidence object; the request body is then
 * projected to the server's complete ListingInfoUpdate schema.
 */
export function mergeListingDto(currentListing = {}, selectedPrice) {
  if (!isRecord(currentListing)) throw new PriceApplyError('blocked_invalid_listing', '当前上架信息不是对象')
  const price = finitePositive(selectedPrice)
  if (price === null) throw new PriceApplyError('blocked_invalid_selection', '选中的价格无效')
  return { ...currentListing, price }
}

function optionalValue(value) {
  return value === undefined ? null : value
}

/** Build and validate the full write DTO required by PUT /listing/skus/{sku}. */
export function buildListingUpdateBody(mergedListing = {}) {
  if (!isRecord(mergedListing)) throw new PriceApplyError('blocked_invalid_listing', '当前上架信息不是对象')
  const title = mergedListing.title
  if (typeof title !== 'string' || !title.trim()) {
    throw new PriceApplyError('blocked_incomplete_listing', '当前上架信息缺少可回写的标题')
  }
  const price = finitePositive(mergedListing.price)
  if (price === null) throw new PriceApplyError('blocked_missing_price', '当前或目标销售价无效')
  if (!Array.isArray(mergedListing.images)) {
    throw new PriceApplyError('blocked_incomplete_listing', '当前上架信息缺少图片列表')
  }
  const body = {
    title: title.trim().slice(0, 240),
    desc: optionalValue(mergedListing.desc),
    price,
    original_price: optionalValue(mergedListing.original_price),
    express_fee: optionalValue(mergedListing.express_fee),
    images: mergedListing.images.slice(0, 9),
    item_biz_type: optionalValue(mergedListing.item_biz_type),
    sp_biz_type: optionalValue(mergedListing.sp_biz_type),
    channel_cat_id: optionalValue(mergedListing.channel_cat_id),
    stuff_status: optionalValue(mergedListing.stuff_status)
  }
  for (const field of ['desc', 'channel_cat_id']) {
    if (body[field] !== null && body[field] !== undefined && typeof body[field] !== 'string') {
      throw new PriceApplyError('blocked_invalid_listing', `上架字段 ${field} 格式无效`)
    }
  }
  return body
}

function responseItem(response) {
  return response?.item || response?.data || response || {}
}

function responseHeaders(response) {
  return response?.headers || {}
}

function readRole(auth = {}) {
  return text(auth.role || auth.staff?.role || auth.user?.role).toUpperCase()
}

function assertAdminRest(auth = {}) {
  if (text(auth.source).toLowerCase() !== 'rest' || !text(auth.token) || readRole(auth) !== 'ADMIN') {
    throw new PriceApplyError('blocked_admin_required', '价格回写只允许 REST ADMIN 账号')
  }
}

function assertSelectedPreview(preview, nowMs) {
  if (!isRecord(preview)) throw new PriceApplyError('blocked_invalid_preview', '价格预览无效')
  if (preview.policyVersion !== PRICE_POLICY_VERSION || preview.policy?.policyVersion === 'unsupported') {
    throw new PriceApplyError('blocked_invalid_preview', '价格预览策略版本无效')
  }
  if (preview.status !== 'selected' || preview.selection?.confirmedAt == null || preview.selection?.confirmedAt === '') {
    throw new PriceApplyError('blocked_unconfirmed', '价格回写需要操作员显式确认')
  }
  const evaluatedAt = timestamp(preview.evaluatedAt)
  const policy = { ...DEFAULT_POLICY, ...(isRecord(preview.policy) ? preview.policy : {}) }
  if (evaluatedAt === null || nowMs - evaluatedAt > Number(policy.freshnessHours) * 3_600_000 || nowMs < evaluatedAt) {
    throw new PriceApplyError('blocked_stale_preview', '价格预览已超过 24 小时或时间无效')
  }
  const samples = Number(preview.market?.sampleCount)
  if (!Number.isInteger(samples) || samples < Number(policy.minimumSampleCount)) {
    throw new PriceApplyError('blocked_insufficient_samples', '价格预览有效样本不足')
  }
  const spread = preview.market?.spreadRatio
  if (spread !== null && spread !== undefined && (!Number.isFinite(Number(spread)) || Number(spread) > Number(policy.maxSpreadRatio))) {
    throw new PriceApplyError('blocked_spread_exceeds_max', '价格预览行情离散度过大')
  }
  const floor = finitePositive(preview.costFloor)
  const selectedPrice = finitePositive(preview.selectedPrice)
  if (floor === null || selectedPrice === null || selectedPrice < floor) {
    throw new PriceApplyError('blocked_below_cost_floor', '回写价格不得低于成本底价')
  }
  const idempotencyKey = text(preview.selectionIdempotencyKey)
  if (!idempotencyKey) throw new PriceApplyError('blocked_missing_idempotency', '价格回写缺少幂等键')
  return { policy, selectedPrice, floor, idempotencyKey }
}

function samePrice(left, right) {
  return finitePositive(left) !== null && Math.abs(Number(left) - Number(right)) < 0.000001
}

function auditBase({ preview, skuCode, reason, status, putIssued = false, before = null, after = null, contract = null, nowMs }) {
  return {
    schemaVersion: 1,
    action: 'price_apply',
    status,
    reason: text(reason).slice(0, 240),
    putIssued: Boolean(putIssued),
    skuCode: text(skuCode).slice(0, 160),
    spuCode: text(preview?.spuCode).slice(0, 160),
    previewId: text(preview?.previewId).slice(0, 160),
    policyVersion: text(preview?.policyVersion),
    idempotencyKey: text(preview?.selectionIdempotencyKey).slice(0, 240),
    selectedPrice: finitePositive(preview?.selectedPrice),
    beforePrice: before ? currentListingPrice(before) : null,
    afterPrice: after ? currentListingPrice(after) : null,
    concurrencyKind: contract?.kind || null,
    concurrencyValue: contract?.value || null,
    operatorId: text(preview?.selection?.operatorId).slice(0, 80) || null,
    at: isoNow(nowMs)
  }
}

/**
 * Execute the fail-closed GET -> merge/validate -> conditional PUT -> exact
 * GET flow.  Dependencies are injected so the zero-call contract can be
 * tested without network access or credentials.
 */
export async function applyPriceSelection({
  preview,
  skuCode,
  auth,
  fetchCurrentListing,
  putListing,
  hasAppliedIdempotency = async () => false,
  recordAudit = async () => {},
  updateCache = async () => {},
  now = Date.now()
} = {}) {
  const nowMs = timestamp(now) ?? Date.now()
  let putIssued = false
  let before = null
  let after = null
  let contract = null
  const code = text(skuCode)
  try {
    if (!code) throw new PriceApplyError('blocked_missing_sku', '价格回写缺少 SKU')
    assertAdminRest(auth)
    const validated = assertSelectedPreview(preview, nowMs)
    if (text(preview.skuCode) !== code) throw new PriceApplyError('blocked_sku_mismatch', '价格预览 SKU 与回写 SKU 不一致')
    if (typeof fetchCurrentListing !== 'function' || typeof putListing !== 'function') {
      throw new PriceApplyError('blocked_no_listing_transport', '价格回写缺少 REST listing 传输适配')
    }
    if (await hasAppliedIdempotency(validated.idempotencyKey)) {
      throw new PriceApplyError('blocked_duplicate_idempotency', '该价格回写幂等键已经处理过')
    }
    const beforeResponse = await fetchCurrentListing(code)
    before = responseItem(beforeResponse)
    const beforeHeaders = responseHeaders(beforeResponse)
    if (text(before?.sku_code || before?.skuCode) !== code) throw new PriceApplyError('blocked_sku_mismatch', '当前 listing GET 返回 SKU 不一致')
    if (text(preview.spuCode) && text(before?.spu_code || before?.spuCode) !== text(preview.spuCode)) {
      throw new PriceApplyError('blocked_spu_mismatch', '当前 listing GET 返回 SPU 不一致')
    }
    if (currentListingPrice(before) === null) throw new PriceApplyError('blocked_missing_price', '当前 listing 缺少真实销售价')
    contract = listingConcurrencyContract(before, beforeHeaders)
    if (!contract) throw new PriceApplyError('blocked_no_version_contract', '当前 listing 未提供版本或 ETag 并发门禁')
    const merged = mergeListingDto(before, validated.selectedPrice)
    const body = buildListingUpdateBody(merged)
    const headers = conditionalHeaders(contract, validated.idempotencyKey)
    if (!headers) throw new PriceApplyError('blocked_no_version_contract', '无法生成条件写入请求头')
    putIssued = true
    await putListing(code, body, { headers, contract, idempotencyKey: validated.idempotencyKey })
    const afterResponse = await fetchCurrentListing(code)
    after = responseItem(afterResponse)
    if (text(after?.sku_code || after?.skuCode) !== code) throw new PriceApplyError('failed_get_mismatch', '价格 PUT 后 GET 返回 SKU 不一致')
    if (text(preview.spuCode) && text(after?.spu_code || after?.spuCode) !== text(preview.spuCode)) throw new PriceApplyError('failed_get_mismatch', '价格 PUT 后 GET 返回 SPU 不一致')
    if (!samePrice(after?.price, validated.selectedPrice)) throw new PriceApplyError('failed_get_mismatch', '价格 PUT 后 GET 未返回选中的销售价')
    const audit = auditBase({ preview, skuCode: code, reason: 'conditional PUT + exact GET verified', status: 'success', putIssued, before, after, contract, nowMs })
    await recordAudit(audit)
    await updateCache(after, { contract, body, before, idempotencyKey: validated.idempotencyKey })
    return { ok: true, status: 'applied', putIssued: true, skuCode: code, before, after, body, audit }
  } catch (error) {
    const reason = error?.reason || (putIssued ? 'failed_price_apply' : 'blocked_price_apply')
    const status = putIssued ? 'failed' : 'blocked'
    const audit = auditBase({ preview, skuCode: code, reason, status, putIssued, before, after, contract, nowMs })
    await recordAudit(audit)
    return { ok: false, status, putIssued, reason, skuCode: code, audit }
  }
}

export function redactListingForEvidence(listing = {}) {
  if (!isRecord(listing)) return null
  const copy = { ...listing }
  for (const key of Object.keys(copy)) {
    if (/token|cookie|password|secret|authorization|api[_-]?key/i.test(key)) delete copy[key]
  }
  return copy
}

