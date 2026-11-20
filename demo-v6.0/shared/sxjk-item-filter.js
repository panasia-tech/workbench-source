/**
 * 闲鱼上新：商品本地过滤（全域/店铺/主进程/服务端口径一致）
 *
 * 轮询完整链（渲染层 filterPollCandidateItems / 店铺 executeShopPoll）：
 *   1. 同页 itemId 去重
 *   2. 已推送日志去重（filter_pushed_enabled 开启时，须先于一切条件过滤）
 *   3. 最新发布分钟窗（仅全域 + 最新排序）
 *   4. 条件过滤子链（applyTaskItemFilters / passesSingleItemFilters）：
 *      黑名单 → 全局价格 → 标题排除 → 商家排除 → 标题包含 → 词段价格
 */
import {
  PIPE_KW_SEG_CAP,
  PIPE_KW_SEG_MAX_LEN,
  PIPE_KW_RAW_MAX_LEN,
  PIPE_SEGMENT_SPLIT_RE
} from './pipe-keywords-limits.js'

export { PIPE_KW_RAW_MAX_LEN, PIPE_SEGMENT_SPLIT_RE }

export function parsePipeKeywords(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return []
  const seen = new Set()
  const out = []
  for (let p of s.split(PIPE_SEGMENT_SPLIT_RE)) {
    p = p.trim()
    if (!p || p.length > PIPE_KW_SEG_MAX_LEN) continue
    const k = normalizeLooseTextForMatch(p)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(p)
    if (out.length >= PIPE_KW_SEG_CAP) break
  }
  return out
}

export function normalizeLooseTextForMatch(s) {
  let t = String(s ?? '')
  try {
    t = t.normalize('NFKC')
  } catch {
    /* */
  }
  return t.toLowerCase().replace(/\s+/gu, '')
}

export function parseItemPriceYuan(priceStr) {
  const s = String(priceStr ?? '').trim()
  if (!s || s.includes('待询价')) return null
  const wan = s.match(/([\d.]+)\s*万/)
  if (wan) {
    const n = Number(wan[1])
    return Number.isFinite(n) ? n * 10000 : null
  }
  const cleaned = s.replace(/[,，¥￥\s]/g, '')
  const direct = cleaned.match(/^\d+(?:\.\d{1,2})?$/)
  if (direct) {
    const n = Number(direct[0])
    return Number.isFinite(n) ? n : null
  }
  const loose = s.match(/(\d+(?:\.\d{1,2})?)/)
  if (loose) {
    const n = Number(loose[1])
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function parseOptionalPriceNumber(x) {
  const s = String(x ?? '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function parseGlobalTaskPriceBounds(body) {
  let min = parseOptionalPriceNumber(body?.price_from ?? body?.priceFrom ?? body?.price_min)
  let max = parseOptionalPriceNumber(body?.price_to ?? body?.priceTo ?? body?.price_max)
  if (min != null && max != null && min > max) {
    const t = min
    min = max
    max = t
  }
  return { min, max }
}

export function parseMatchSubPriceRangesFromBody(body) {
  const raw = body?.match_sub_price_ranges ?? body?.matchSubPriceRanges
  let obj = {}
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return {}
    }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw
  } else {
    return {}
  }
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = normalizeLooseTextForMatch(k)
    if (!key || key.length > 200) continue
    if (v == null || typeof v !== 'object') continue
    let min = parseOptionalPriceNumber(v.min ?? v.price_from)
    let max = parseOptionalPriceNumber(v.max ?? v.price_to)
    if (min != null && max != null && min > max) {
      const t = min
      min = max
      max = t
    }
    out[key] = { min, max }
    if (Object.keys(out).length >= 60) break
  }
  return out
}

export function parseSellerBlacklistUserIds(body) {
  const raw = body?.seller_blacklist_user_ids
  if (!Array.isArray(raw)) return new Set()
  const out = new Set()
  for (const x of raw) {
    const s = String(x ?? '').trim()
    if (s) out.add(s)
  }
  return out
}

export function parseItemPublishTimeMs(it) {
  const raw = String(it?.publishTimeMs ?? '').trim()
  if (!raw) return null
  let n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n < 1e12) n *= 1000
  return n
}

export function filterItemsByPublishLatestWindow(items, minutes) {
  const m = Math.floor(Number(minutes))
  if (!Number.isFinite(m) || m < 1) return { items: Array.isArray(items) ? items : [], removed: 0 }
  const cutoff = Date.now() - m * 60 * 1000
  const list = Array.isArray(items) ? items : []
  const out = []
  let removed = 0
  for (const it of list) {
    const ms = parseItemPublishTimeMs(it)
    if (ms == null) {
      removed += 1
      continue
    }
    if (ms >= cutoff) out.push(it)
    else removed += 1
  }
  return { items: out, removed }
}

/** 同页 itemId 去重，保留首次出现 */
export function pageDedupeItems(items) {
  const seen = new Set()
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    const id = String(it?.itemId ?? it?.id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(it)
  }
  return out
}

/** 推送日志 itemId 去重 */
export function filterItemsByPushedIds(items, pushedSet) {
  if (!pushedSet || !(pushedSet instanceof Set) || !pushedSet.size) {
    return { items: Array.isArray(items) ? items : [], removed: 0 }
  }
  const list = Array.isArray(items) ? items : []
  const out = []
  let removed = 0
  for (const it of list) {
    const id = String(it?.itemId ?? it?.id ?? '').trim()
    if (id && pushedSet.has(id)) {
      removed += 1
      continue
    }
    out.push(it)
  }
  return { items: out, removed }
}

export function titleContainsAnyKeyword(title, includeList) {
  if (!includeList.length) return true
  const t = normalizeLooseTextForMatch(title)
  for (const kw of includeList) {
    const k = normalizeLooseTextForMatch(kw)
    if (k && t.includes(k)) return true
  }
  return false
}

export function titlePassesExcludeKeywords(title, excludeList) {
  if (!excludeList.length) return true
  const t = normalizeLooseTextForMatch(title)
  for (const kw of excludeList) {
    const k = normalizeLooseTextForMatch(kw)
    if (k && t.includes(k)) return false
  }
  return true
}

/** 参与商家名称过滤的展示字段：卖家昵称 + 店铺名（去重后逐段比对） */
function pickShopDisplayNameFromListingTitle(title) {
  let t = String(title ?? '').trim()
  if (!t) return ''
  t = t.replace(/^【[^】]{1,32}】/u, '').trim()
  const m = t.match(/^(.{2,80}?)\s*[|｜]\s+.+/u)
  if (!m) return ''
  const prefix = m[1].trim()
  if (prefix.length < 2) return ''
  return prefix.slice(0, 120)
}

export function pickSellerFilterDisplayTexts(it) {
  const rawFields = [it?.seller, it?.sellerNick, it?.shopName, it?.nick]
  const seen = new Set()
  const out = []
  for (const s of rawFields) {
    const t = String(s ?? '').trim()
    if (!t) continue
    const k = normalizeLooseTextForMatch(t)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  if (!out.length) {
    const fromTitle = pickShopDisplayNameFromListingTitle(it?.title || it?.detailTitle)
    if (fromTitle) {
      const k = normalizeLooseTextForMatch(fromTitle)
      if (k && !seen.has(k)) out.push(fromTitle)
    }
  }
  return out
}

/** 多个展示名任一段命中排除词即 false */
export function sellerTextsPassExcludeKeywords(texts, excludeSellerList) {
  if (!excludeSellerList.length) return true
  const normalized = (Array.isArray(texts) ? texts : [])
    .map((s) => normalizeLooseTextForMatch(s))
    .filter(Boolean)
  if (!normalized.length) return true
  for (const kw of excludeSellerList) {
    const k = normalizeLooseTextForMatch(kw)
    if (!k) continue
    for (const t of normalized) {
      if (t.includes(k)) return false
    }
  }
  return true
}

/** 卖家昵称 / 店铺展示名：任一段命中即排除（忽略大小写与空格） */
export function sellerPassesExcludeKeywords(sellerNick, excludeSellerList, shopName = '') {
  return sellerTextsPassExcludeKeywords([sellerNick, shopName], excludeSellerList)
}

/** 单条商品：合并 seller / sellerNick / shopName 后再比对 */
export function itemSellerPassesExcludeKeywords(it, excludeSellerList) {
  return sellerTextsPassExcludeKeywords(pickSellerFilterDisplayTexts(it), excludeSellerList)
}

/**
 * 批量剔除命中商家名称排除词的商品（任务 exclude_seller_keywords + 全局黑名单昵称）
 * @returns {{ items: object[], removed: number, excludeSellerList: string[] }}
 */
export function applySellerExcludeKeywordGate(items, taskBody, extra = {}) {
  const filterOpts = buildFilterOptsFromTaskBody(
    taskBody,
    extra?.sellerBlacklistIds ?? new Set(),
    { extraSellerExcludeRaw: extra?.extraSellerExcludeRaw ?? '' }
  )
  const excludeSellerList = filterOpts.excludeSellerList
  const list = Array.isArray(items) ? items : []
  if (!excludeSellerList.length) {
    return { items: list, removed: 0, excludeSellerList: [] }
  }
  const out = []
  let removed = 0
  for (const it of list) {
    if (itemSellerPassesExcludeKeywords(it, excludeSellerList)) out.push(it)
    else removed += 1
  }
  return { items: out, removed, excludeSellerList }
}

function hasConfiguredMatchSubKeywordPrice(rangeMap, includeList) {
  if (!rangeMap || typeof rangeMap !== 'object' || !Array.isArray(includeList)) return false
  for (const kw of includeList) {
    const k = normalizeLooseTextForMatch(kw)
    const r = rangeMap[k]
    if (r && (r.min != null || r.max != null)) return true
  }
  return false
}

/** 词段价格：须先命中包含词；排除词在调用方更早阶段已拦截 */
export function itemPassesMatchSubKeywordPriceRanges(title, priceStr, includeList, rangeMap) {
  if (!includeList.length || !hasConfiguredMatchSubKeywordPrice(rangeMap, includeList)) {
    return true
  }
  const t = normalizeLooseTextForMatch(title)
  const matchedKeys = []
  for (const kw of includeList) {
    const k = normalizeLooseTextForMatch(kw)
    if (k && t.includes(k)) matchedKeys.push(k)
  }
  if (!matchedKeys.length) return false

  const yuan = parseItemPriceYuan(priceStr)
  const rangedKeys = matchedKeys.filter((key) => {
    const r = rangeMap[key]
    return r && (r.min != null || r.max != null)
  })
  if (!rangedKeys.length) return true

  for (const key of rangedKeys) {
    const r = rangeMap[key]
    const lo = r.min != null ? r.min : -Infinity
    const hi = r.max != null ? r.max : Infinity
    if (yuan == null) continue
    if (yuan >= lo && yuan <= hi) return true
  }
  return false
}

function itemPassesGlobalPriceRange(it, min, max) {
  if (min == null && max == null) return true
  const yuan = parseItemPriceYuan(it?.price)
  if (yuan == null) return true
  if (min != null && yuan < min) return false
  if (max != null && yuan > max) return false
  return true
}

/**
 * 单条商品条件过滤（排除词优先于包含词；不含已推送去重，须由上层先执行）
 * @returns {{ pass: boolean, removedBy: string }}
 */
export function passesSingleItemFilters(it, opts = {}) {
  const {
    globalPriceMin = null,
    globalPriceMax = null,
    matchIncludeList = [],
    matchSubPriceRanges = {},
    excludeList = [],
    excludeSellerList = [],
    sellerBlacklistIds = new Set(),
    skipKeywordPrice = false,
    blacklistOnly = false
  } = opts

  const bid = String(it?.sellerBlacklistId ?? '').trim()
  if (sellerBlacklistIds.size && bid && sellerBlacklistIds.has(bid)) {
    return { pass: false, removedBy: 'blacklist' }
  }
  if (blacklistOnly) return { pass: true, removedBy: '' }

  if (!itemPassesGlobalPriceRange(it, globalPriceMin, globalPriceMax)) {
    return { pass: false, removedBy: 'globalPrice' }
  }
  if (!titlePassesExcludeKeywords(it?.title, excludeList)) {
    return { pass: false, removedBy: 'excludeTitle' }
  }
  if (!itemSellerPassesExcludeKeywords(it, excludeSellerList)) {
    return { pass: false, removedBy: 'excludeSeller' }
  }
  if (matchIncludeList.length && !titleContainsAnyKeyword(it?.title, matchIncludeList)) {
    return { pass: false, removedBy: 'matchInclude' }
  }
  if (
    !skipKeywordPrice &&
    !itemPassesMatchSubKeywordPriceRanges(
      it?.title,
      it?.price,
      matchIncludeList,
      matchSubPriceRanges
    )
  ) {
    return { pass: false, removedBy: 'matchSubKeywordPrice' }
  }
  return { pass: true, removedBy: '' }
}

export function buildFilterOptsFromTaskBody(body, sellerBlacklistIds, extra = {}) {
  const matchIncludeList = parsePipeKeywords(
    String(body?.match_sub || '').trim().slice(0, PIPE_KW_RAW_MAX_LEN)
  )
  const matchSubPriceRanges = parseMatchSubPriceRangesFromBody(body)
  const excludeList = parsePipeKeywords(
    String(body?.exclude_keywords || '').trim().slice(0, PIPE_KW_RAW_MAX_LEN)
  )
  const extraSellerRaw = String(extra?.extraSellerExcludeRaw ?? '').trim()
  const excludeSellerList = parsePipeKeywords(
    [String(body?.exclude_seller_keywords || '').trim(), extraSellerRaw].filter(Boolean).join('|')
  )
  const blacklistSet =
    sellerBlacklistIds instanceof Set
      ? sellerBlacklistIds
      : parseSellerBlacklistUserIds({ seller_blacklist_user_ids: sellerBlacklistIds })
  const globalBounds = parseGlobalTaskPriceBounds(body)
  return {
    globalPriceMin: globalBounds.min,
    globalPriceMax: globalBounds.max,
    matchIncludeList,
    matchSubPriceRanges,
    excludeList,
    excludeSellerList,
    sellerBlacklistIds: blacklistSet
  }
}

function summarizeActiveLocalFilters(opts) {
  const parts = []
  const {
    globalPriceMin = null,
    globalPriceMax = null,
    matchIncludeList = [],
    excludeList = [],
    excludeSellerList = [],
    sellerBlacklistIds = new Set()
  } = opts
  if (globalPriceMin != null || globalPriceMax != null) {
    parts.push(
      `全局价格(元):${globalPriceMin != null ? globalPriceMin : ''}~${globalPriceMax != null ? globalPriceMax : ''}`
    )
  }
  if (excludeList.length) parts.push(`标题排除: ${excludeList.join('|')}`)
  if (excludeSellerList.length) parts.push(`商家名称排除: ${excludeSellerList.join('|')}`)
  if (matchIncludeList.length) parts.push(`标题含任一段: ${matchIncludeList.join('|')}`)
  if (sellerBlacklistIds instanceof Set && sellerBlacklistIds.size) {
    parts.push(`黑名单卖家: ${sellerBlacklistIds.size} 个`)
  }
  return parts.join('；') || '无'
}

/**
 * 批量条件过滤并统计各阶段剔除数
 */
export function applyTaskItemFilters(items, filterOpts, runOpts = {}) {
  const opts = { ...filterOpts, ...runOpts }
  const list = Array.isArray(items) ? items : []
  const rawItemCount = list.length
  const removed = {
    globalPrice: 0,
    excludeTitle: 0,
    excludeSeller: 0,
    matchInclude: 0,
    matchSubKeywordPrice: 0,
    blacklist: 0
  }
  const out = []
  for (const it of list) {
    const { pass, removedBy } = passesSingleItemFilters(it, opts)
    if (pass) out.push(it)
    else if (removedBy && Object.prototype.hasOwnProperty.call(removed, removedBy)) {
      removed[removedBy] += 1
    }
  }
  const stats = {
    rawItemCount,
    afterGlobalPriceCount: rawItemCount - removed.globalPrice,
    afterExcludeCount: rawItemCount - removed.globalPrice - removed.excludeTitle,
    afterExcludeSellerCount:
      rawItemCount - removed.globalPrice - removed.excludeTitle - removed.excludeSeller,
    afterMatchSubCount:
      rawItemCount -
      removed.globalPrice -
      removed.excludeTitle -
      removed.excludeSeller -
      removed.matchInclude,
    afterMatchSubKeywordPriceCount:
      rawItemCount -
      removed.globalPrice -
      removed.excludeTitle -
      removed.excludeSeller -
      removed.matchInclude -
      removed.matchSubKeywordPrice,
    afterSellerBlacklistCount: out.length,
    removed,
    activeFiltersSummary: summarizeActiveLocalFilters(opts)
  }
  return { items: out, stats }
}

/** 全域搜索：最新分钟窗 + 条件过滤 */
export function filterSearchMtopItems(normalizedItems, body, sellerBlacklistIds, extra = {}) {
  const filterOpts = buildFilterOptsFromTaskBody(body, sellerBlacklistIds, extra)

  const sortMode = String(body?.sort_mode ?? '').trim()
  const latestMin = Math.floor(Number(body?.sort_latest_within_minutes ?? body?.sortLatestWithinMinutes))
  const isLatestSort = sortMode === 'publish_latest' || sortMode === 'create_desc'
  const usePublishLatestWindow = isLatestSort && Number.isFinite(latestMin) && latestMin >= 1

  let preChain = normalizedItems
  let latestMinutesRemoved = 0
  if (usePublishLatestWindow) {
    const win = filterItemsByPublishLatestWindow(normalizedItems, latestMin)
    preChain = win.items
    latestMinutesRemoved = win.removed
  }

  const { items, stats } = applyTaskItemFilters(preChain, filterOpts)

  if (usePublishLatestWindow) {
    stats.beforeLatestMinutesCount = normalizedItems.length
    stats.afterLatestMinutesCount = preChain.length
    stats.latestMinutesRemoved = latestMinutesRemoved
    stats.latestWithinMinutes = latestMin
  }

  return { items, stats, rawItemCount: normalizedItems.length }
}

/**
 * 渲染层完整轮询过滤链：同页去重 → 已推送去重 → 最新分钟 → 条件过滤
 */
export function filterPollCandidateItems(items, taskBody, opts = {}) {
  const {
    sellerBlacklistIds = [],
    pushedSet = null,
    shouldFilterPushed = true,
    skipLatestWindow = false,
    extraSellerExcludeRaw = ''
  } = opts

  const deduped = pageDedupeItems(items)
  const afterPageDedupeCount = deduped.length

  let chain = deduped
  let skippedAlreadyPushed = 0
  if (shouldFilterPushed && pushedSet instanceof Set && pushedSet.size) {
    const pushedRes = filterItemsByPushedIds(chain, pushedSet)
    chain = pushedRes.items
    skippedAlreadyPushed = pushedRes.removed
  }

  const filterOpts = buildFilterOptsFromTaskBody(taskBody, sellerBlacklistIds, {
    extraSellerExcludeRaw
  })

  const sortMode = String(taskBody?.sort_mode ?? '').trim()
  const latestMin = Math.floor(
    Number(taskBody?.sort_latest_within_minutes ?? taskBody?.sortLatestWithinMinutes)
  )
  const isLatestSort = sortMode === 'publish_latest' || sortMode === 'create_desc'
  const usePublishLatestWindow =
    !skipLatestWindow && isLatestSort && Number.isFinite(latestMin) && latestMin >= 1

  let latestMinutesRemoved = 0
  if (usePublishLatestWindow) {
    const win = filterItemsByPublishLatestWindow(chain, latestMin)
    chain = win.items
    latestMinutesRemoved = win.removed
  }

  const { items: filtered, stats } = applyTaskItemFilters(chain, filterOpts)

  return {
    items: filtered,
    stats: {
      ...stats,
      afterPageDedupeCount,
      skippedAlreadyPushed,
      latestMinutesRemoved
    }
  }
}

/** 对已有列表：已推送去重（可选）→ 条件过滤（用于 toNotify 旁路等） */
export function filterItemsPassingTaskFilters(items, taskBody, sellerBlacklistIds, opts = {}) {
  const { pushedSet = null, shouldFilterPushed = false, extraSellerExcludeRaw = '' } = opts
  let chain = Array.isArray(items) ? items : []
  if (shouldFilterPushed && pushedSet instanceof Set && pushedSet.size) {
    chain = filterItemsByPushedIds(chain, pushedSet).items
  }
  const filterOpts = buildFilterOptsFromTaskBody(taskBody, sellerBlacklistIds, {
    extraSellerExcludeRaw
  })
  const { items: out } = applyTaskItemFilters(chain, filterOpts)
  return out
}
