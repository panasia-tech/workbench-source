/**
 * 与闲鱼 PC 搜索一致：propValueStr.searchFilter 拼串（参考 search-local.html → buildPropSearchFilter）
 * 例：quickFilter:filterPersonal,filterAppraise,gameAccountInsurance,…;publishDays:7;
 */

const { applyDivisionToSearchOptions } = require('./division-filter')

const ALLOWED_QUICK_FILTER_KEYS = new Set([
  'filterPersonal',
  'filterAppraise',
  'gameAccountInsurance',
  'filterFreePostage',
  'filterHighLevelYxpSeller',
  'filterNew',
  'inspectedPhone',
  'filterOneKeyResell'
])

const ALLOWED_PUBLISH_DAYS = new Set(['', 'latest', '1', '3', '7', '14'])

function sanitizePublishDays(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  if (ALLOWED_PUBLISH_DAYS.has(s)) return s
  return ''
}

/** 仅保留数字与小数点，避免异常字符进入 MTOP */
function sanitizePriceNum(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  const m = s.match(/^\d+(?:\.\d{1,2})?$/)
  return m ? m[0] : ''
}

function sanitizeQuickFilters(raw) {
  if (raw == null) return []
  if (!Array.isArray(raw)) return []
  const out = []
  for (const x of raw) {
    const s = String(x || '').trim()
    if (!ALLOWED_QUICK_FILTER_KEYS.has(s)) continue
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 与闲鱼 App / PC 抓包一致：综合（modify/pos/credit）、新降价、最新发布、价格 等大互斥；
 * 具体数值见 resolveSortFromMode。
 */
/** 排序下拉里的「新发布 · …」与 publish_days 等价，写入请求前映射 */
const SORT_MODE_TO_PUBLISH_DAYS = {
  publish_latest: 'latest',
  publish_1: '1',
  publish_3: '3',
  publish_7: '7',
  publish_14: '14'
}

const ALLOWED_SORT_MODES = new Set([
  '',
  'create_desc',
  'modify_desc',
  'credit_desc',
  'pos_asc',
  'reduce_desc',
  'price_asc',
  'price_desc',
  ...Object.keys(SORT_MODE_TO_PUBLISH_DAYS)
])

function sanitizeSortMode(raw) {
  const v = String(raw == null ? '' : raw).trim()
  if (!ALLOWED_SORT_MODES.has(v)) return ''
  return v
}

function resolveSortFromMode(mode) {
  switch (mode) {
    case 'create_desc':
      return { sortField: 'create', sortValue: 'desc' }
    case 'modify_desc':
      return { sortField: 'modify', sortValue: 'desc' }
    case 'credit_desc':
      return { sortField: 'credit', sortValue: 'credit_desc' }
    case 'pos_asc':
      return { sortField: 'pos', sortValue: 'asc' }
    case 'reduce_desc':
      return { sortField: 'reduce', sortValue: 'desc' }
    case 'price_asc':
      return { sortField: 'price', sortValue: 'asc' }
    case 'price_desc':
      return { sortField: 'price', sortValue: 'desc' }
    default:
      return { sortField: '', sortValue: '' }
  }
}

/**
 * 与 search-local.html search() + buildPropSearchFilter() 对齐（综合排序、latest 行为、fromFilter 交 sign-simulate 内推导）。
 * @param {*} body
 * @returns {{ sortField: string, sortValue: string, propValueStr: object, extraFilterValue: string, userPositionJson: string }}
 */
function buildSearchOptionsFromTaskBody(body = {}) {
  const priceFrom =
    sanitizePriceNum(body.price_from ?? body.priceFrom ?? body.price_min ?? '')
  const priceTo = sanitizePriceNum(body.price_to ?? body.priceTo ?? body.price_max ?? '')
  let publishDays = sanitizePublishDays(body.publish_days ?? body.publishDays ?? '')
  const quickFilters = sanitizeQuickFilters(body.quick_filters ?? body.quickFilters ?? [])
  const rawSort = String(body.sort_mode ?? body.sortMode ?? '').trim()
  if (SORT_MODE_TO_PUBLISH_DAYS[rawSort] != null) {
    publishDays = SORT_MODE_TO_PUBLISH_DAYS[rawSort]
  }
  const sortModeForResolve =
    SORT_MODE_TO_PUBLISH_DAYS[rawSort] != null ? '' : sanitizeSortMode(rawSort)

  const parts = []
  if (priceFrom || priceTo) {
    parts.push(`priceRange:${priceFrom || 0},${priceTo || ''};`)
  }
  if (quickFilters.length) {
    parts.push(`quickFilter:${quickFilters.join(',')};`)
  }

  let sort = resolveSortFromMode(sortModeForResolve)

  if (publishDays === 'latest') {
    publishDays = ''
    if (!sort.sortField && !sort.sortValue) {
      sort = { sortField: 'create', sortValue: 'desc' }
    }
  } else if (publishDays === '1' || publishDays === '3' || publishDays === '7' || publishDays === '14') {
    parts.push(`publishDays:${publishDays};`)
    // 抓包：选「几天内」时只走 searchFilter.publishDays，sortField/sortValue 必须为空
    sort = { sortField: '', sortValue: '' }
  }

  const searchFilter = parts.join('')
  const propValueStr = searchFilter ? { searchFilter } : {}

  const base = {
    sortField: sort.sortField,
    sortValue: sort.sortValue,
    propValueStr
  }
  return applyDivisionToSearchOptions(body, base)
}

module.exports = {
  buildSearchOptionsFromTaskBody,
  sanitizePublishDays,
  sanitizePriceNum,
  sanitizeQuickFilters,
  sanitizeSortMode
}
