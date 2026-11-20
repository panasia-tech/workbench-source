// 关键词行情模式的正常搜索合同：调度器只消费 task-store 已归一化的实际
// 查询数组。旧任务没有数组时才按品类规则补出默认查询；执行层不能再用
// 固定两项或单别称槽位截断用户已经配置的有效字段。
import { buildCategorySearchQueries, categorySearchProfile } from '../shared/category-search.js'

function text(value) {
  return String(value ?? '').trim()
}

function compact(value) {
  return text(value).replace(/[\s_\-/.]+/g, '')
}

function noPunctuation(value) {
  return text(value).replace(/[^\p{L}\p{N}]+/gu, '')
}

function configuredQueries(task) {
  const source = Array.isArray(task.searchKeywords) ? task.searchKeywords : []
  const seen = new Set()
  return source
    .flatMap((value) => String(value ?? '').split(/[\r\n,，、;；|]+/))
    .map((value) => text(value))
    .filter((value) => {
      const key = value.toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 12)
}

function cleanTerms(value, { limit = 100 } = {}) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item ?? '').split(/[\r\n,，、;；|]+/))
    .map((item) => text(item))
    .filter((item) => {
      const key = item.toLocaleLowerCase()
      if (!item || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}

function policyVersionForTask(task) {
  const raw = Number(task?.spuSearchPolicy?.version ?? task?.effectivePolicyVersion ?? 1)
  return Number.isInteger(raw) && raw > 0 ? raw : 1
}

// 按品类配置生成基础搜索词；返回空字符串表示任务没有可用的品牌/型号。
function naturalQuery(task) {
  const profile = categorySearchProfile(task.category, task.categorySearchModes)
  const queries = buildCategorySearchQueries(task, task.categorySearchModes)
  if (profile.mode === 'split') return queries[0] || ''
  return queries[0] || text(task.keyword)
}

export function searchQueriesForTask(task = {}, { strategy = 'normal' } = {}) {
  const brand = text(task.brand)
  const model = text(task.model)
  const fallback = text(task.keyword || task.name)
  const queries = []

  // task-store 已清洗并按顺序保存行级实际查询。这里保留完整数组，最多
  // 读取现有的 12 项输入保护边界，避免执行层和任务预览出现数量分叉。
  const configured = configuredQueries(task)
  if (configured.length) {
    queries.push(...configured)
  }

  if (!configured.length) {
    const profile = categorySearchProfile(task.category, task.categorySearchModes)
    const natural = naturalQuery(task)
    if (profile.mode === 'split') {
      queries.push(...buildCategorySearchQueries(task, task.categorySearchModes))
    } else if (natural) {
      queries.push(natural)
    } else {
      if (model) queries.push(model)
      if (brand && model) queries.push(`${brand} ${model}`)
    }
    if (!queries.length && fallback) queries.push(fallback)
  }

  // 只有异常队列才启用更宽的型号变体，避免日常运行额外触发风控。
  if (strategy !== 'normal') {
    const modelCompact = compact(model)
    const modelPlain = noPunctuation(model)
    const brandCompact = compact(brand)
    if (modelCompact && modelCompact !== model) queries.push(modelCompact)
    if (modelPlain && modelPlain !== model && modelPlain !== modelCompact) queries.push(modelPlain)
    const natural = naturalQuery(task)
    if (natural && !configured.length) {
      const compactNatural = noPunctuation(natural)
      if (compactNatural && compactNatural !== natural) queries.push(compactNatural)
      queries.push(natural.replace(/\s+/g, ''))
    } else if (!configured.length && brand && modelCompact) {
      queries.push(`${brand} ${modelCompact}`, `${brand}${modelCompact}`)
    }
    if (!configured.length && brandCompact && model) queries.push(`${brandCompact} ${model}`)
    if (fallback && fallback !== `${brand} ${model}`) queries.push(fallback)
  }

  // A legacy task may have an accepted alias field but no persisted
  // searchKeywords array. Keep the normal fallback consistent with decorated
  // tasks instead of silently dropping that explicit alias.
  for (const alias of (Array.isArray(task.aliases) ? task.aliases : []).slice(0, 12)) {
    if (text(alias)) queries.push(text(alias))
  }

  // A row-level `searchKeywords` array is the canonical query contract. Do
  // not let compatibility aliases or broad retry variants create a thirteenth
  // request when the task already contains the 12-field maximum. For
  // configured rows, preserve the same case-sensitive field order as the
  // task store; only the generated legacy fallback uses punctuation folding.
  if (strategy !== 'normal') return [...new Set(queries)].slice(0, 12)
  if (configured.length) return [...new Set(queries)].slice(0, 12)
  const seen = new Set()
  return queries.filter((query) => {
    const value = text(query)
    const key = noPunctuation(value).toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 12)
}

/**
 * Produce the one non-secret effective policy contract consumed by a crawl.
 * task-store has already resolved the SPU policy by canonical SPU identity;
 * this function only preserves that resolved result through normal/broad
 * retries and provides safe compatibility defaults for older task DTOs.
 */
export function effectiveCrawlPolicyForTask(task = {}, {
  globalBlacklist = [],
  strategy = 'normal'
} = {}) {
  const queries = searchQueriesForTask(task, { strategy })
  const effectiveBlacklist = task.effectiveBlacklist && typeof task.effectiveBlacklist === 'object'
    ? task.effectiveBlacklist
    : { mode: 'inherit', terms: globalBlacklist }
  const effectivePriceFence = task.effectivePriceFence && typeof task.effectivePriceFence === 'object'
    ? task.effectivePriceFence
    : {}
  const effectivePageFilter = task.effectivePageFilter && typeof task.effectivePageFilter === 'object'
    ? task.effectivePageFilter
    : { enabled: false }
  const relevanceKeywords = cleanTerms([
    task.model || task.name,
    ...queries,
    ...(Array.isArray(task.aliases) ? task.aliases : [])
  ], { limit: 120 })
  return {
    version: policyVersionForTask(task),
    queries,
    blacklist: {
      mode: ['inherit', 'append', 'replace'].includes(String(effectiveBlacklist.mode || '').toLowerCase())
        ? String(effectiveBlacklist.mode).toLowerCase()
        : 'inherit',
      terms: cleanTerms(effectiveBlacklist.terms ?? globalBlacklist)
    },
    relevanceKeywords,
    priceFence: {
      minListingPrice: effectivePriceFence.minListingPrice ?? null,
      maxListingPrice: effectivePriceFence.maxListingPrice ?? null
    },
    pageFilter: { enabled: effectivePageFilter.enabled === true }
  }
}
