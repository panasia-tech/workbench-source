// 销售价回填围栏：销售/行情价不得低于采购价（纯函数，可独立回归）。
//
// 价格来自 Excel、网页和模型输出，不能直接交给 Number()：Number('') 为 0，
// Number('¥1,200') 为 NaN，都会让“缺失”和“有值但非法”混在一起。这个模块是
// 唯一的金额解析/围栏边界，调用方只消费解析后的数值或可展示的阻断原因。

// 120% 不再是硬门槛；当前业务合同只要求销售价不低于采购价。
export const MIN_SALES_MARGIN_RATIO = 1
export const MIN_PREVIEW_MARKET_PRICE = 100

const MONEY_PATTERN = /^(?:\d+)(?:\.\d{1,2})?$/

function rawPresent(value) {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')
}

function shown(value) {
  return String(value ?? '').trim().slice(0, 80) || '空值'
}

/**
 * 严格解析人民币金额。
 *
 * `present:false` 只代表调用方没有提供采购价；一旦值存在但格式错误、非有限
 * 或不大于 0，就返回 `ok:false`，禁止调用方把它当成“没有采购价”而放过发布。
 * @returns {{present:boolean,ok:boolean,value:number|null,reason:string}}
 */
export function parseMoney(value, { label = '价格' } = {}) {
  if (!rawPresent(value)) {
    return { present: false, ok: true, value: null, reason: `${label}未提供` }
  }

  let normalized = value
  if (typeof value === 'string') {
    normalized = value
      .trim()
      .replace(/^[¥￥]\s*/, '')
      .replace(/\s*元\s*$/u, '')
      .replace(/[，,\s]/g, '')
  }

  const number = typeof normalized === 'number'
    ? normalized
    : (typeof normalized === 'string' && MONEY_PATTERN.test(normalized) ? Number(normalized) : NaN)
  if (!Number.isFinite(number)) {
    return { present: true, ok: false, value: null, reason: `${label}格式无效（${shown(value)}），已阻止发布` }
  }
  if (number <= 0) {
    return { present: true, ok: false, value: null, reason: `${label}必须大于 0（${shown(value)}），已阻止发布` }
  }
  // 金额在业务边界统一保留两位，避免模型/Excel 的浮点尾数穿过围栏。
  const rounded = Math.round((number + Number.EPSILON) * 100) / 100
  return { present: true, ok: true, value: rounded, reason: `${label}解析通过` }
}

// 语义化别名，便于导入边界代码明确表达“采购价/售价解析”而不复制规则。
export const parsePrice = parseMoney
export const normalizeMoney = (value, options) => {
  const parsed = parseMoney(value, options)
  return parsed.ok ? parsed.value : null
}

/**
 * Normalize the optional SPU candidate-listing fence.  This is deliberately
 * separate from `priceFenceCheck`: the latter is a purchase-price publication
 * gate, while this one only decides which Xianyu listings can contribute to a
 * market quote.  Neither rule may change the 120/150/200 display bands.
 */
export function normalizeListingPriceFence(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  let minListingPrice = normalizeMoney(source.minListingPrice ?? source.min ?? source.minimum, { label: 'SPU 最低挂牌价' })
  let maxListingPrice = normalizeMoney(source.maxListingPrice ?? source.max ?? source.maximum, { label: 'SPU 最高挂牌价' })
  if (minListingPrice !== null && maxListingPrice !== null && minListingPrice > maxListingPrice) {
    // Do not guess operator intent for an inverted range; filtering every
    // listing would be much worse than leaving the candidate fence inactive.
    minListingPrice = null
    maxListingPrice = null
  }
  return { minListingPrice, maxListingPrice }
}

/**
 * Classify one Xianyu listing against the SPU candidate fence.  The returned
 * reason codes are audit-only candidate reasons; they never mean that the
 * task failed the purchase-price publication fence.
 */
export function listingPriceFenceCheck({ listingPrice, priceFence = {} } = {}) {
  const listing = parseMoney(listingPrice, { label: '挂牌价' })
  const normalizedFence = normalizeListingPriceFence(priceFence)
  const base = {
    listingPrice: listing.value,
    priceFence: normalizedFence,
    reasonCode: 'accepted'
  }
  if (!listing.ok) return { ok: false, ...base, reasonCode: 'invalid_listing_price', reason: listing.reason }
  if (normalizedFence.minListingPrice !== null && listing.value < normalizedFence.minListingPrice) {
    return {
      ok: false,
      ...base,
      reasonCode: 'below_spu_min_price',
      reason: `挂牌价 ¥${listing.value} 低于 SPU 最低挂牌价 ¥${normalizedFence.minListingPrice}`
    }
  }
  if (normalizedFence.maxListingPrice !== null && listing.value > normalizedFence.maxListingPrice) {
    return {
      ok: false,
      ...base,
      reasonCode: 'above_spu_max_price',
      reason: `挂牌价 ¥${listing.value} 高于 SPU 最高挂牌价 ¥${normalizedFence.maxListingPrice}`
    }
  }
  return { ok: true, ...base, reason: 'SPU 挂牌价围栏通过' }
}

/**
 * 给行情记录/预览使用的采购价对比，不参与发布放行决策。
 *
 * 这条展示链故意和 priceFenceCheck 分开：发布仍只做“不得低于采购价”的
 * 确定性安全校验，但预览需要保留运营人员原来看的 120%/150%/200% 分档，
 * 以及低于 100 元、低于采购价和采购价缺失等可解释原因。
 */
export function classifyPriceAgainstPurchase({
  marketPrice,
  purchasePrice,
  purchasePriceStatus = '',
  purchasePriceReason = '',
  minimumMarketPrice = MIN_PREVIEW_MARKET_PRICE
} = {}) {
  const market = parseMoney(marketPrice, { label: '行情价' })
  const purchase = parseMoney(purchasePrice, { label: '采购价' })
  const base = {
    marketPrice: market.value,
    purchasePrice: purchase.value,
    ratio: null,
    ratioPercent: null,
    markupPercent: null,
    difference: null,
    key: 'unknown',
    label: '待判断',
    reason: ''
  }
  if (!market.present || !market.ok) {
    return {
      ...base,
      key: 'invalid_market_price',
      label: '无有效行情价',
      reason: market.reason
    }
  }
  if (market.value < Number(minimumMarketPrice)) {
    return {
      ...base,
      marketPrice: market.value,
      key: 'below_minimum',
      label: `低于${Number(minimumMarketPrice)}元`,
      reason: `行情价 ¥${market.value} 低于 ${Number(minimumMarketPrice)} 元`
    }
  }
  if (purchasePriceStatus === 'invalid') {
    return {
      ...base,
      marketPrice: market.value,
      key: 'invalid_purchase_price',
      label: '采购价无效',
      reason: purchasePriceReason || purchase.reason
    }
  }
  if (!purchase.present) {
    return {
      ...base,
      marketPrice: market.value,
      key: 'no_purchase_price',
      label: '无采购价',
      reason: '未提供采购价，无法计算相对档位'
    }
  }
  if (!purchase.ok) {
    return {
      ...base,
      marketPrice: market.value,
      key: 'invalid_purchase_price',
      label: '采购价无效',
      reason: purchase.reason
    }
  }

  const ratio = market.value / purchase.value
  const ratioPercent = Math.round(ratio * 1000) / 10
  const markupPercent = Math.round((ratio - 1) * 1000) / 10
  const difference = Math.round((market.value - purchase.value) * 100) / 100
  const relative = { ...base, marketPrice: market.value, purchasePrice: purchase.value, ratio, ratioPercent, markupPercent, difference }
  if (ratio < 1) {
    return {
      ...relative,
      key: 'below_purchase_price',
      label: '低于采购价',
      reason: `行情价 ¥${market.value} 低于采购价 ¥${purchase.value}（差 ¥${Math.abs(difference).toFixed(2)}）`
    }
  }
  if (ratio < 1.2) {
    return { ...relative, key: 'purchase_100_119', label: '高于采购价（未满120%）', reason: `行情价为采购价的 ${ratioPercent}%` }
  }
  if (ratio < 1.5) {
    return { ...relative, key: 'purchase_120_plus', label: '达到采购价120%', reason: `行情价为采购价的 ${ratioPercent}%` }
  }
  if (ratio < 2) {
    return { ...relative, key: 'purchase_150_plus', label: '达到采购价150%', reason: `行情价为采购价的 ${ratioPercent}%` }
  }
  return { ...relative, key: 'purchase_200_plus', label: '达到采购价200%', reason: `行情价为采购价的 ${ratioPercent}%` }
}

/**
 * @param {{marketPrice:number|string, purchasePrice:number|string, minMarginRatio?:number}} input
 * @returns {{ok:boolean, requiredMin:number|null, reason:string, marketPrice:number|null, purchasePrice:number|null, marketPresent:boolean, purchasePresent:boolean}}
 */
export function priceFenceCheck({ marketPrice, purchasePrice, minMarginRatio = MIN_SALES_MARGIN_RATIO } = {}) {
  const market = parseMoney(marketPrice, { label: '行情价' })
  const purchase = parseMoney(purchasePrice, { label: '采购价' })
  const base = {
    requiredMin: null,
    marketPrice: market.value,
    purchasePrice: purchase.value,
    marketPresent: market.present,
    purchasePresent: purchase.present
  }

  // 行情价即使没有采购价也必须是确定的正数；不能把 NaN/0 伪装成“无采购价”。
  if (!market.ok) return { ok: false, ...base, reason: market.reason }
  if (!purchase.present) {
    return { ok: true, ...base, reason: '无采购价，跳过销售价围栏' }
  }
  if (!purchase.ok) return { ok: false, ...base, reason: purchase.reason }

  // Keep the former parameter for caller compatibility, but never let a legacy 1.2
  // value turn the old margin into a hard publication gate.
  void minMarginRatio
  const ratio = MIN_SALES_MARGIN_RATIO
  const requiredMin = Math.round(purchase.value * ratio * 100) / 100
  if (market.value < requiredMin) {
    return {
      ok: false,
      ...base,
      requiredMin,
      reason: `行情价 ¥${market.value} 低于采购价 ¥${purchase.value}（需 ≥¥${requiredMin}），已拦截发布`
    }
  }
  return { ok: true, ...base, requiredMin, reason: '销售价围栏通过（≥采购价）' }
}
