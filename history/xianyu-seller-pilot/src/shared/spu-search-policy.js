// SPU 搜索策略是纯数据合同：它不保存凭据、不推断 SPU 身份，也不修改 API 原文。
// 主进程负责按 canonical SPU 持久化；本模块只负责清洗和计算可执行的有效值。

export const SPU_SEARCH_POLICY_VERSION = 1
export const MAX_SPU_SEARCH_QUERIES = 12
export const MAX_SPU_BLACKLIST_TERMS = 100
export const SPU_SEARCH_MODES = Object.freeze(['inherit_category', 'explicit'])
export const SPU_BLACKLIST_MODES = Object.freeze(['inherit', 'append', 'replace'])

const MAX_QUERY_LENGTH = 120
const MAX_TERM_LENGTH = 80
const MAX_DISPLAY_NAME_LENGTH = 120
const MAX_SOURCE_LENGTH = 48

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function cleanList(value, { limit, itemLimit }) {
  const source = Array.isArray(value) ? value : [value]
  const seen = new Set()
  return source
    .flatMap((item) => text(item).split(/[\r\n,，、;；|]+/))
    .map((item) => text(item).slice(0, itemLimit))
    .filter((item) => {
      const key = item.toLocaleLowerCase()
      if (!item || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}

function mode(value, allowed, fallback) {
  const normalized = text(value).toLowerCase()
  return allowed.includes(normalized) ? normalized : fallback
}

// 价格为 0 或负数没有实际筛选含义；Infinity、NaN 和过高异常值也不能落库。
function price(value) {
  if (value === '' || value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10_000_000 ? parsed : null
}

function boundedPriceFence(value) {
  const source = object(value)
  let minListingPrice = price(source.minListingPrice ?? source.min ?? source.minimum)
  let maxListingPrice = price(source.maxListingPrice ?? source.max ?? source.maximum)
  if (minListingPrice !== null && maxListingPrice !== null && minListingPrice > maxListingPrice) {
    // 不猜测操作者意图：反向区间整体失效，避免意外过滤全部候选。
    minListingPrice = null
    maxListingPrice = null
  }
  return { minListingPrice, maxListingPrice }
}

/**
 * Convert an untrusted persisted/UI payload to the version 1 policy contract.
 * Unknown fields are deliberately dropped so credentials and RPA session data
 * cannot hitch a ride in a task DTO.
 */
export function normalizeSpuSearchPolicy(value = {}) {
  const source = object(value)
  const search = object(source.search)
  const blacklist = object(source.blacklist)
  const localization = object(source.localization)
  const pageFilter = object(source.pageFilter)
  const queries = cleanList(search.queries ?? source.searchQueries, { limit: MAX_SPU_SEARCH_QUERIES, itemLimit: MAX_QUERY_LENGTH })
  const searchAliases = cleanList(localization.searchAliases ?? source.searchAliases, { limit: MAX_SPU_SEARCH_QUERIES, itemLimit: MAX_QUERY_LENGTH })
  const requestedSearchMode = mode(search.mode ?? source.searchMode, SPU_SEARCH_MODES, 'inherit_category')
  return {
    version: SPU_SEARCH_POLICY_VERSION,
    search: {
      // An empty explicit policy would silently stop an otherwise valid legacy
      // task. Treat it as inheritance until the operator provides a query or
      // an explicitly opted-in search alias.
      mode: requestedSearchMode === 'explicit' && (queries.length || searchAliases.length) ? 'explicit' : 'inherit_category',
      queries
    },
    blacklist: {
      mode: mode(blacklist.mode ?? source.blacklistMode, SPU_BLACKLIST_MODES, 'inherit'),
      terms: cleanList(blacklist.terms ?? source.blacklistTerms, { limit: MAX_SPU_BLACKLIST_TERMS, itemLimit: MAX_TERM_LENGTH })
    },
    priceFence: boundedPriceFence(source.priceFence),
    pageFilter: {
      // The RPA layer may consume this intent later. It does not claim that a
      // page-side filter was applied or verified.
      enabled: pageFilter.enabled === true || source.pageFilterEnabled === true
    },
    localization: {
      displayName: text(localization.displayName ?? source.localizedDisplayName).slice(0, MAX_DISPLAY_NAME_LENGTH),
      // These aliases affect search only when explicitly supplied here; a
      // display name is never silently converted into a query.
      searchAliases
    }
  }
}

export function emptySpuSearchPolicy() {
  return normalizeSpuSearchPolicy()
}

function mergeQueries(primary = [], aliases = []) {
  return cleanList([...primary, ...aliases], { limit: MAX_SPU_SEARCH_QUERIES, itemLimit: MAX_QUERY_LENGTH })
}

/**
 * Combine a normalized policy with task/category defaults. `baseQueries` is
 * intentionally supplied by task-store: it may contain legacy explicit Excel
 * fields, so policy rollout never changes an old task's search behavior.
 */
export function buildEffectiveSpuSearchPolicy(value = {}, {
  baseQueries = [],
  globalBlacklist = []
} = {}) {
  const policy = normalizeSpuSearchPolicy(value)
  const inheritedQueries = cleanList(baseQueries, { limit: MAX_SPU_SEARCH_QUERIES, itemLimit: MAX_QUERY_LENGTH })
  const explicitQueries = policy.search.mode === 'explicit'
    ? policy.search.queries
    : inheritedQueries
  const queries = mergeQueries(explicitQueries, policy.localization.searchAliases)
  const inheritedBlacklist = cleanList(globalBlacklist, { limit: MAX_SPU_BLACKLIST_TERMS, itemLimit: MAX_TERM_LENGTH })
  const effectiveTerms = policy.blacklist.mode === 'replace'
    ? policy.blacklist.terms
    : policy.blacklist.mode === 'append'
      ? cleanList([...inheritedBlacklist, ...policy.blacklist.terms], { limit: MAX_SPU_BLACKLIST_TERMS, itemLimit: MAX_TERM_LENGTH })
      : inheritedBlacklist
  return {
    version: policy.version,
    search: {
      mode: policy.search.mode,
      queries,
      source: policy.search.mode === 'explicit' ? 'spu' : 'category'
    },
    blacklist: {
      mode: policy.blacklist.mode,
      terms: effectiveTerms
    },
    priceFence: { ...policy.priceFence },
    pageFilter: { ...policy.pageFilter },
    localization: { ...policy.localization }
  }
}

/** Normalize non-secret policy audit metadata before it crosses a DTO boundary. */
export function normalizeSpuSearchPolicyAudit(value = {}) {
  const source = object(value)
  return {
    source: text(source.source || 'manual').slice(0, MAX_SOURCE_LENGTH) || 'manual',
    updatedAt: text(source.updatedAt || '') || null,
    changedBy: text(source.changedBy || '').slice(0, MAX_SOURCE_LENGTH) || null
  }
}
