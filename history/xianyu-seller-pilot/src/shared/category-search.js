// 品类搜索策略的唯一配置源。
// UI 只暴露两档主模式：split（字段拆分）和 combined（整词搜索）。
// composition 是该品类的固定组合方式，不按品牌建立规则，避免同一品牌跨品类串策略。

export const SEARCH_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    value: 'split',
    label: '主型号搜索',
    shortLabel: '主型号',
    description: '显示器默认搜索主型号与品牌+型号；明确别称非空时按顺序追加',
    primaryQuerySource: 'model',
    primaryQueryLimit: 2,
    aliasQueryLimit: 1,
    maxQueryCount: 3
  }),
  Object.freeze({
    value: 'combined',
    label: '整词搜索',
    shortLabel: '整词',
    description: '把品类需要的品牌/型号合成一条搜索词',
    primaryQuerySource: 'composition',
    primaryQueryLimit: 1,
    aliasQueryLimit: 1,
    maxQueryCount: 2
  })
])

// 品类默认查询的说明性元数据。Excel 显式搜索字段仍由 task-store 保留最多
// 12 个清洗后的值；这里不再把所有任务的实际查询数硬编码为两条。
export const CATEGORY_SEARCH_QUERY_LIMITS = Object.freeze({
  primary: 2,
  alias: 1,
  total: 3
})

const SEARCH_PROFILES = [
  {
    category: '显示器',
    aliases: ['显示器', '监视器'],
    defaultMode: 'split',
    composition: 'brand-model-space',
    compositionLabel: '两档都只搜一次：主型号 / 品牌+型号整词',
    example: '27GS820 / KTC 27GS820；唯一别称可再搜一次',
    modeExamples: { split: '主搜索：27GS820', combined: '主搜索：KTC 27GS820' }
  },
  {
    category: '空气净化器',
    aliases: ['空气净化器'],
    defaultMode: 'combined',
    composition: 'brand-category-model',
    compositionLabel: '品牌 + 品类 + 型号（不拆开）',
    example: '小米空气净化器5',
    modeExamples: { split: '主搜索：5', combined: '主搜索：小米空气净化器5' }
  },
  {
    category: '音响',
    aliases: ['音响', '音箱', '扬声器'],
    defaultMode: 'combined',
    composition: 'brand-model-compact',
    compositionLabel: '品牌 + 型号（不加空格）',
    example: 'sonosplay5',
    modeExamples: { split: '主搜索：PLAY5', combined: '主搜索：sonosplay5' }
  },
  {
    category: '脱毛仪',
    aliases: ['脱毛仪', '光子脱毛仪'],
    defaultMode: 'combined',
    composition: 'brand-model-space',
    compositionLabel: '品牌 + 型号（带空格）',
    example: '飞利浦 Lumea',
    modeExamples: { split: '主搜索：Lumea', combined: '主搜索：飞利浦 Lumea' }
  },
  {
    category: 'Apple产品',
    aliases: ['Apple产品', '苹果产品', 'Apple 產品', '苹果设备'],
    defaultMode: 'combined',
    composition: 'model',
    compositionLabel: '只搜型号/大众产品名，不加品牌',
    example: 'HomePod mini',
    modeExamples: { split: '主搜索：HomePod mini', combined: '主搜索：HomePod mini' }
  },
  {
    category: '默认/其它',
    aliases: ['默认', '默认/其它', '其它', '其他', '未分类'],
    defaultMode: 'combined',
    composition: 'brand-model-space',
    compositionLabel: '品牌 + 型号（带空格）',
    example: '佳明 Forerunner 265',
    modeExamples: { split: '主搜索：Forerunner 265', combined: '主搜索：佳明 Forerunner 265' }
  }
]

export const CATEGORY_SEARCH_PROFILES = Object.freeze(SEARCH_PROFILES.map((profile) => Object.freeze({
  ...profile,
  aliases: Object.freeze([...profile.aliases]),
  modeExamples: Object.freeze({ ...profile.modeExamples }),
  queryLimits: profile.category === '显示器'
    ? CATEGORY_SEARCH_QUERY_LIMITS
    : Object.freeze({ primary: 1, alias: 1, total: 2 }),
  queryPlan: profile.category === '显示器'
    ? 'model-plus-brand-model-plus-effective-alias'
    : 'one-primary-plus-effective-alias'
})))

export const DEFAULT_CATEGORY_SEARCH_MODES = Object.freeze(
  Object.fromEntries(CATEGORY_SEARCH_PROFILES.map((profile) => [profile.category, profile.defaultMode]))
)

function text(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value).trim()
  return ''
}

function compactCategory(value) {
  return text(value).toLowerCase().replace(/[\s_\-/]+/g, '')
}

function compactSearchToken(value) {
  return text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function validMode(value) {
  const mode = text(value).toLowerCase()
  return SEARCH_MODE_OPTIONS.some((option) => option.value === mode) ? mode : null
}

function sourceRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function configuredMode(profile, source) {
  const entries = Object.entries(source)
  const profileKey = compactCategory(profile.category)
  const aliasKeys = new Set(profile.aliases.map((alias) => compactCategory(alias)))

  // Preserve the old precedence: canonical category key wins over an alias.
  const exact = entries.find(([key, mode]) => key === profile.category && validMode(mode))
  if (exact) return validMode(exact[1])

  const canonical = entries.find(([key, mode]) => compactCategory(key) === profileKey && validMode(mode))
  if (canonical) return validMode(canonical[1])

  const alias = entries.find(([key, mode]) => aliasKeys.has(compactCategory(key)) && validMode(mode))
  return alias ? validMode(alias[1]) : null
}

export function normalizeCategorySearchModes(value) {
  const source = sourceRecord(value)
  const next = { ...DEFAULT_CATEGORY_SEARCH_MODES }
  for (const profile of CATEGORY_SEARCH_PROFILES) {
    next[profile.category] = configuredMode(profile, source) || profile.defaultMode
  }
  return next
}

export function categorySearchProfile(category, modes = {}) {
  const categoryKey = compactCategory(category)
  const profile = CATEGORY_SEARCH_PROFILES.find((candidate) => candidate.aliases.some((alias) => compactCategory(alias) === categoryKey))
    || CATEGORY_SEARCH_PROFILES[CATEGORY_SEARCH_PROFILES.length - 1]
  const normalizedModes = normalizeCategorySearchModes(modes)
  return {
    ...profile,
    mode: validMode(normalizedModes[profile.category]) || profile.defaultMode,
    queryLimits: profile.queryLimits,
    queryPlan: profile.queryPlan
  }
}

const APPLE_MODEL_NAMES = Object.freeze({
  APPLETV: 'Apple TV',
  APPLETV64G: 'Apple TV',
  HOMEPODMINI: 'HomePod mini',
  AIRPODSPRO3: 'AirPods Pro 3',
  PODSPRO3: 'AirPods Pro 3',
  PRO3: 'AirPods Pro 3',
  MAGICKEYBOARD: 'Magic Keyboard',
  MAGICTRACKPAD: 'Magic Trackpad',
  MAGICTRACKPAD3: 'Magic Trackpad 3',
  MAGICTRACKPAD4: 'Magic Trackpad 4',
  TRACKPAD3: 'Magic Trackpad 3'
})

export function publicAppleModel(value) {
  const source = text(value)
  if (!source) return ''
  return APPLE_MODEL_NAMES[source.toUpperCase().replace(/\s+/g, '')] || source
}

export function normalizeCategorySearchInput(value = {}) {
  const source = sourceRecord(value)
  return {
    brand: text(source.brand),
    model: text(source.model),
    category: text(source.category)
  }
}

export function buildCategorySearchQuery(task = {}, modes = {}) {
  const input = normalizeCategorySearchInput(task)
  const profile = categorySearchProfile(input.category, modes)
  const { brand: brandText, model: modelText } = input
  if (profile.mode === 'split' || profile.composition === 'model') return profile.category === 'Apple产品' ? publicAppleModel(modelText) : modelText
  if (profile.composition === 'brand-category-model') {
    if (!brandText) return modelText
    // Use the canonical profile category when an alias or spaced variant was
    // supplied. The compact comparison prevents “空气 净化器5” from getting
    // the category inserted a second time.
    const categoryText = profile.category
    const modelHasCategory = compactSearchToken(modelText)
      && [profile.category, ...profile.aliases].some((alias) => compactSearchToken(modelText).includes(compactSearchToken(alias)))
    return `${brandText}${modelHasCategory ? modelText : `${categoryText}${modelText}`}`
  }
  if (profile.composition === 'brand-model-compact') return [brandText, modelText].filter(Boolean).join('')
  return [brandText, modelText].filter(Boolean).join(' ')
}

export function buildCategorySearchQueries(task = {}, modes = {}) {
  const input = normalizeCategorySearchInput(task)
  const profile = categorySearchProfile(input.category, modes)
  if (profile.category === '显示器' && profile.mode === 'split') {
    // 显示器的默认合同是两条基础查询：型号、品牌+型号。别称由
    // task-store 按实际采纳顺序追加，不能在这里吞掉第二条基础查询。
    return [...new Set([
      input.model,
      [input.brand, input.model].filter(Boolean).join(' ')
    ].filter(Boolean))]
  }
  return [buildCategorySearchQuery(input, modes)].filter(Boolean)
}

// Structured counterpart to buildCategorySearchQueries(). Aliases are selected
// by task-store; the returned primaryQueries always reflects every default
// query that will actually be searched for this category/mode.
export function categorySearchQueryPlan(task = {}, modes = {}) {
  const input = normalizeCategorySearchInput(task)
  const profile = categorySearchProfile(input.category, modes)
  const primaryQuery = buildCategorySearchQuery(input, modes)
  return {
    category: profile.category,
    mode: profile.mode,
    composition: profile.composition,
    primaryQuery,
    primaryQueries: buildCategorySearchQueries(input, modes),
    aliasSource: 'effectiveAlias',
    aliasSlot: { source: 'effectiveAlias', maxQueries: profile.queryLimits.alias, afterPrimary: true },
    primaryQueryLimit: profile.queryLimits.primary,
    aliasQueryLimit: profile.queryLimits.alias,
    maxQueryCount: profile.queryLimits.total,
    queries: buildCategorySearchQueries(input, modes)
  }
}

export function categorySearchModeLabel(mode) {
  return SEARCH_MODE_OPTIONS.find((option) => option.value === validMode(mode))?.label || SEARCH_MODE_OPTIONS[1].label
}

export function categorySearchModeExample(profile, mode = profile?.mode) {
  const selectedMode = validMode(mode) || profile?.defaultMode
  return profile?.modeExamples?.[selectedMode] || profile?.example || ''
}

export function categorySearchModeSummary(modes = {}) {
  const profiles = categorySearchProfileRows(modes)
  const split = profiles.filter((profile) => profile.mode === 'split').length
  return {
    split,
    combined: profiles.length - split,
    text: `${split} 个主型号 · ${profiles.length - split} 个整词`
  }
}

export function categorySearchProfileRows(modes = {}) {
  const normalized = normalizeCategorySearchModes(modes)
  return CATEGORY_SEARCH_PROFILES.map((profile) => ({
    ...profile,
    mode: normalized[profile.category] || profile.defaultMode,
    queryLimits: profile.queryLimits,
    queryPlan: profile.queryPlan
  }))
}
