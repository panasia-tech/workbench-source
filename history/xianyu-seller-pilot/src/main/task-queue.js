// 任务队列的纯规则层：不读写 electron-store，便于主进程和回归测试共用。
// 一条任务只按当前清单里的“最新一次结果”进入一个队列；历史尝试仍保留在 runResults。

export const QUEUE_DEFINITIONS = [
  { key: 'all', label: '全部', retryable: false },
  { key: 'anomaly', label: '异常待处理', retryable: true },
  { key: 'pending', label: '待采集', retryable: false },
  { key: 'success', label: '成功', retryable: false },
  { key: 'empty', label: '无在售', retryable: true },
  { key: 'fail', label: '失败', retryable: true },
  { key: 'invalid_price', label: '错误价格', retryable: true },
  { key: 'ai_review', label: 'AI 人工复核', retryable: false },
  { key: 'risk_control', label: '风控暂停', retryable: false }
]

export const QUEUE_KEYS = new Set(QUEUE_DEFINITIONS.map((item) => item.key))
export const ANOMALY_QUEUE_KEYS = new Set(['empty', 'fail', 'invalid_price'])
export const AI_CORRECTION_QUEUE_KEY = 'ai_correction'
export const AI_REVIEW_QUEUE_KEY = 'ai_review'
export const CORRECTION_REVIEW_STATUSES = new Set(['custom_search_pending', 'price_review'])
// The renderer exposes five business buckets. Internal queue kinds (empty,
// invalid_price, risk_control, AI states) remain persisted for retry/audit,
// but they are folded into these stable display groups.
export const DISPLAY_GROUP_KEYS = Object.freeze(['all', 'failed', 'pending', 'success', 'review'])
export const PRICE_BAND_KEYS = Object.freeze([
  'purchase_100_119',
  'purchase_120_plus',
  'purchase_150_plus',
  'purchase_200_plus'
])

export function priceBandCounts(rows = []) {
  const counts = Object.fromEntries(PRICE_BAND_KEYS.map((key) => [key, 0]))
  for (const row of rows) {
    if (row.displayGroup !== 'success') continue
    const key = (row.priceComparison || row.lastPriceComparison)?.key
    if (Object.hasOwn(counts, key)) counts[key] += 1
  }
  return counts
}

function isAiCorrectionStatus(status) {
  return status !== 'done'
}

export function needsAiCorrection(row = {}) {
  return ANOMALY_QUEUE_KEYS.has(row.queueKind) && isAiCorrectionStatus(row.aiCorrectionStatus)
}

export function needsAiReview(row = {}) {
  return ['candidate', 'needs_review', 'search_failed'].includes(String(row.aiReviewStatus || ''))
}

export function isReviewRow(row = {}) {
  return needsAiReview(row) || String(row.aiCorrectionStatus || '') === 'needs_review' || CORRECTION_REVIEW_STATUSES.has(String(row.correctionWorkflowStatus || ''))
}

export function isFailedRow(row = {}) {
  const queueKind = normalizedQueueKind(row)
  return ANOMALY_QUEUE_KEYS.has(queueKind) || queueKind === 'risk_control'
}

function normalizedQueueKind(row = {}) {
  return queueKeyForStatus(row.queueKind ?? row.status)
}

/**
 * 展示层的历史“异常”聚合。它只用于兼容旧调用，不能写回结果 status。
 * 旧的 empty/fail/invalid_price、风控和 AI 处置队列仍由各自的内部值驱动。
 */
export function isAttentionRow(row = {}) {
  const queueKind = normalizedQueueKind(row)
  const normalizedRow = row.queueKind === queueKind ? row : { ...row, queueKind }
  return isFailedRow(normalizedRow) || isReviewRow(normalizedRow) || needsAiCorrection(normalizedRow)
}

/**
 * 当前任务的五组互斥展示分组，优先级固定为 review → failed → success → pending。
 * 未知/未落盘的结果沿用 queueKeyForStatus 的 pending 兼容语义。
 */
export function displayGroupForRow(row = {}) {
  if (isReviewRow(row)) return 'review'
  if (isFailedRow(row) || needsAiCorrection(row)) return 'failed'
  const queueKind = normalizedQueueKind(row)
  if (queueKind === 'success') return 'success'
  if (queueKind === 'pending') return 'pending'
  return 'failed'
}

export function displayGroupCounts(rows = []) {
  const groupCounts = { all: rows.length, failed: 0, pending: 0, success: 0, review: 0 }
  for (const row of rows) groupCounts[displayGroupForRow(row)] += 1
  return groupCounts
}

export function queueKeyForStatus(status) {
  return QUEUE_KEYS.has(status) ? status : 'pending'
}

export function queueDefinition(key) {
  return QUEUE_DEFINITIONS.find((item) => item.key === key) || QUEUE_DEFINITIONS[0]
}

export function queueRetryMode(key) {
  if (key === AI_CORRECTION_QUEUE_KEY) return {
    key,
    strategy: 'ai_correction',
    label: 'AI 纠改',
    description: '调用当前配置的大模型检查品牌/型号；修正后回到对应行情队列重新采集。'
  }
  if (key === AI_REVIEW_QUEUE_KEY) return {
    key,
    strategy: 'manual_review',
    label: 'AI 人工复核',
    description: '查看 AI 候选；如果仍然错误，手动打回后才调用一次当前供应商联网核查，并进入人工审阅。'
  }
  if (key === 'empty') return {
    key,
    strategy: 'broad',
    label: '放宽搜索',
    description: '增加紧凑型号、品牌型号连写和别名变体，避免写法差异造成无在售。'
  }
  if (key === 'fail') return {
    key,
    strategy: 'retry',
    label: '保守重试',
    description: '使用基础搜索词重试，并在渲染页异常时自动重建页面。'
  }
  if (key === 'invalid_price') return {
    key,
    strategy: 'broad',
    label: '复核行情',
    description: '扩大搜索词变体，仍按清洗后的平均挂牌价重新计算，不把低价垃圾带入均值。'
  }
  if (key === 'anomaly') return {
    key,
    strategy: 'broad',
    label: '处理全部异常',
    description: '依次处理无在售、失败和错误价格；风控暂停不会自动重复撞击平台。'
  }
  if (key === 'failed') return {
    key,
    strategy: 'broad',
    label: '失败复采',
    description: '修正搜索信息并人工确认后，按当前任务 SPU 重新进入行情采集。'
  }
  return {
    key,
    strategy: 'manual',
    label: '人工处理',
    description: '该队列不适合自动重试。'
  }
}

function normalizeQuery(value) {
  return String(value ?? '').trim().toLowerCase()
}

function identityKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_\-./:：()（）]+/g, '')
}

/**
 * 旧版本的 runResults 可能使用 UUID，而 Excel 任务后来改用内容 hash 作为 id。
 * 用名称、型号和 AI 生成的别名做兼容关联，避免历史异常结果从队列里“消失”。
 */
function identityKeys(row = {}) {
  const values = [
    row.name,
    row.keyword,
    [row.brand, row.model].filter(Boolean).join(' '),
    row.model,
    ...(Array.isArray(row.aliases) ? row.aliases : [])
  ]
  return [...new Set(values.map(identityKey).filter((value) => value.length > 1))]
}

function rowMatches(row, query) {
  if (!query) return true
  return [row.name, row.brand, row.model, row.size, row.spec, row.keyword, row.lastReason]
    .some((value) => normalizeQuery(value).includes(query))
}

function resultRunIds(runs, collectionId) {
  return new Set((runs || [])
    .filter((run) => !collectionId || run.collectionId === collectionId)
    .map((run) => run.id))
}

export function latestResultsByTask({ runs = [], runResults = [], collectionId = null } = {}) {
  const runIds = resultRunIds(runs, collectionId)
  const runFinishedAt = new Map((runs || []).map((run) => [run.id, Date.parse(run.finishedAt || run.startedAt || '') || 0]))
  const latest = new Map()
  const attempts = new Map()
  const latestByIdentity = new Map()
  const attemptsByIdentity = new Map()
  const isNewer = (candidate, previous) => {
    const candidateAt = Date.parse(candidate?.at || '') || runFinishedAt.get(candidate?.runId) || 0
    const previousAt = Date.parse(previous?.at || '') || runFinishedAt.get(previous?.runId) || 0
    return candidateAt > previousAt
  }
  for (const row of runResults || []) {
    if (collectionId && !runIds.has(row.runId)) continue
    attempts.set(row.taskId, (attempts.get(row.taskId) || 0) + 1)
    if (!latest.has(row.taskId) || isNewer(row, latest.get(row.taskId))) latest.set(row.taskId, row)
    for (const key of identityKeys(row)) {
      attemptsByIdentity.set(key, (attemptsByIdentity.get(key) || 0) + 1)
      if (!latestByIdentity.has(key) || isNewer(row, latestByIdentity.get(key))) latestByIdentity.set(key, row)
    }
  }
  return { latest, attempts, latestByIdentity, attemptsByIdentity }
}

export function buildQueueView({ tasks = [], runs = [], runResults = [], collectionId = null, kind = 'all', q = '', page = 1, pageSize = 100 } = {}) {
  const { latest, attempts, latestByIdentity, attemptsByIdentity } = latestResultsByTask({ runs, runResults, collectionId })
  const counts = Object.fromEntries(QUEUE_DEFINITIONS.map((item) => [item.key, 0]))
  const rows = (tasks || []).map((task) => {
    const taskIdentity = identityKeys(task)
    const idResult = latest.get(task.id) || null
    const identityResult = taskIdentity.map((key) => latestByIdentity.get(key)).find(Boolean) || null
    const result = idResult && identityResult
      ? (Date.parse(identityResult.at || '') > Date.parse(idResult.at || '') ? identityResult : idResult)
      : (idResult || identityResult)
    const attemptCount = Math.max(attempts.get(task.id) || 0, ...taskIdentity.map((key) => attemptsByIdentity.get(key) || 0))
    const queueKind = queueKeyForStatus(result?.status)
    counts[queueKind] = (counts[queueKind] || 0) + 1
    const row = {
      ...(result || {}),
      // 当前清单是权威型号/采购价；历史结果只提供状态、价格和原因，不能把旧型号覆盖回来。
      ...task,
      ...(result ? {
        lastResultName: result.name || '',
        lastResultBrand: result.brand || '',
        lastResultModel: result.model || ''
      } : {}),
      taskId: task.id,
      queueKind,
      attempts: attemptCount,
      lastStatus: result?.status || 'pending',
      lastReason: result?.reason || (result ? '' : '尚未采集')
    }
    return { ...row, displayGroup: displayGroupForRow(row) }
  })
  counts.all = rows.length
  counts.anomaly = rows.filter((row) => ANOMALY_QUEUE_KEYS.has(row.queueKind)).length
  const groupCounts = displayGroupCounts(rows)
  const currentPriceBandCounts = priceBandCounts(rows)
  const aiCorrectionItems = rows.filter(needsAiCorrection)
  const aiCorrectionCount = aiCorrectionItems.length
  const aiReviewItems = rows.filter(needsAiReview)
  const aiReviewCount = aiReviewItems.length
  counts.ai_review = aiReviewCount
  const query = normalizeQuery(q)
  const filtered = rows.filter((row) => {
    const inKind = kind === 'ai_correction'
      ? needsAiCorrection(row)
      : kind === AI_REVIEW_QUEUE_KEY
        ? needsAiReview(row)
      : kind === 'failed'
        ? row.displayGroup === 'failed'
      : kind === 'attention'
        ? isAttentionRow(row)
      : kind === 'review'
        ? row.displayGroup === 'review'
        : kind === 'all'
          ? true
          : kind === 'anomaly'
            ? ANOMALY_QUEUE_KEYS.has(row.queueKind)
            : ['pending', 'success'].includes(kind)
              ? row.displayGroup === kind
              : row.queueKind === kind
    return inKind && rowMatches(row, query)
  })
  const numericPage = Math.max(1, Number(page) || 1)
  const numericPageSize = Math.max(1, Number(pageSize) || 100)
  const start = (numericPage - 1) * numericPageSize
  return {
    items: filtered.slice(start, start + numericPageSize),
    total: filtered.length,
    counts,
    aiCorrectionCount,
    aiCorrectionItems,
    aiReviewCount,
    aiReviewItems,
    groupCounts,
    priceBandCounts: currentPriceBandCounts,
    kind,
    totalTasks: rows.length
  }
}

export function retryableQueue(key) {
  return key === 'anomaly' || key === 'failed' || key === AI_CORRECTION_QUEUE_KEY || ANOMALY_QUEUE_KEYS.has(key)
}
