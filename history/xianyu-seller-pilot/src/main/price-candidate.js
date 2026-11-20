import crypto from 'node:crypto'

import { parseMoney } from './price-fence.js'

/**
 * The price policy is deliberately a small, deterministic domain service.
 *
 * API prices are facts used for comparison only.  They are never folded into
 * market observations and this module never writes a listing price.  A
 * caller must use `selectPriceCandidate` with an explicit confirmation before
 * a preview can carry `selectedPrice`.
 */
export const PRICE_POLICY_VERSION = 'price-policy-v1'
export const PRICE_POLICY_DEFAULTS = Object.freeze({
  policyVersion: PRICE_POLICY_VERSION,
  freshnessHours: 24,
  minimumSampleCount: 3,
  costFloorRatio: 1,
  maxSpreadRatio: 0.25,
  roundingIncrement: 10,
  roundingMode: 'NEAREST',
  spreadFormula: 'RANGE_OVER_MEDIAN',
  multiSkuAggregation: 'PER_SKU',
  recommendationFormula: 'MAX_MEDIAN_OR_COST_FLOOR_THEN_ROUND',
  operatorSelection: 'CANDIDATE_OR_RECOMMENDATION_OR_CUSTOM_ABOVE_FLOOR',
  ambiguousOrMissingBehavior: 'REVIEW_ONLY',
  selectionRequiresExplicitConfirm: true,
})

const API_ONLY_SOURCES = new Set([
  'api_current_sale_price',
  'api_current_price',
  'api_suggest_price',
  'api_suggestion_price',
  'api_price',
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function positivePrice(value, label) {
  const parsed = parseMoney(value, { label })
  return parsed.ok && parsed.present ? parsed.value : null
}

function optionalPriceFact(value, label) {
  const parsed = parseMoney(value, { label })
  return {
    value: parsed.ok && parsed.present ? parsed.value : null,
    present: parsed.present,
    valid: parsed.ok,
    reason: parsed.reason,
  }
}

function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value
    return Number.isFinite(milliseconds) ? milliseconds : null
  }
  if (typeof value === 'string' && value.trim()) {
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) ? milliseconds : null
  }
  return null
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString()
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = stableValue(value[key])
    return result
  }, {})
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex')
}

function unique(values) {
  return [...new Set(values)]
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export const calculateMedian = median

export function calculateSpreadRatio(values, medianValue = median(values)) {
  if (!Array.isArray(values) || values.length === 0 || !Number.isFinite(medianValue) || medianValue <= 0) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  return Math.round((((max - min) / medianValue) + Number.EPSILON) * 10000) / 10000
}

function roundNearest(value, increment) {
  const rounded = Math.round((value / increment) + Number.EPSILON) * increment
  return Math.round((rounded + Number.EPSILON) * 100) / 100
}

export function roundPrice(value, increment = PRICE_POLICY_DEFAULTS.roundingIncrement, floor = 0) {
  if (!Number.isFinite(value) || !Number.isFinite(increment) || increment <= 0) return null
  const rounded = roundNearest(value, increment)
  // Nearest rounding must not turn a valid cost floor into a below-floor
  // candidate (for example cost=103 and nearest-10=100).  The adjustment is
  // still the NEAREST policy with a hard safety floor.
  return rounded >= floor ? rounded : Math.ceil(floor / increment) * increment
}

function normalizePolicy(overrides = {}) {
  const source = isRecord(overrides) ? overrides : {}
  const policy = { ...PRICE_POLICY_DEFAULTS, ...source }
  const numeric = [
    'freshnessHours',
    'minimumSampleCount',
    'costFloorRatio',
    'maxSpreadRatio',
    'roundingIncrement',
  ]
  for (const key of numeric) {
    if (!Number.isFinite(Number(policy[key])) || Number(policy[key]) <= 0) policy[key] = PRICE_POLICY_DEFAULTS[key]
    else policy[key] = Number(policy[key])
  }
  policy.policyVersion = text(policy.policyVersion) || PRICE_POLICY_VERSION
  return Object.freeze(policy)
}

function observationInputPrice(observation) {
  return observation?.price ?? observation?.marketPrice ?? observation?.listingPrice ?? observation?.observedPrice
}

function observationInputTime(observation) {
  return observation?.observedAt ?? observation?.capturedAt ?? observation?.timestamp ?? observation?.time
}

function normalizeObservation(input, { nowMs, skuCode, freshnessHours }) {
  const observation = isRecord(input) ? input : {}
  const source = text(observation.source ?? observation.sourceType ?? observation.channel).toLowerCase()
  const observationId = text(observation.observationId ?? observation.sampleId ?? observation.id)
  const observedMs = timestamp(observationInputTime(observation))
  const price = positivePrice(observationInputPrice(observation), '行情观察价')
  const observationSkuCode = text(observation.skuCode ?? observation.sku_code)
  const base = {
    observationId: observationId || null,
    skuCode: observationSkuCode || null,
    source: source || null,
    price,
    observedAt: observedMs === null ? null : iso(observedMs),
    ageHours: observedMs === null ? null : Math.round(((nowMs - observedMs) / 3_600_000) * 100) / 100,
    accepted: false,
    reasonCode: null,
  }

  if (!observationId) return { ...base, reasonCode: 'MISSING_OBSERVATION_ID' }
  if (!source) return { ...base, reasonCode: 'MISSING_SOURCE' }
  if (API_ONLY_SOURCES.has(source)) return { ...base, reasonCode: 'API_PRICE_NOT_MARKET_OBSERVATION' }
  if (observationSkuCode && observationSkuCode !== skuCode) return { ...base, reasonCode: 'SKU_MISMATCH' }
  if (!Number.isFinite(price) || price <= 0) return { ...base, reasonCode: 'INVALID_OBSERVATION_PRICE' }
  if (observedMs === null) return { ...base, reasonCode: 'INVALID_OBSERVED_AT' }
  if (observedMs > nowMs) return { ...base, reasonCode: 'FUTURE_OBSERVATION' }
  if (nowMs - observedMs > freshnessHours * 3_600_000) return { ...base, reasonCode: 'STALE_OBSERVATION' }

  return { ...base, accepted: true, reasonCode: null }
}

function reasonDetails(observations, facts, market, policy) {
  const details = []
  const add = (code, message) => details.push({ code, message })
  const rejectedCodes = observations.filter((item) => !item.accepted).map((item) => item.reasonCode).filter(Boolean)
  for (const code of unique(rejectedCodes)) {
    const messages = {
      MISSING_OBSERVATION_ID: '行情样本缺少稳定样本 ID',
      MISSING_SOURCE: '行情样本缺少来源',
      API_PRICE_NOT_MARKET_OBSERVATION: 'API 当前价/建议价只能作为事实，不能作为行情样本',
      SKU_MISMATCH: '行情样本与当前 SKU 不一致',
      INVALID_OBSERVATION_PRICE: '行情样本价格无效',
      INVALID_OBSERVED_AT: '行情样本时间无效',
      FUTURE_OBSERVATION: '行情样本时间晚于本次预览时间',
      STALE_OBSERVATION: '行情样本超过 24 小时新鲜窗口',
      DUPLICATE_OBSERVATION_ID: '行情样本 ID 重复，无法形成可审计样本快照',
    }
    add(code, messages[code] || '行情样本未通过校验')
  }
  if (market.sampleCount < policy.minimumSampleCount) add('INSUFFICIENT_FRESH_SAMPLES', `有效新鲜行情样本不足 ${policy.minimumSampleCount} 个（当前 ${market.sampleCount} 个）`)
  if (!facts.cost.valid || !facts.cost.present) add(facts.cost.present ? 'INVALID_COST_PRICE' : 'MISSING_COST_PRICE', '缺少有效采购成本价，不能计算成本底价')
  if (market.spreadRatio !== null && market.spreadRatio > policy.maxSpreadRatio) add('SPREAD_EXCEEDS_MAX', `行情样本离散度 ${(market.spreadRatio * 100).toFixed(2)}% 超过 ${(policy.maxSpreadRatio * 100).toFixed(2)}%`)
  return details
}

function freezeDeep(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value
  for (const child of Object.values(value)) freezeDeep(child)
  return Object.freeze(value)
}

function resolveNow(now) {
  const resolved = timestamp(now)
  return resolved === null ? Date.now() : resolved
}

function normalizeSkuInput(input) {
  const source = isRecord(input) ? input : {}
  return {
    spuCode: text(source.spuCode ?? source.spu_code),
    skuCode: text(source.skuCode ?? source.sku_code ?? source.skuId ?? source.id),
    costPrice: source.costPrice ?? source.cost_price ?? source.purchasePrice ?? source.referencePrice,
    apiCurrentSalePrice: source.apiCurrentSalePrice ?? source.api_current_sale_price ?? source.currentSalePrice ?? source.current_price,
    apiSuggestPrice: source.apiSuggestPrice ?? source.api_suggest_price ?? source.suggestPrice ?? source.suggest_price,
    marketObservations: source.marketObservations ?? source.market_observations ?? source.observations ?? [],
  }
}

/**
 * Build one immutable, reviewable price preview.  `selectedPrice` is absent
 * by design; only `selectPriceCandidate` may add it after explicit confirm.
 */
export function createPriceCandidatePreview(input = {}, options = {}) {
  const source = normalizeSkuInput(input)
  const option = isRecord(options) ? options : {}
  const policy = normalizePolicy(option.policy ?? input?.policy ?? {})
  const nowMs = resolveNow(option.now ?? input?.now ?? Date.now())
  const skuCode = source.skuCode
  const spuCode = source.spuCode
  const observationsInput = Array.isArray(source.marketObservations) ? source.marketObservations : []
  const observations = observationsInput.map((item) => normalizeObservation(item, {
    nowMs,
    skuCode,
    freshnessHours: policy.freshnessHours,
  }))
  const seenIds = new Set()
  for (const observation of observations) {
    if (observation.accepted && seenIds.has(observation.observationId)) {
      observation.accepted = false
      observation.reasonCode = 'DUPLICATE_OBSERVATION_ID'
    }
    if (observation.observationId) seenIds.add(observation.observationId)
  }

  const accepted = observations.filter((item) => item.accepted)
  const values = accepted.map((item) => item.price)
  const medianPrice = median(values)
  const spreadRatio = calculateSpreadRatio(values, medianPrice)
  const minPrice = values.length ? Math.min(...values) : null
  const maxPrice = values.length ? Math.max(...values) : null
  const facts = {
    cost: optionalPriceFact(source.costPrice, '采购成本价'),
    apiCurrentSale: optionalPriceFact(source.apiCurrentSalePrice, 'API 当前销售价'),
    apiSuggest: optionalPriceFact(source.apiSuggestPrice, 'API 建议价'),
  }
  const market = {
    sampleCount: accepted.length,
    median: medianPrice,
    min: minPrice,
    max: maxPrice,
    spreadRatio,
    spreadFormula: policy.spreadFormula,
    observations: accepted.map(({ observationId, skuCode: observedSkuCode, source: observationSource, price, observedAt, ageHours }) => ({
      observationId,
      skuCode: observedSkuCode || skuCode || null,
      source: observationSource,
      price,
      observedAt,
      ageHours,
    })),
  }
  const details = reasonDetails(observations, facts, market, policy)
  const reviewOnly = details.length > 0 || !skuCode || !spuCode
  if (!skuCode) details.push({ code: 'MISSING_SKU_CODE', message: '缺少 SKU 唯一值' })
  if (!spuCode) details.push({ code: 'MISSING_SPU_CODE', message: '缺少 SPU 唯一值' })

  const floor = facts.cost.valid && facts.cost.present ? facts.cost.value * policy.costFloorRatio : null
  const rawRecommendation = medianPrice === null || floor === null ? null : Math.max(medianPrice, floor)
  const roundedRecommendation = rawRecommendation === null ? null : roundPrice(rawRecommendation, policy.roundingIncrement, floor)
  const marketMedianCandidate = medianPrice === null || floor === null
    ? null
    : roundPrice(medianPrice, policy.roundingIncrement, floor)
  const candidates = []
  if (!reviewOnly && marketMedianCandidate !== null) {
    candidates.push({ key: 'market_median', label: '行情中位数（取整）', price: marketMedianCandidate, source: 'MARKET_OBSERVATION' })
  }
  if (!reviewOnly && roundedRecommendation !== null) {
    candidates.push({ key: 'recommendation', label: '策略建议价', price: roundedRecommendation, source: 'MEDIAN_VALID_MARKET_WITH_COST_FLOOR' })
  }

  const sampleSnapshot = accepted.map(({ observationId, source: observationSource, price, observedAt }) => ({ observationId, source: observationSource, price, observedAt }))
  // Identity includes rejected observations as well.  Replacing a stale or
  // ambiguous sample must create a new append-only preview instead of
  // accidentally reusing an older decision with the same accepted subset.
  const observationSnapshot = observations.map(({ observationId, skuCode: observedSkuCode, source: observationSource, price, observedAt, accepted: isAccepted, reasonCode }) => ({
    observationId,
    skuCode: observedSkuCode || skuCode || null,
    source: observationSource,
    price,
    observedAt,
    accepted: isAccepted,
    reasonCode,
  }))
  const inputSnapshot = {
    spuCode,
    skuCode,
    costPrice: facts.cost.value,
    apiCurrentSalePrice: facts.apiCurrentSale.value,
    apiSuggestPrice: facts.apiSuggest.value,
    sampleSnapshot,
    observationSnapshot,
  }
  const inputSnapshotHash = sha256(inputSnapshot)
  const previewIdentity = `${spuCode}:${skuCode}:${sha256(observationSnapshot)}:${policy.policyVersion}`
  const previewId = sha256(previewIdentity)
  const dto = {
    previewType: 'PRICE_CANDIDATE_PREVIEW',
    previewId,
    appendOnlyIdentity: previewIdentity,
    inputSnapshotHash,
    policyVersion: policy.policyVersion,
    policy: {
      freshnessHours: policy.freshnessHours,
      minimumSampleCount: policy.minimumSampleCount,
      costFloorRatio: policy.costFloorRatio,
      maxSpreadRatio: policy.maxSpreadRatio,
      roundingIncrement: policy.roundingIncrement,
      roundingMode: policy.roundingMode,
      spreadFormula: policy.spreadFormula,
      multiSkuAggregation: policy.multiSkuAggregation,
      recommendationFormula: policy.recommendationFormula,
      operatorSelection: policy.operatorSelection,
      selectionRequiresExplicitConfirm: policy.selectionRequiresExplicitConfirm,
    },
    spuCode,
    skuCode,
    evaluatedAt: iso(nowMs),
    status: reviewOnly ? 'review_only' : 'ready',
    reviewOnly,
    reasonCodes: unique(details.map((item) => item.code)),
    reviewReasons: details,
    // These are explicitly separate facts.  Neither API price is copied into
    // `market.observations` or used in the median/spread calculation.
    facts: {
      costPrice: facts.cost.value,
      costPricePresent: facts.cost.present,
      costPriceValid: facts.cost.valid,
      apiCurrentSalePrice: facts.apiCurrentSale.value,
      apiCurrentSalePricePresent: facts.apiCurrentSale.present,
      apiCurrentSalePriceValid: facts.apiCurrentSale.valid,
      apiSuggestPrice: facts.apiSuggest.value,
      apiSuggestPricePresent: facts.apiSuggest.present,
      apiSuggestPriceValid: facts.apiSuggest.valid,
    },
    market,
    costFloor: floor,
    rawRecommendation,
    recommendationPrice: roundedRecommendation,
    candidates,
    sampleSnapshot,
  }
  return freezeDeep(dto)
}

export const buildPriceCandidatePreview = createPriceCandidatePreview
export const generatePriceCandidatePreview = createPriceCandidatePreview
export const previewPriceCandidates = createPriceCandidatePreview

/** Build independent previews; a SKU can never inherit another SKU's samples. */
export function createPriceCandidatePreviews(inputs = [], options = {}) {
  if (!Array.isArray(inputs)) return []
  return inputs.map((input) => createPriceCandidatePreview(input, options))
}

export const buildPriceCandidatePreviews = createPriceCandidatePreviews

function candidatePrice(preview, choice, customPrice) {
  if (choice === 'custom') return positivePrice(customPrice, '自定义候选价')
  const candidate = Array.isArray(preview?.candidates) ? preview.candidates.find((item) => item.key === choice) : null
  return candidate?.price ?? null
}

/**
 * Add an explicitly confirmed selection to a preview without mutating the
 * original record.  This is still a DTO; API writeback is a separate gate.
 */
export function selectPriceCandidate(preview, {
  choice = 'recommendation',
  candidateKey = choice,
  customPrice,
  confirmed = false,
  operatorId = '',
  note = '',
  selectedAt = Date.now(),
} = {}) {
  if (!isRecord(preview)) throw new TypeError('价格预览无效')
  if (preview.reviewOnly || preview.status !== 'ready') throw new Error('价格预览处于复核状态，不能确认价格')
  if (preview.policy?.selectionRequiresExplicitConfirm !== false && confirmed !== true) throw new Error('必须显式确认价格候选')
  const selectedPrice = candidatePrice(preview, candidateKey, customPrice)
  if (!Number.isFinite(selectedPrice) || selectedPrice <= 0) throw new Error('候选价格无效')
  if (!Number.isFinite(preview.costFloor) || selectedPrice < preview.costFloor) throw new Error('候选价格不得低于成本底价')
  const selectedAtMs = resolveNow(selectedAt)
  const selection = {
    choice: candidateKey,
    selectedPrice,
    operatorId: text(operatorId) || null,
    note: text(note) || null,
    confirmedAt: iso(selectedAtMs),
    previewId: preview.previewId,
    policyVersion: preview.policyVersion,
    inputSnapshotHash: preview.inputSnapshotHash,
  }
  const idempotencyKey = `${preview.spuCode}:${preview.skuCode}:${preview.previewId}:${preview.policyVersion}:${selectedPrice}`
  return freezeDeep({
    ...preview,
    status: 'selected',
    selectedPrice,
    selectedCandidate: candidateKey,
    selection,
    selectionIdempotencyKey: idempotencyKey,
  })
}

export const confirmPriceSelection = selectPriceCandidate
export const confirmPricePreview = selectPriceCandidate

export function isPricePreviewSelected(preview) {
  return isRecord(preview) && preview.status === 'selected' && Number.isFinite(preview.selectedPrice)
}
