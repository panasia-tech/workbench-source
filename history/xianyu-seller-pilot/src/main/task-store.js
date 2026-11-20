// 关键词行情任务中心的本地数据层。
//
// 任务清单来自可替换的 Excel；每次执行只创建 run 记录，不创建新的任务。
// 这样桌面端可以脱离大模型与服务端任务接口，直接依赖本机规则和已登录的闲鱼账号。
import { createHash, randomUUID } from 'crypto'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import Store from 'electron-store'
import { makeResilientStore } from './safe-store.js'
import * as XLSX from 'xlsx'
import { buildResumePlan } from './task-resume.js'
import { planSnapshotPrune, snapshotPathsOfResult } from './snapshot-retention.js'
import {
  buildQueueView,
  isFailedRow,
  isReviewRow,
  needsAiCorrection,
  queueKeyForStatus,
  queueRetryMode,
  retryableQueue
} from './task-queue.js'
import { buildSpuCatalog, canonicalSpu, decorateTaskWithWms, wmsMatchSummary } from './wms-match.js'
import { buildWmsCorrectionAudit, correctionVersionFor } from './wms-writeback.js'
import { classifyPriceAgainstPurchase, parseMoney } from './price-fence.js'
import { buildCategorySearchQueries, categorySearchProfile, normalizeCategorySearchModes } from '../shared/category-search.js'
import {
  buildEffectiveSpuSearchPolicy,
  emptySpuSearchPolicy,
  normalizeSpuSearchPolicy,
  normalizeSpuSearchPolicyAudit
} from '../shared/spu-search-policy.js'

const storeOptions = {
  name: 'xianyu-task-center',
  defaults: {
    activeCollectionId: null,
    collections: [],
    settings: {
      dailyEnabled: false,
      dailyTime: '02:00',
      launchAtLogin: true,
      autoResumeExecutors: true,
      throttleMinMs: 12000,
      throttleMaxMs: 20000,
      queryDelayMinMs: 8000,
      queryDelayMaxMs: 14000,
      rateSafetyVersion: 2,
      recycleEvery: 50,
      maxTasks: 0,
      syncToErp: false,
      wmsSource: 'auto', // WMS 数据源：auto=REST优先MCP兜底 / rest=仅REST / mcp=仅MCP（临时预览通道）
      wmsMcpUrl: '',
      wmsMcpKey: '',
      wmsRestUsername: '', // WMS 专用 REST 管理账号（走 admin-login，服务端只放行 ADMIN 角色，仅用于拉库存）
      wmsRestPassword: '',
      blacklistKeywords: [],
      categorySearchModes: normalizeCategorySearchModes()
    },
    runs: [],
    runResults: [],
    lastImport: null,
    wmsSkus: [],
    wmsSyncedAt: null,
    // Metadata for the process-owned WMS sync lifecycle.  Keep the legacy
    // fields above for compatibility with existing task-center snapshots; the
    // lifecycle reads this single DTO instead of inferring state from a page.
    wmsSyncState: {
      schemaVersion: 1,
      source: '',
      status: 'unconfigured',
      lastAttemptAt: null,
      lastSuccessAt: null,
      stale: false,
      retry: 0,
      nextRetryAt: null,
      safeError: '',
      attempt: 0,
      counts: { skuTotal: 0, spuTotal: 0, invalidSpuRows: 0 },
      snapshotHash: '',
      updatedAt: null
    },
    // API-SPU tasks are derived from the current inventory cache. Only
    // operator corrections/queue state live here so replacing an Excel file
    // cannot erase the API task identity or its crawl history.
    apiTaskOverrides: {},
    // Listing prices are a separate, write-verified projection.  They are
    // intentionally not merged into sale_price/suggest_price, which come from
    // the inventory API snapshot and have different business meanings.
    apiListingPrices: {},
    priceApplyAudits: {},
    // Durable API identity ledger. Current fields live in wmsSkus; this ledger
    // keeps first/last-seen identity and departure tombstones across refreshes,
    // Excel replacement, app restart, and API reappearance.
    apiSpuLedger: {},
    // Per-SPU policy is deliberately independent from import collections and
    // API field overrides, so replacing an Excel sheet cannot erase it.
    spuSearchPolicies: {}
  }
}
// 仅供隔离回归测试使用；生产运行仍由 Electron userData 决定存储位置。
if (process.env.XIAN_YU_TASK_STORE_DIR) storeOptions.cwd = process.env.XIAN_YU_TASK_STORE_DIR
const meta = new Store(storeOptions)
// 任务中心写盘也可能撞上 Windows 文件锁；同样重试，并把错误翻成人话。
makeResilientStore(meta, '保存任务配置')

const RUN_CAP = 100
const RESULT_CAP = 20000
const AI_PIPELINE_SCHEMA_VERSION = 1
const AI_EVENT_CAP = 500
const snapshotDir = join(dirname(meta.path), 'task-snapshots')
// 历史任务中心数据可能来自旧版应用目录。只把明确的旧应用名列入
// 兼容白名单，不能因为历史记录里带了任意绝对路径就放开本地文件读取。
const LEGACY_SNAPSHOT_STORE_NAMES = Object.freeze([
  'xianyu-electron',
  'xianyu-seller-pilot',
  '闲鱼行情爬虫',
  '闲鱼行情工作台'
])

function trustedSnapshotDirs() {
  const appDataDir = dirname(snapshotDir)
  // Electron's userData directory is normally a named child of the shared
  // Application Support directory. Test stores use the directory itself as
  // the root, so keep both layouts explicit instead of accepting arbitrary
  // absolute paths from persisted history.
  const legacyRoots = [appDataDir, dirname(appDataDir)]
  return [
    snapshotDir,
    ...legacyRoots.flatMap((root) => LEGACY_SNAPSHOT_STORE_NAMES.map((name) => join(root, name, 'task-snapshots')))
  ].map((directory) => resolve(directory))
}

function normalizeSnapshotFilePath(filePath) {
  const value = text(filePath).trim()
  if (value.startsWith('file://')) {
    try { return resolve(fileURLToPath(value)) } catch { return resolve(value) }
  }
  return resolve(value)
}

function resolveReadableSnapshot(filePath) {
  const target = normalizeSnapshotFilePath(filePath)
  const root = trustedSnapshotDirs().find((directory) => target.startsWith(`${directory}${sep}`))
  if (!root || !existsSync(target)) throw new Error('快照不存在或路径无效')
  let realTarget
  let realRoot
  try {
    realTarget = realpathSync(target)
    realRoot = realpathSync(root)
  } catch {
    throw new Error('快照不存在或路径无效')
  }
  if (!realTarget.startsWith(`${realRoot}${sep}`)) throw new Error('快照不存在或路径无效')
  return { target: realTarget, root: realRoot, legacy: root !== resolve(snapshotDir) }
}

// 任务 Excel 的唯一字段契约。sample 文件、GUI 预览和导入提示都引用这份
// 定义，避免其他智能体/脚本各自猜列名，导致同一批任务被塞成不同格式。
export const TASK_TEMPLATE_FILE = '巡航台任务清单_sample.xlsx'
export const TASK_TEMPLATE_SHEET = '行情任务'
export const TASK_TEMPLATE_VERSION = 2
export const TASK_ALIAS_COLUMN = '别称（可能由SPU读取内容生成）'
export const TASK_TEMPLATE_COLUMNS = Object.freeze([
  '品牌', '名称（兼容型号）', TASK_ALIAS_COLUMN, 'SPU编号', '采购价'
])
export const TASK_TEMPLATE_REQUIRED_COLUMNS = Object.freeze(['品牌', '名称（兼容型号）'])
export const TASK_TEMPLATE_RECOMMENDED_COLUMNS = Object.freeze([TASK_ALIAS_COLUMN, 'SPU编号'])
// accepted/manual alias 仍保持单槽位兼容合同；显式 Excel 搜索字段的
// searchKeywords 另行保留最多 12 个清洗值，不受此兼容槽位限制。
export const MAX_CONFIGURED_TASK_ALIASES = 1
export const TASK_TEMPLATE_PREVIEW_REQUIRED_COLUMNS = Object.freeze(['采购价'])
export const TASK_TEMPLATE_COLUMN_DESCRIPTIONS = Object.freeze({
  品牌: '必填；标准品牌名。',
  '名称（兼容型号）': '必填；商品名称或型号，作为第一条搜索词。旧表的“型号”“名称/型号”“型号名称”也兼容。',
  [TASK_ALIAS_COLUMN]: '选填；仅作为人工搜索词，不参与 API-SPU 关联；每条任务最多增加一次别称搜索。',
  SPU编号: '必填推荐；作为与库存 API 做唯一精确关联的主键。旧表的“SPU”“SPU编码”也兼容。',
  采购价: '预览必需；用于低于采购价拦截和 120%/150%/200% 预览分档。'
})

// 派生名字不是新的 Excel 列，也不是 WMS 的 canonical 型号。它只把已经
// 明确确认过的“用户常用型号 ↔ 内部型号”关系补成额外搜索词；主型号、SPU
// 和采购价仍以任务清单为准。新增关系必须是精确映射，不能用模糊匹配或猜测。
export const DERIVED_NAME_STRATEGY_VERSION = 1
export const DERIVED_NAME_RULES = Object.freeze([
  Object.freeze({ brand: '云鲸', model: 'J5', derivedNames: Object.freeze(['YJCC 020', 'YJCC020']) }),
  Object.freeze({ brand: '小米', model: '空气净化器5', derivedNames: Object.freeze(['ACM25SC']) }),
  Object.freeze({ brand: 'HKC', model: 'G25H4', derivedNames: Object.freeze(['Mg25h11Q']) }),
  Object.freeze({
    brand: 'Apple',
    brandAliases: Object.freeze(['苹果']),
    product: 'Apple TV',
    generation: '七代',
    variant: '64G',
    variantAliases: Object.freeze(['64G版本', '64G版']),
    derivedNames: Object.freeze(['A2737'])
  }),
  Object.freeze({
    brand: 'Apple',
    brandAliases: Object.freeze(['苹果']),
    product: 'Apple TV',
    generation: '七代',
    variant: '128G带以太网',
    variantAliases: Object.freeze(['128带以太网', '128G带以太网版本', '128带以太网版本', '128带以太网的版本']),
    derivedNames: Object.freeze(['A2843'])
  })
])

const TASK_TEMPLATE_METADATA = Object.freeze({
  templateFileName: TASK_TEMPLATE_FILE,
  templateSheetName: TASK_TEMPLATE_SHEET,
  templateVersion: TASK_TEMPLATE_VERSION,
  templateColumns: TASK_TEMPLATE_COLUMNS,
  templateRequiredColumns: TASK_TEMPLATE_REQUIRED_COLUMNS,
  templateRecommendedColumns: TASK_TEMPLATE_RECOMMENDED_COLUMNS,
  templatePreviewRequiredColumns: TASK_TEMPLATE_PREVIEW_REQUIRED_COLUMNS,
  templateColumnDescriptions: TASK_TEMPLATE_COLUMN_DESCRIPTIONS,
  templateNotes: Object.freeze([
    '只在“行情任务”工作表录入任务；第一行必须是标准表头。',
    '标准新模板只保留 5 列；品牌、名称（兼容型号）用于识别，别称只有一个，SPU编号用于精确匹配。',
    '人工别称只影响搜索词；API 商品名仅作为权威展示证据，不自动改写任务搜索词或 SPU。不要把采集结果列粘回任务表。',
    '分类是可选兼容列；新建含多个品类的清单建议保留“分类/品类”列，策略只按品类，不按品牌。'
  ])
})

function taskTemplateMetadataDto() {
  return {
    ...TASK_TEMPLATE_METADATA,
    templateColumns: [...TASK_TEMPLATE_COLUMNS],
    templateRequiredColumns: [...TASK_TEMPLATE_REQUIRED_COLUMNS],
    templateRecommendedColumns: [...TASK_TEMPLATE_RECOMMENDED_COLUMNS],
    templatePreviewRequiredColumns: [...TASK_TEMPLATE_PREVIEW_REQUIRED_COLUMNS],
    templateColumnDescriptions: { ...TASK_TEMPLATE_COLUMN_DESCRIPTIONS },
    templateNotes: [...TASK_TEMPLATE_METADATA.templateNotes]
  }
}

export function getTaskTemplateSchema() {
  return taskTemplateMetadataDto()
}

// `electron-store#get()` synchronously deserializes the complete JSON file.
// Task Center used to call it once per row through `decorateTask`, turning a
// large result history into an O(rows * file-size) startup stall. Keep one
// immutable-in-practice snapshot for the current invalidation epoch instead;
// all authoritative writes below invalidate it before the next IPC request.
let taskCenterSnapshot = null
let taskCenterEpoch = 0

export function invalidateTaskCenterSnapshot() {
  taskCenterEpoch += 1
  taskCenterSnapshot = null
  return taskCenterEpoch
}

function buildTaskCenterSnapshot() {
  const store = meta.store
  const collections = Array.isArray(store.collections) ? store.collections : []
  const activeCollectionId = store.activeCollectionId || null
  const active = collections.find((collection) => collection.id === activeCollectionId) || null
  const runResults = Array.isArray(store.runResults) ? store.runResults : []
  const latestResults = new Map()
  for (const row of runResults) {
    if (row?.taskId && !latestResults.has(row.taskId)) latestResults.set(row.taskId, row)
  }
  const wmsSkus = Array.isArray(store.wmsSkus) ? store.wmsSkus : []
  const apiTaskOverrides = store.apiTaskOverrides && typeof store.apiTaskOverrides === 'object' && !Array.isArray(store.apiTaskOverrides)
    ? store.apiTaskOverrides
    : {}
  const apiSpuLedger = store.apiSpuLedger && typeof store.apiSpuLedger === 'object' && !Array.isArray(store.apiSpuLedger)
    ? store.apiSpuLedger
    : {}
  const spuSearchPolicies = store.spuSearchPolicies && typeof store.spuSearchPolicies === 'object' && !Array.isArray(store.spuSearchPolicies)
    ? store.spuSearchPolicies
    : {}
  return Object.freeze({
    epoch: taskCenterEpoch,
    activeCollectionId,
    activeCollection: active,
    collections,
    tasks: Array.isArray(active?.tasks) ? active.tasks : [],
    runs: Array.isArray(store.runs) ? store.runs : [],
    runResults,
    latestResults,
    wmsSkus,
    wmsSpuCatalog: buildSpuCatalog(wmsSkus),
    wmsSyncedAt: store.wmsSyncedAt || null,
    wmsSyncState: store.wmsSyncState && typeof store.wmsSyncState === 'object'
      ? { ...store.wmsSyncState, counts: { ...(store.wmsSyncState.counts || {}) } }
      : null,
    apiTaskOverrides,
    apiListingPrices: store.apiListingPrices && typeof store.apiListingPrices === 'object' && !Array.isArray(store.apiListingPrices)
      ? store.apiListingPrices
      : {},
    priceApplyAudits: store.priceApplyAudits && typeof store.priceApplyAudits === 'object' && !Array.isArray(store.priceApplyAudits)
      ? store.priceApplyAudits
      : {},
    apiSpuLedger,
    spuSearchPolicies,
    settings: { ...(store.settings || {}) }
  })
}

export function getTaskCenterSnapshot() {
  if (!taskCenterSnapshot || taskCenterSnapshot.epoch !== taskCenterEpoch) {
    taskCenterSnapshot = buildTaskCenterSnapshot()
  }
  return taskCenterSnapshot
}

// The API-SPU source is a process-level gate, not an inference from whether
// an Excel collection happens to exist.  A failed/unconfigured connection may
// still expose a last-good snapshot (including a valid empty snapshot), but
// without a success timestamp there is no authoritative warehouse source and
// no Excel row is allowed to become executable inventory work.
function unifiedApiSourceState(snapshot = getTaskCenterSnapshot()) {
  const raw = snapshot.wmsSyncState && typeof snapshot.wmsSyncState === 'object'
    ? snapshot.wmsSyncState
    : {}
  const status = text(raw.status) || (text(snapshot.wmsSyncedAt) ? 'synced' : 'unconfigured')
  const lastGoodAt = text(snapshot.wmsSyncedAt || raw.lastSuccessAt)
  const hasLastGoodSnapshot = Boolean(lastGoodAt)
  const ready = hasLastGoodSnapshot
  let reason = ''
  if (!ready) {
    if (status === 'failed') reason = text(raw.safeError) || '库存 API 同步失败，尚无可用的最近成功快照'
    else if (status === 'syncing') reason = '库存 API 正在首次同步，尚无可用的最近成功快照'
    else if (status === 'unconfigured') reason = '库存 API 尚未配置或尚未成功同步'
    else reason = '库存 API 尚无可用的最近成功快照'
  }
  return {
    source: ready ? 'api_spu' : 'no_source',
    status,
    ready,
    hasLastGoodSnapshot,
    lastGoodAt: lastGoodAt || null,
    reason: reason || null,
    safeError: text(raw.safeError) || null,
    retry: Number(raw.retry) || 0,
    nextRetryAt: raw.nextRetryAt || null
  }
}

/** Public, sanitized source gate used by queue/projection callers and tests. */
export function getUnifiedApiSourceState({ snapshot: requestedSnapshot = null } = {}) {
  return unifiedApiSourceState(requestedSnapshot || getTaskCenterSnapshot())
}

function blockedUnifiedTask(task = {}, sourceState = {}, sourceOrigin = 'excel_extension') {
  const reason = sourceState.reason || '库存 API 尚无可用的最近成功快照'
  return {
    ...task,
    // Keep the original origin for audit, but never expose this row as an
    // executable Excel/API task while the authoritative source is unavailable.
    source: 'no_source',
    sourceOrigin,
    sourceLabel: '等待库存 API 同步',
    sourceStatus: 'blocked',
    apiSpuSource: 'blocked',
    apiSyncStatus: sourceState.status,
    apiSyncLastGoodAt: sourceState.lastGoodAt,
    apiSyncReason: reason,
    blocked: true,
    executable: false,
    enabled: false,
    status: 'blocked',
    lastStatus: 'blocked',
    lastReason: reason,
    reason,
    queueKind: 'blocked',
    displayGroup: 'failed'
  }
}

function buildTaskMap(snapshot = getTaskCenterSnapshot()) {
  const taskMap = new Map()
  // Results can outlive the active import. Search newest collections first so
  // a historical row can still inherit the purchase price from the task list
  // that produced it, while retaining a valid historical price when the
  // newest duplicate has an empty purchase-price cell.
  for (const collection of snapshot.collections || []) {
    for (const task of collection.tasks || []) {
      if (!task?.id) continue
      const previous = taskMap.get(task.id)
      const previousHasReference = previous?.referencePrice !== null && previous?.referencePrice !== undefined && previous?.referencePrice !== ''
      const currentHasReference = task.referencePrice !== null && task.referencePrice !== undefined && task.referencePrice !== ''
      // Keep the newest task as the default, but do not let a newer row with
      // an empty purchase-price cell hide a usable value from an older import.
      if (!previous || (!previousHasReference && currentHasReference)) taskMap.set(task.id, task)
    }
  }
  return taskMap
}

function priceComparisonFor(result, task = null) {
  return classifyPriceAgainstPurchase({
    marketPrice: result?.price,
    purchasePrice: result?.referencePrice ?? task?.referencePrice,
    purchasePriceStatus: result?.referencePriceStatus || task?.referencePriceStatus,
    purchasePriceReason: result?.referencePriceReason || task?.referencePriceReason
  })
}

// 进程启动时就完成一次旧配置迁移，避免用户点击开始后才发现仍在使用旧的高频节奏。
const storedSettings = meta.get('settings') || {}
if (Number(storedSettings.rateSafetyVersion) < 2 || Number(storedSettings.throttleMinMs) < 8000 || Number(storedSettings.throttleMaxMs) < 8000 || Number(storedSettings.queryDelayMinMs) < 5000) {
  meta.set('settings', {
    ...storedSettings,
    throttleMinMs: 12000,
    throttleMaxMs: 20000,
    queryDelayMinMs: 8000,
    queryDelayMaxMs: 14000,
    rateSafetyVersion: 2
  })
  invalidateTaskCenterSnapshot()
}

// 桌面端被强制退出或电脑重启时，内存里的调度器没有机会 finishRun；
// 下次启动把这些“运行中”记录收口，避免历史榜单长期显示假运行状态。
const staleRuns = (meta.get('runs') || []).filter((run) => run.status === 'running')
if (staleRuns.length) {
  const finishedAt = new Date().toISOString()
  meta.set('runs', (meta.get('runs') || []).map((run) => run.status === 'running'
    ? { ...run, status: 'stopped', stopped: true, reason: '应用上次退出时任务未完成，已自动收口', finishedAt }
    : run))
  invalidateTaskCenterSnapshot()
}

// 没有导入文件时也给用户一个可理解的 sample；正式导入后会自动替换为真实预览。
const BUILTIN_SAMPLE = {
  sourceFile: TASK_TEMPLATE_FILE,
  sheetName: TASK_TEMPLATE_SHEET,
  rowCount: 3,
  rows: [
    {
      brand: '飞利浦', model: '27M2N55', alias1: '', alias2: '', effectiveAlias: '', aliasSource: '', spuCode: '90001', referencePrice: 1200,
      apiSkuCode: 'UK02438064399', apiSpuCode: '90001',
      apiSpuProductName: 'SPU：PHILIPS EVNIA T #27M2N5500P PHILIPS飞利浦 1台',
      apiSpuCleanedAlias: null, apiSpuAlias: null, apiSpuAliasUsed: false, apiSpuAliasReason: '仅展示 API 原文，不参与任务 SPU 关联或搜索',
      searchKeywords: ['27M2N55'], searchFieldLabels: ['整词搜索 · 默认/其它']
    },
    { brand: 'KTC', model: '27GS820', alias1: '', alias2: '', effectiveAlias: '', aliasSource: '', spuCode: '90002', referencePrice: 500, searchKeywords: ['27GS820'], searchFieldLabels: ['整词搜索 · 默认/其它'] },
    { brand: '小米', model: '空气净化器4PRO', alias1: '米家空气净化器4PRO', alias2: '', effectiveAlias: '米家空气净化器4PRO', aliasSource: 'manual', spuCode: '90003', referencePrice: 1299, searchKeywords: ['小米空气净化器4PRO', '米家空气净化器4PRO'], searchFieldLabels: ['整词搜索 · 空气净化器', '别称（人工填写）'] }
  ]
}

let builtinTemplateSample = null

function text(value) {
  return String(value ?? '').trim()
}

function headerKey(value) {
  return text(value).toLowerCase().replace(/[\s_\-（）()]/g, '')
}

function findColumn(headers, aliases) {
  const wanted = aliases.map(headerKey)
  return headers.findIndex((value) => wanted.includes(headerKey(value)))
}

// Excel 来源不一定统一使用“型号2”，清洗工作簿常见的是“清洗型号2/3”。
// 统一按语义识别，避免新增一列就必须改代码或把字段静默丢掉。
function isPrimaryModelHeader(value) {
  const key = headerKey(value)
  return ['型号', '清洗型号', 'model', '型号名称', '名称', '名称/型号', '型号/名称', '名称兼容型号'].includes(key)
    || /^(?:清洗)?型号(?:[a-z]|\d+|[一二三四五六七八九十])$/i.test(key)
}

function cleanSearchKeywords(value) {
  const source = Array.isArray(value) ? value : [value]
  const seen = new Set()
  return source
    .flatMap((item) => text(item).split(/[\r\n,，、;；|]+|\s+\/\s+/))
    .map((item) => text(item).slice(0, 120))
    .filter((item) => {
      const key = item.toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 12)
}

function currentCategorySearchModes() {
  return normalizeCategorySearchModes(meta.get('settings')?.categorySearchModes)
}

/**
 * WMS API 的 SPU 商品名是展示描述，不可原样当搜索词。优先读取 # 后的型号，
 * 否则只接受同时含字母和数字的代码型 token；品牌、品类、数量和无型号的纯中文
 * 描述全部丢弃。这样 `PHILIPS EVNIA T #27M2N5500P PHILIPS飞利浦 1台` 只会得到
 * `27M2N5500P`，不会把“1台”或品牌描述送进闲鱼搜索。
 */
export function cleanApiSpuAlias(value, { model = '' } = {}) {
  const source = text(value)
    .replace(/^SPU\s*[:：]?\s*/i, '')
    .replace(/\b\d+\s*(?:台|件|个|套)\b/gu, ' ')
    .trim()
  if (!source) return ''
  const marked = source.match(/#\s*([A-Za-z0-9][A-Za-z0-9._/-]*)/)
  if (marked?.[1]) return marked[1].trim()
  const modelKey = compactDerivedPart(model)
  const candidates = source.match(/[A-Za-z0-9][A-Za-z0-9._/-]*/g) || []
  const usable = candidates.filter((candidate) => /[A-Za-z]/.test(candidate) && /\d/.test(candidate))
  if (!usable.length) return ''
  const exact = modelKey && usable.find((candidate) => compactDerivedPart(candidate) === modelKey)
  if (exact) return exact.trim()
  return [...usable].sort((left, right) => right.length - left.length)[0].trim()
}

function hasEquivalentSearchKeyword(candidate, keywords = []) {
  const candidateText = text(candidate)
  const candidateKey = compactDerivedPart(candidateText)
  if (!candidateText) return false
  return (Array.isArray(keywords) ? keywords : []).some((keyword) => {
    const keywordText = text(keyword)
    return keywordText.toLowerCase() === candidateText.toLowerCase()
      || (candidateKey && compactDerivedPart(keywordText) === candidateKey)
  })
}

const ALIAS_NOISE_WORDS = Object.freeze([
  '液晶显示器', '电竞显示器', '电脑显示器', '显示器', '净化器', '空气净化器',
  '扫地机器人', '扫拖机器人', '机器人', '音响', '耳机', '电视盒', '商品', '型号'
])

function semanticAliasKey(value, { brand = '' } = {}) {
  let normalized = text(value).toUpperCase()
  for (const noise of [brand, ...ALIAS_NOISE_WORDS]) {
    const key = text(noise).toUpperCase()
    if (key) normalized = normalized.split(key).join(' ')
  }
  normalized = normalized.replace(/\b\d+\s*(?:台|件|个|套)\b/gu, ' ')
  return normalized.replace(/[^\p{L}\p{N}]+/gu, '')
}

function aliasesEquivalent(candidate, references = [], context = {}) {
  const candidateKey = semanticAliasKey(candidate, context)
  if (!candidateKey) return true
  return (Array.isArray(references) ? references : []).some((reference) => semanticAliasKey(reference, context) === candidateKey)
}

function firstEffectiveManualAlias(candidates = [], references = [], context = {}) {
  return effectiveManualAliases(candidates, references, context)[0] || ''
}

function effectiveManualAliases(candidates = [], references = [], context = {}) {
  const seen = new Set()
  return cleanAliasCandidates(candidates).filter((candidate) => {
    if (aliasesEquivalent(candidate, references, context)) return false
    const key = text(candidate).toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_CONFIGURED_TASK_ALIASES)
}

function cleanAliasCandidates(value) {
  const source = Array.isArray(value) ? value : []
  const seen = new Set()
  return source
    .map((item) => text(item).slice(0, 80))
    .filter((item) => {
      const key = item.toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 12)
}

function cleanConfiguredTaskAliases(value) {
  return cleanAliasCandidates(value).slice(0, MAX_CONFIGURED_TASK_ALIASES)
}

function isAliasSearchHeader(value) {
  const key = headerKey(value)
  return /(?:别称|别名|别字|alias)/i.test(key)
}

function isSearchHeader(value) {
  const key = headerKey(value)
  if (!key) return false
  const exact = new Set([
    '型号', '清洗型号', 'model', '型号名称', '名称', '名称/型号', '型号/名称', '名称兼容型号',
    '关键词', '清洗关键词', 'keyword', '搜索词', '清洗搜索词', '搜索关键词',
    '别名', '清洗别名', 'alias', '型号别名', '别称', '清洗别称', '产品代码', '型号代码', '同款型号', '副型号',
    '商品代码', '产品型号', '商品型号'
  ])
  if (exact.has(key)) return true
  return /^(?:清洗)?(?:型号|关键词|keyword|搜索词|搜索关键词|别称|别名|alias|型号别名|产品代码|型号代码|同款型号|副型号|商品代码|产品型号|商品型号)(?:[a-z]|\d+|[一二三四五六七八九十])$/i.test(key)
}

// 新版巡航台模板只把“名称（兼容型号）+ 唯一别称”作为搜索来源。
// 旧清洗表仍保留动态型号/关键词列兼容，但标准表不再自动追加代码映射或其它隐式别名。
function isStandardAliasTemplate(headers = []) {
  const keys = new Set(headers.map(headerKey))
  return keys.has('品牌')
    && keys.has('名称兼容型号')
    && (keys.has(headerKey(TASK_ALIAS_COLUMN)) || keys.has('别称1') || keys.has('别名1'))
}

function inferredPrimarySearch({ brand, model, category, rawKeyword, name }) {
  if (rawKeyword) return rawKeyword
  if (category === '空气净化器' && brand && model) return displayNameFor({ brand, model, category })
  if (['扫地机器人', '扫拖机器人'].includes(category) && brand && model) return `${brand} ${model}`
  return model || name
}

// Historical task files sometimes stored an air-purifier generation as only
// "5"/"4PRO".  That is ambiguous in the seller console: "小米 5" can be
// mistaken for a phone.  Keep the model field explicit and derive the display
// name/search keyword from one deterministic rule everywhere.
export function normalizeTaskIdentity({ brand = '', model = '', category = '', spuCode = '', spu_code = '' } = {}) {
  let nextBrand = text(brand)
  let nextModel = text(model)
  const nextSpuCode = text(spuCode || spu_code)
  const nextCategory = text(category)
  if (nextCategory === '空气净化器') {
    if (/^(小米净化器|小空)$/i.test(nextBrand)) nextBrand = '小米'
    if (nextBrand === '小米' && nextModel && !/^空气净化器/i.test(nextModel)) {
      const purifierModel = nextModel.replace(/\s+/g, '')
      if (/^(?:\d+|\d+[A-Z]+|\d+[A-Z]+\d+|4\s?LITE|4\s?PRO|4\s?PRO\d+|5S?)$/i.test(purifierModel)) {
        nextModel = `空气净化器${purifierModel.toUpperCase()}`
      }
    }
  }
  return { brand: nextBrand, model: nextModel, category: nextCategory, spuCode: nextSpuCode }
}

// 派生映射只允许“品牌 + 完整型号”或“品牌 + 产品/代际 + 规格变体”的精确命中。
// 这里仅去掉大小写、空格和常见分隔符，不能把一段任意商品名做 contains
// 推断；这样 Apple TV 七代 64G 与七代 128G 带以太网不会串用型号。
function compactDerivedPart(value) {
  return text(value).toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function derivedRuleBrandKeys(rule) {
  return [rule.brand, ...(Array.isArray(rule.brandAliases) ? rule.brandAliases : [])]
    .map(compactDerivedPart)
    .filter(Boolean)
}

function derivedTaskCandidates({ brand = '', model = '', category = '', size = '', spec = '', name = '', variant = '' } = {}) {
  const direct = [model, name]
    .map(compactDerivedPart)
    .filter(Boolean)
  const variants = [variant, spec, size]
    .map(compactDerivedPart)
    .filter(Boolean)
  const categoryKey = compactDerivedPart(category)
  const modelKey = compactDerivedPart(model)
  // category/spec/size 是独立字段时，把它们拼成一个搜索候选；每个字段仍须
  // 与规则的完整产品、代际和变体完全相等。
  if (categoryKey && modelKey) direct.push(`${categoryKey}${modelKey}`)
  if (modelKey && variants.length) {
    for (const value of variants) {
      direct.push(`${modelKey}${value}`)
      if (categoryKey) direct.push(`${categoryKey}${modelKey}${value}`)
    }
  }
  return {
    brandKey: compactDerivedPart(brand),
    direct: new Set(direct),
    variants: new Set(variants)
  }
}

function matchesDerivedRule(rule, input = {}) {
  const candidates = derivedTaskCandidates(input)
  if (!candidates.brandKey || !derivedRuleBrandKeys(rule).includes(candidates.brandKey)) return false
  if (rule.model) return candidates.direct.has(compactDerivedPart(rule.model))
  if (!rule.product || !rule.generation || !rule.variant) return false
  const productGeneration = compactDerivedPart(`${rule.product}${rule.generation}`)
  const variants = [rule.variant, ...(Array.isArray(rule.variantAliases) ? rule.variantAliases : [])]
    .map(compactDerivedPart)
    .filter(Boolean)
  const fullModels = variants.map((value) => `${productGeneration}${value}`)
  // Full model/name supplied in one cell, e.g. “Apple TV 七代64G”.
  if (fullModels.some((value) => candidates.direct.has(value))) return true
  // Or product + generation in model/name with the variant in variant/spec/size.
  if (candidates.direct.has(productGeneration) && variants.some((value) => candidates.variants.has(value))) return true
  // A six-column task can use “TV 七代” as the name while brand is “Apple”.
  // The category is accepted as the product only when the concatenated text is
  // still exactly the configured product + generation + variant.
  return false
}

/**
 * Return only the configured, exact derived names for a task.
 *
 * These values are evidence-only compatibility mappings. They are retained for
 * audit/history and must never be appended to the task's search keywords.
 * Callers must keep `spuCode` unchanged; API association never uses the model
 * or any derived name as a fallback key.
 */
export function derivedNamesForTask(input = {}) {
  const names = DERIVED_NAME_RULES
    .filter((rule) => matchesDerivedRule(rule, input))
    .flatMap((rule) => rule.derivedNames || [])
  return cleanSearchKeywords(names)
}

export function displayNameFor({ brand = '', model = '', category = '' } = {}) {
  const identity = normalizeTaskIdentity({ brand, model, category })
  if (identity.category === '空气净化器' && identity.brand && identity.model) {
    return `${identity.brand}${identity.model}`
  }
  return [identity.brand, identity.model].filter(Boolean).join(' ')
}

function truthy(value) {
  const valueText = text(value).toLowerCase()
  return !['否', '停用', '禁用', 'false', '0', 'no'].includes(valueText)
}

function normalizeBlacklist(value) {
  const source = Array.isArray(value) ? value : text(value).split(/[\r\n,，]+/)
  const seen = new Set()
  return source
    .map((item) => text(item).slice(0, 80))
    .filter((item) => {
      const key = item.toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 100)
}

function normalizedPolicyRecord(value = {}, { source = 'manual', updatedAt = null, changedBy = null } = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const policy = normalizeSpuSearchPolicy(raw.policy || raw)
  const audit = normalizeSpuSearchPolicyAudit({
    source: raw.source ?? raw.audit?.source ?? source,
    updatedAt: raw.updatedAt ?? raw.audit?.updatedAt ?? updatedAt,
    changedBy: raw.changedBy ?? raw.audit?.changedBy ?? changedBy
  })
  return {
    ...policy,
    source: audit.source,
    updatedAt: audit.updatedAt,
    changedBy: audit.changedBy,
    audit
  }
}

function policyCandidate(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return raw.spuSearchPolicy || raw.searchPolicy || raw.policy || null
}

/**
 * Canonicalize the durable policy ledger once at startup. Only explicit,
 * already-persisted policy objects are migrated; brand/model/name are never
 * used as a fallback key. This also absorbs a short-lived pre-schema nesting
 * used by early local builds without copying arbitrary override fields.
 */
export function migrateSpuSearchPolicies() {
  const current = meta.get('spuSearchPolicies')
  const existing = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  const next = {}
  let migrated = 0
  let changed = !(current && typeof current === 'object' && !Array.isArray(current))
  const put = (spuCode, candidate, audit = {}) => {
    const key = canonicalSpu(spuCode)
    if (!key || !candidate || typeof candidate !== 'object' || Array.isArray(candidate) || next[key]) return
    next[key] = normalizedPolicyRecord(candidate, audit)
    if (key !== spuCode || JSON.stringify(next[key]) !== JSON.stringify(candidate)) changed = true
    migrated++
  }
  for (const [key, value] of Object.entries(existing)) put(key, value)
  // Compatibility sources are only read when a canonical policy does not
  // already exist. API/Excel identity remains immutable and exact.
  for (const [spuCode, override] of Object.entries(meta.get('apiTaskOverrides') || {})) {
    put(spuCode, policyCandidate(override), { source: 'legacy-api-override', updatedAt: override?.updatedAt })
  }
  for (const collection of meta.get('collections') || []) {
    for (const task of collection?.tasks || []) {
      put(task?.spuCode || task?.spu_code, policyCandidate(task), { source: 'legacy-excel-task', updatedAt: task?.updatedAt })
    }
  }
  if (changed) {
    meta.set('spuSearchPolicies', next)
    invalidateTaskCenterSnapshot()
  }
  return { ok: true, migrated, changed, policies: Object.keys(next).length }
}

function policyForTask(task = {}, snapshot = getTaskCenterSnapshot()) {
  const key = canonicalSpu(task.spuCode || task.spu_code)
  const stored = key ? snapshot.spuSearchPolicies?.[key] : null
  return stored ? normalizedPolicyRecord(stored) : null
}

/** Return a DTO-safe policy record keyed only by canonical SPU identity. */
export function getSpuSearchPolicy(spuCode) {
  const key = canonicalSpu(spuCode)
  if (!key) return null
  const stored = getTaskCenterSnapshot().spuSearchPolicies?.[key]
  return stored ? { canonicalSpu: key, ...normalizedPolicyRecord(stored) } : null
}

export function getSpuSearchPolicies() {
  const policies = getTaskCenterSnapshot().spuSearchPolicies || {}
  return Object.entries(policies).map(([spuCode, value]) => ({
    canonicalSpu: canonicalSpu(spuCode),
    ...normalizedPolicyRecord(value)
  })).filter((item) => item.canonicalSpu)
}

/**
 * Save one policy without touching API/WMS master fields or Excel rows. The
 * caller may supply a display-only `changedBy`, but arbitrary metadata and
 * credential-shaped fields are stripped by normalizedPolicyRecord().
 */
export function setSpuSearchPolicy(spuCode, policy = {}, { source = 'manual', changedBy = null } = {}) {
  const key = canonicalSpu(spuCode)
  if (!key) return { ok: false, reason: 'SPU 编号不能为空' }
  const current = meta.get('spuSearchPolicies')
  const policies = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {}
  const now = new Date().toISOString()
  const record = normalizedPolicyRecord(policy, { source, updatedAt: now, changedBy })
  policies[key] = record
  meta.set('spuSearchPolicies', policies)
  invalidateTaskCenterSnapshot()
  return { ok: true, canonicalSpu: key, policy: { canonicalSpu: key, ...record } }
}

// Run before the first task projection. This is idempotent and only writes
// when legacy/untrusted durable data actually needs canonicalization.
migrateSpuSearchPolicies()

function taskId(row) {
  const configured = Array.isArray(row.searchKeywords) ? row.searchKeywords.join('\u0001') : row.searchKeywords
  return createHash('sha1')
    .update([row.brand, row.model, row.spuCode || row.spu_code, row.size, row.spec, row.keyword, configured].map(text).join('|'))
    .digest('hex')
    .slice(0, 20)
}

function normalizeRow(row, headers, sourceRow) {
  const valueAt = (aliases) => {
    const index = findColumn(headers, aliases)
    return index >= 0 ? row[index] : ''
  }
  const originalBrand = text(valueAt(['品牌', '清洗品牌', 'brand', '厂商']))
  const modelIndex = headers.findIndex((header) => isPrimaryModelHeader(header))
  const originalModel = text(modelIndex >= 0 ? row[modelIndex] : valueAt(['名称（兼容型号）', '型号', '型号/名称', '名称/型号', '名称', '清洗型号', 'model', '型号名称']))
  const correctedBrand = text(valueAt(['员工更正品牌', '更正品牌', '校正品牌']))
  const correctedModel = text(valueAt(['员工更正型号', '更正型号', '校正型号']))
  const spuCode = text(valueAt(['SPU编号', 'SPU', 'spu_code', 'SPU编码', 'SPU码', '商品SPU', 'SPU Code']))
  const category = text(valueAt(['分类', '类别', '清洗类型', 'category', '品类'])) || '默认/其它'
  const normalizedIdentity = normalizeTaskIdentity({
    brand: correctedBrand || originalBrand,
    model: correctedModel || originalModel,
    spuCode,
    category
  })
  const brand = normalizedIdentity.brand
  const model = normalizedIdentity.model
  if (!brand && !model) return null
  const size = text(valueAt(['尺寸', 'size', '屏幕尺寸']))
  const spec = text(valueAt(['规格', 'spec', 'specification', '参数']))
  const alias = text(valueAt([TASK_ALIAS_COLUMN]))
  const alias1 = text(valueAt(['别称1', '别名1', '清洗别称1', '清洗别名1', '别称', '别名', '型号别名']))
  const alias2 = text(valueAt(['别称2', '别名2', '清洗别称2', '清洗别名2']))
  const name = displayNameFor({ brand, model, category })
  const rawKeyword = text(valueAt(['关键词', 'keyword', '搜索词', '搜索关键词']))
  const keyword = rawKeyword || name
  const standardAliasTemplate = isStandardAliasTemplate(headers)
  const categorySearchModes = currentCategorySearchModes()
  const categorySearch = categorySearchProfile(category, categorySearchModes)
  const categoryBaseQueries = buildCategorySearchQueries({ brand, model, category }, categorySearchModes)
  const explicitSearchCandidates = headers
    // Only the selected canonical model column is the first explicit field;
    // every other recognised Excel search column remains an actual candidate.
    .map((header, index) => isSearchHeader(header) && index !== modelIndex ? row[index] : '')
    .flatMap((value) => cleanSearchKeywords(value))
  const hasExplicitSearchFields = !standardAliasTemplate && headers.some((header, index) => (
    index !== modelIndex
      && isSearchHeader(header)
      && !isAliasSearchHeader(header)
      && cleanSearchKeywords(row[index]).length > 0
  ))
  const derivedNames = derivedNamesForTask({ brand, model, category, size, spec, name })
  const manualAliases = effectiveManualAliases(
    [alias, alias1, alias2, ...explicitSearchCandidates.filter((candidate) => !hasEquivalentSearchKeyword(candidate, [model, ...categoryBaseQueries]))],
    [model, ...categoryBaseQueries],
    { brand, category }
  )
  // Explicit fields and an accepted manual alias are all real search fields.
  // Keep the alias in the canonical row-level array as well as in `aliases`
  // so task preview and the scheduler cannot disagree about query count.
  const explicitSearchKeywords = cleanSearchKeywords([originalModel, ...explicitSearchCandidates, ...manualAliases])
  const searchKeywords = hasExplicitSearchFields
    ? explicitSearchKeywords
    : cleanSearchKeywords([...categoryBaseQueries, ...manualAliases])
  const effectiveAlias = manualAliases[0] || ''
  const aliasSource = manualAliases.length ? 'manual' : ''
  const baseLabel = originalModel
    ? (categorySearch.mode === 'split' ? '名称（兼容型号）' : `整词搜索 · ${categorySearch.category}`)
    : ''
  const searchFieldLabels = searchKeywords.map((query, index) => {
    if (hasExplicitSearchFields) {
      if (index === 0) return '名称（兼容型号）'
      if (manualAliases.includes(query) && !explicitSearchCandidates.includes(query)) return '别称（人工填写）'
      return 'Excel 显式搜索字段'
    }
    if (categoryBaseQueries.includes(query)) return baseLabel
    return '别称（人工填写）'
  }).filter(Boolean)
  // 采购价优先于可能同时存在的历史行情价；避免把行情列误当成本下限。
  const purchasePriceIndex = findColumn(headers, ['采购价', '采购价格', '采购成本', '采购单价', '成本价', '进货价'])
  const fallbackPriceIndex = findColumn(headers, ['价格', '行情价', 'price'])
  const priceText = text(row[purchasePriceIndex >= 0 ? purchasePriceIndex : fallbackPriceIndex] || '')
  const parsedPrice = parseMoney(priceText, { label: '采购价' })
  const task = {
    id: taskId({ brand, model, spuCode, size, spec, keyword, searchKeywords }),
    name,
    brand,
    model,
    alias1,
    alias2,
    effectiveAlias,
    // 仅用于可解释的额外搜索；API canonical identity 只看 SPU。
    derivedNames,
    derivedModelCodes: derivedNames,
    spuCode,
    spu_code: spuCode,
    size,
    spec,
    keyword,
    searchKeywords,
    searchFieldLabels,
    searchAliasMode: standardAliasTemplate ? 'table' : 'legacy',
    searchDerivedNames: false,
    searchStrategyMode: categorySearch.mode,
    searchStrategyCategory: categorySearch.category,
    searchStrategyComposition: categorySearch.composition,
    category,
    enabled: truthy(valueAt(['启用', '状态', 'enabled'])),
    // 保留“缺失”和“有值但非法”的区别。旧实现把两者都写成 null，随后发布
    // 围栏会把错误采购价当成没有采购价而放行。
    referencePrice: parsedPrice.ok ? parsedPrice.value : null,
    referencePriceStatus: parsedPrice.present ? (parsedPrice.ok ? 'valid' : 'invalid') : 'missing',
    referencePriceReason: parsedPrice.present && !parsedPrice.ok ? parsedPrice.reason : '',
    aliases: manualAliases,
    aliasSource,
    searchKeywordSource: hasExplicitSearchFields ? 'explicit' : 'category',
    aliasUpdatedAt: null,
    aiNormalizationStatus: 'pending',
    aiNormalizationSource: '',
    aiNormalizationUpdatedAt: null,
    aiNormalizationReason: '',
    aiCorrectionStatus: 'not_needed',
    aiCorrectionAttempts: 0,
    aiCorrectionSource: '',
    aiCorrectionUpdatedAt: null,
    aiCorrectionReason: '',
    aiCorrectionCandidate: null,
    correctionWorkflowStatus: 'idle',
    correctionWorkflowReason: '',
    correctionWorkflowUpdatedAt: null,
    correctionRecollectKey: null,
    correctionRecollectRequestedAt: null,
    correctionVersion: null,
    correctionOperator: '',
    correctionReviewStatus: 'none',
    correctionAudit: [],
    writebackAudit: [],
    aiReviewStatus: 'none',
    aiReviewReason: '',
    aiReviewUpdatedAt: null,
    aiWebSearchStatus: 'not_requested',
    aiWebSearchQuery: '',
    aiWebSearchResults: [],
    aiWebSearchSource: '',
    aiWebSearchUpdatedAt: null,
    sourceRow
  }
  return task
}

function latestResultMap(snapshot = getTaskCenterSnapshot()) {
  return snapshot.latestResults
}

function decorateTask(task, snapshot = getTaskCenterSnapshot(), taskMap = null) {
  const latest = latestResultMap(snapshot).get(task.id)
  // Older persisted collections predate row-level searchKeywords. Derive a
  // single natural query at read time so they immediately follow the same
  // “how many fields, how many searches” rule without forcing a re-import.
  const storedSearchKeywords = cleanSearchKeywords(task.searchKeywords)
  const categorySearchModes = normalizeCategorySearchModes(snapshot.settings?.categorySearchModes)
  const categorySearch = categorySearchProfile(task.category, categorySearchModes)
  const identity = normalizeTaskIdentity(task)
  const categoryBaseQueries = buildCategorySearchQueries({ ...identity, category: task.category }, categorySearchModes)
  const configuredAliasCandidates = cleanAliasCandidates(task.aliases)
  const derivedNames = derivedNamesForTask({
    ...task,
    ...identity,
    name: task.name,
    size: task.size,
    spec: task.spec,
    variant: task.variant
  })
  const legacyStoredCandidates = !task.aliasOverride && !task.aliasSource && task.searchAliasMode === 'legacy'
    ? storedSearchKeywords.filter((candidate) => !aliasesEquivalent(candidate, derivedNames, { brand: task.brand, category: task.category }))
    : []
  const compatibleLegacyCandidates = task.aliasOverride
    ? []
    : [
        !['derived', 'spu'].includes(task.aliasSource) ? task.effectiveAlias : '',
        task.alias,
        task.alias1,
        task.alias2,
        ...legacyStoredCandidates
      ]
  const manualAliases = effectiveManualAliases([
    ...configuredAliasCandidates,
    ...compatibleLegacyCandidates
  ], [task.model, ...categoryBaseQueries], { brand: task.brand, category: task.category })
  const explicitStoredQueries = ['explicit', 'api'].includes(task.searchKeywordSource) ? storedSearchKeywords : []
  const baseSearchKeywords = explicitStoredQueries.length
    ? cleanSearchKeywords([...explicitStoredQueries, ...manualAliases])
    : cleanSearchKeywords([...categoryBaseQueries, ...manualAliases])
  const policyRecord = policyForTask(task, snapshot)
  const effectivePolicy = buildEffectiveSpuSearchPolicy(policyRecord || emptySpuSearchPolicy(), {
    // The existing row-level list is the compatibility baseline. In
    // particular, an old Excel row with explicit fields must not revert to a
    // generic category template just because no SPU policy has been saved.
    baseQueries: baseSearchKeywords,
    globalBlacklist: snapshot.settings?.blacklistKeywords
  })
  const searchKeywords = effectivePolicy.search.queries
  const effectiveAlias = manualAliases[0] || ''
  const searchFieldLabels = searchKeywords.map((query, index) => {
    const persistedAliasLabel = Array.isArray(task.searchFieldLabels)
      && task.searchFieldLabels[index] === '别称（人工填写）'
    const isManualAlias = manualAliases.includes(query)
      && (task.aliasOverride === true || persistedAliasLabel)
    if (isManualAlias) return '别称（人工填写）'
    if (task.searchKeywordSource === 'api' && explicitStoredQueries.length) return 'API 商品字段'
    if (explicitStoredQueries.length) return index === 0 ? '名称（兼容型号）' : 'Excel 显式搜索字段'
    if (categoryBaseQueries.includes(query)) return task.model
      ? (categorySearch.mode === 'split' ? '名称（兼容型号）' : `整词搜索 · ${categorySearch.category}`)
      : ''
    if (effectivePolicy.search.mode === 'explicit') return 'SPU 独立搜索词'
    if (effectivePolicy.localization.searchAliases.includes(query)) return 'SPU 搜索别名'
    return '别称（人工填写）'
  }).filter(Boolean)
  const normalizedTask = {
    ...task,
    ...identity,
    aliases: manualAliases,
    effectiveAlias,
    aliasSource: manualAliases.length ? 'manual' : '',
    name: displayNameFor(identity),
    derivedNames,
    derivedModelCodes: derivedNames,
    searchStrategyMode: categorySearch.mode,
    searchStrategyCategory: categorySearch.category,
    searchStrategyComposition: categorySearch.composition,
    keyword: identity.category === '空气净化器' && identity.brand && identity.model
      ? `${identity.brand}${identity.model}`
      : task.keyword
  }
  const withWms = decorateTaskWithWms({ ...normalizedTask, searchKeywords, searchFieldLabels }, snapshot.wmsSpuCatalog)
  // API 商品名称只属于 API 主数据展示，不再被解析成别称，也不改变搜索词。
  const apiSpuProductNameRaw = withWms.apiSpuAssociated ? text(withWms.apiProductName) : ''
  const withApiSpuAlias = {
    ...withWms,
    apiSpuProductName: apiSpuProductNameRaw || null,
    // API 商品名是权威展示证据，不自动派生搜索别称；人工别称仍由任务本身提供。
    apiSpuCleanedAlias: null,
    apiSpuAlias: null,
    apiSpuAliasUsed: false,
    apiSpuAliasReason: apiSpuProductNameRaw ? '仅展示 API 原文，不参与任务 SPU 关联或搜索' : '',
    // Keep effective values on every task DTO. Later scheduler/RPA work only
    // consumes these computed fields; raw API product fields stay untouched.
    spuSearchPolicy: policyRecord ? { ...policyRecord } : null,
    effectiveSearchPolicy: { ...effectivePolicy.search, queries: [...effectivePolicy.search.queries] },
    effectiveBlacklist: { ...effectivePolicy.blacklist, terms: [...effectivePolicy.blacklist.terms] },
    effectivePriceFence: { ...effectivePolicy.priceFence },
    effectivePageFilter: { ...effectivePolicy.pageFilter },
    localizedDisplayName: effectivePolicy.localization.displayName || withWms.name,
    localizedDisplayNameSource: effectivePolicy.localization.displayName ? 'spu_policy' : 'task_name'
  }
  if (!latest) return withApiSpuAlias
  const referenceTask = taskMap?.get(task.id) || task
  return {
    ...withApiSpuAlias,
    lastRunAt: latest.at,
    lastStatus: latest.status,
    lastPrice: latest.price ?? null,
    lastPriceComparison: latest.priceComparison || priceComparisonFor(latest, referenceTask),
    lastSource: latest.source || null,
    lastReason: latest.reason || ''
  }
}

function activeCollection(snapshot = getTaskCenterSnapshot()) {
  return snapshot.activeCollection
}

const API_SPU_LEDGER_SCHEMA_VERSION = 1

function apiSpuSnapshotHash(rows = []) {
  const stableRows = (Array.isArray(rows) ? rows : [])
    .map((row) => Object.fromEntries(Object.entries(row || {}).sort(([a], [b]) => a.localeCompare(b))))
    .sort((a, b) => text(a.sku_code).localeCompare(text(b.sku_code)))
  return createHash('sha256').update(JSON.stringify(stableRows)).digest('hex')
}

function normalizeApiSpuLedger(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const next = {}
  for (const [rawSpu, rawEntry] of Object.entries(source)) {
    const spuCode = canonicalSpu(rawSpu || rawEntry?.canonicalSpu || rawEntry?.spuCode)
    if (!spuCode) continue
    const entry = rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry) ? rawEntry : {}
    const taskId = text(entry.taskId) || `api-spu-${createHash('sha1').update(spuCode).digest('hex').slice(0, 24)}`
    next[spuCode] = {
      schemaVersion: API_SPU_LEDGER_SCHEMA_VERSION,
      canonicalSpu: spuCode,
      taskId,
      firstSeenAt: entry.firstSeenAt || null,
      lastSeenAt: entry.lastSeenAt || null,
      departedAt: entry.departedAt || null,
      active: entry.active === true,
      lastSnapshotHash: text(entry.lastSnapshotHash),
      lastSkuCodes: Array.isArray(entry.lastSkuCodes) ? [...new Set(entry.lastSkuCodes.map(text).filter(Boolean))] : [],
      source: 'api_spu'
    }
  }
  return next
}

function updateApiSpuLedger(rows = [], syncedAt = null, snapshotHash = '') {
  const current = normalizeApiSpuLedger(meta.get('apiSpuLedger'))
  if (!syncedAt) return current
  const catalog = buildSpuCatalog(rows)
  const seen = new Set()
  for (const item of catalog.items) {
    const spuCode = canonicalSpu(item.spu_code)
    if (!spuCode) continue
    seen.add(spuCode)
    const previous = current[spuCode]
    current[spuCode] = {
      schemaVersion: API_SPU_LEDGER_SCHEMA_VERSION,
      canonicalSpu: spuCode,
      taskId: text(previous?.taskId) || `api-spu-${createHash('sha1').update(spuCode).digest('hex').slice(0, 24)}`,
      firstSeenAt: previous?.firstSeenAt || syncedAt,
      lastSeenAt: syncedAt,
      departedAt: null,
      active: true,
      lastSnapshotHash: text(snapshotHash),
      lastSkuCodes: Array.isArray(item.sku_codes) ? [...new Set(item.sku_codes.map(text).filter(Boolean))] : [],
      source: 'api_spu'
    }
  }
  // A complete successful snapshot changes activity only. Never delete the
  // entry: the tombstone suppresses a stale Excel row from re-entering.
  for (const [spuCode, entry] of Object.entries(current)) {
    if (seen.has(spuCode)) continue
    if (entry.active || !entry.departedAt) {
      current[spuCode] = { ...entry, active: false, departedAt: syncedAt, source: 'api_spu' }
    }
  }
  return current
}

/** Return a sanitized copy of the durable API identity ledger. */
export function getApiSpuLedger() {
  return normalizeApiSpuLedger(meta.get('apiSpuLedger'))
}

function migrateApiSpuLedger() {
  const existing = normalizeApiSpuLedger(meta.get('apiSpuLedger'))
  const legacyRows = meta.get('wmsSkus')
  const legacySyncedAt = meta.get('wmsSyncedAt')
  // Seed identities from a pre-ledger last-good cache on upgrade. This is
  // migration only: it does not infer a SPU from brand/model/name and does not
  // mark missing historical rows as departed until a complete new snapshot.
  if (legacySyncedAt && Array.isArray(legacyRows)) {
    const catalog = buildSpuCatalog(legacyRows)
    const snapshotHash = apiSpuSnapshotHash(legacyRows)
    for (const item of catalog.items) {
      const spuCode = canonicalSpu(item.spu_code)
      if (!spuCode || existing[spuCode]) continue
      existing[spuCode] = {
        schemaVersion: API_SPU_LEDGER_SCHEMA_VERSION,
        canonicalSpu: spuCode,
        taskId: `api-spu-${createHash('sha1').update(spuCode).digest('hex').slice(0, 24)}`,
        firstSeenAt: legacySyncedAt,
        lastSeenAt: legacySyncedAt,
        departedAt: null,
        active: true,
        lastSnapshotHash: snapshotHash,
        lastSkuCodes: Array.isArray(item.sku_codes) ? [...new Set(item.sku_codes.map(text).filter(Boolean))] : [],
        source: 'api_spu'
      }
    }
  }
  const raw = meta.get('apiSpuLedger')
  if (JSON.stringify(raw || {}) !== JSON.stringify(existing)) {
    meta.set('apiSpuLedger', existing)
    invalidateTaskCenterSnapshot()
  }
  return existing
}

// Migrate old task-center stores without inventing identity from brand/model.
migrateApiSpuLedger()

function apiTaskId(spuCode, snapshot = null) {
  const key = canonicalSpu(spuCode)
  const ledgerId = snapshot?.apiSpuLedger?.[key]?.taskId
  if (ledgerId) return ledgerId
  return `api-spu-${createHash('sha1').update(key).digest('hex').slice(0, 24)}`
}

function apiTaskName(item = {}) {
  return text(item.product_name) || [item.brand, item.model].map(text).filter(Boolean).join(' ') || canonicalSpu(item.spu_code)
}

function apiDefaultSearchKeyword({ brand, model, spuCode } = {}) {
  const modelText = text(model) || canonicalSpu(spuCode)
  if (text(brand).toLowerCase() !== 'sonos') return modelText

  // Sonos listings need the consumer-facing brand prefix. Canonicalize the
  // prefix as “Sonos” and strip an upstream duplicate when model already
  // contains it, so PLAY5 / SONOS PLAY5 / sonosplay5 all produce one phrase.
  const suffix = /^sonos/i.test(modelText)
    ? modelText.slice('sonos'.length).replace(/^[\s_\-/]+/, '').trim()
    : modelText
  return ['Sonos', suffix].filter(Boolean).join(' ')
}

/**
 * 取一个 API-SPU 行的成本价。
 *
 * 成本价来自库存 API 自己的 cost_price —— 服务端只对行情工作台这个设备角色放行，
 * 只读爬虫仍然拿不到（server/app/routers/inventory.py:_hide_cost）。所以“拿不到”
 * 是正常状态之一，必须和“有值但非法”区分开：前者是 missing，后者是 invalid，
 * 两者都不能退化成"没有围栏"。
 *
 * 顺序是人工填过的优先，其次 API。端上填的是操作员的明确决定，不该被一次库存
 * 同步悄悄改掉。两者都没有就是 missing —— 调价台据此停在需复核，绝不拿建议价或
 * 销售价冒充成本：那两个数一个是成本推导结果、一个是卖价，当底价用会直接亏钱。
 */
function resolveApiCostPrice(item = {}, override = {}) {
  const manual = parseMoney(override.referencePrice, { label: '成本价' })
  if (manual.present) {
    return {
      referencePrice: manual.ok ? manual.value : null,
      referencePriceStatus: override.referencePriceStatus || (manual.ok ? 'valid' : 'invalid'),
      referencePriceReason: text(override.referencePriceReason) || (manual.ok ? '' : manual.reason)
    }
  }
  // 同一 SPU 下多个在库 SKU 成本不同（不同批次进的货）时不自动选取：底价挑错的
  // 方向是亏钱。留空走 missing，区间交给界面显示，人工定夺。
  const values = Array.isArray(item.cost_price_values) ? item.cost_price_values.map(text).filter(Boolean) : []
  if (values.length > 1) {
    return {
      referencePrice: null,
      referencePriceStatus: 'missing',
      referencePriceReason: `同一 SPU 的在库 SKU 成本价不一致（${values.join(' / ')}），未自动选取`
    }
  }
  const api = parseMoney(item.cost_price, { label: '成本价' })
  if (!api.present) return { referencePrice: null, referencePriceStatus: 'missing', referencePriceReason: '' }
  return {
    referencePrice: api.ok ? api.value : null,
    referencePriceStatus: api.ok ? 'valid' : 'invalid',
    referencePriceReason: api.ok ? '' : api.reason
  }
}

function apiTaskBase(item = {}, override = {}, snapshot = null) {
  const spuCode = canonicalSpu(item.spu_code || item.spuCode)
  const productName = text(item.product_name)
  const brand = text(override.brand ?? item.brand)
  // Product names are display/evidence text, not a guessed search field. API
  // rows without a model therefore fall back to the explicit SPU identity;
  // an operator can still opt into another keyword through an explicit
  // override, but the API product_name is never implicit.
  const model = text(override.model ?? item.model) || spuCode
  const keyword = text(override.keyword) || apiDefaultSearchKeyword({ brand, model, spuCode })
  // The API product name is evidence by default, not an implicit alias. An
  // operator may still provide explicit override.searchKeywords when it is
  // intentionally adopted as a real search field.
  const storedKeywords = cleanSearchKeywords(override.searchKeywords || [keyword].filter(Boolean))
  const cost = resolveApiCostPrice(item, override)
  return {
    id: apiTaskId(spuCode, snapshot),
    source: 'api_spu',
    sourceLabel: '库存 API-SPU',
    apiSpuSource: 'master',
    name: text(override.name) || apiTaskName({ ...item, brand, model }),
    brand,
    model,
    category: text(override.category) || '库存 API',
    spec: text(override.spec ?? item.spec),
    size: text(override.size),
    keyword,
    searchKeywords: storedKeywords.length ? storedKeywords : [spuCode],
    searchFieldLabels: storedKeywords.map(() => 'API 商品字段'),
    searchKeywordSource: 'api',
    searchAliasMode: 'api',
    searchDerivedNames: false,
    aliases: cleanConfiguredTaskAliases(override.aliases),
    effectiveAlias: text(override.effectiveAlias),
    aliasSource: text(override.aliasSource),
    aliasOverride: override.aliasOverride === true,
    spuCode,
    spu_code: spuCode,
    enabled: override.enabled !== false,
    referencePrice: cost.referencePrice,
    referencePriceStatus: cost.referencePriceStatus,
    referencePriceReason: cost.referencePriceReason,
    apiCostPrice: text(item.cost_price) || null,
    apiCostPriceValues: Array.isArray(item.cost_price_values) ? item.cost_price_values.map(text).filter(Boolean) : [],
    apiListingPrice: snapshot?.apiListingPrices?.[spuCode]?.price ?? null,
    apiListingUpdatedAt: snapshot?.apiListingPrices?.[spuCode]?.updatedAt ?? null,
    apiListingVersion: snapshot?.apiListingPrices?.[spuCode]?.version ?? null,
    apiListingEtag: snapshot?.apiListingPrices?.[spuCode]?.etag ?? null,
    aiNormalizationStatus: 'done',
    aiNormalizationSource: 'api-spu',
    aiCorrectionStatus: override.aiCorrectionStatus || 'not_needed',
    aiCorrectionAttempts: Number(override.aiCorrectionAttempts) || 0,
    aiCorrectionSource: text(override.aiCorrectionSource),
    aiCorrectionUpdatedAt: override.aiCorrectionUpdatedAt || null,
    aiCorrectionAt: override.aiCorrectionAt || null,
    aiCorrectionReason: text(override.aiCorrectionReason),
    aiCorrectionCandidate: override.aiCorrectionCandidate || null,
    correctionWorkflowStatus: override.correctionWorkflowStatus || 'idle',
    correctionWorkflowReason: text(override.correctionWorkflowReason),
    correctionWorkflowUpdatedAt: override.correctionWorkflowUpdatedAt || null,
    correctionRecollectKey: text(override.correctionRecollectKey) || null,
    correctionRecollectRequestedAt: override.correctionRecollectRequestedAt || null,
    correctionVersion: text(override.correctionVersion) || null,
    correctionOperator: text(override.correctionOperator),
    correctionReviewStatus: override.correctionReviewStatus || 'none',
    correctionAudit: Array.isArray(override.correctionAudit) ? override.correctionAudit.slice(-20) : [],
    writebackAudit: Array.isArray(override.writebackAudit) ? override.writebackAudit.slice(-20) : [],
    aiReviewStatus: override.aiReviewStatus || 'none',
    aiReviewReason: text(override.aiReviewReason),
    aiReviewUpdatedAt: override.aiReviewUpdatedAt || null,
    aiWebSearchStatus: override.aiWebSearchStatus || 'not_requested',
    aiWebSearchQuery: text(override.aiWebSearchQuery),
    aiWebSearchResults: Array.isArray(override.aiWebSearchResults) ? override.aiWebSearchResults : [],
    aiWebSearchSource: text(override.aiWebSearchSource),
    aiWebSearchUpdatedAt: override.aiWebSearchUpdatedAt || null
  }
}

/** Build crawl tasks from the authoritative API-SPU cache, keeping IDs stable
 * across API refreshes and carrying only operator workflow overrides locally. */
function buildApiSpuTasks(snapshot = getTaskCenterSnapshot(), { includeDisabled = true } = {}) {
  const overrides = snapshot.apiTaskOverrides || {}
  const taskMap = buildTaskMap(snapshot)
  const tasks = snapshot.wmsSpuCatalog.items
    .map((item) => {
      const key = canonicalSpu(item.spu_code)
      const base = apiTaskBase(item, overrides[key] || {}, snapshot)
      return decorateTask(base, snapshot, taskMap)
    })
  return includeDisabled ? tasks : tasks.filter((task) => task.enabled !== false)
}

/** API inventory is primary. Excel contributes only SPUs absent from the
 * warehouse cache (and tasks without SPU remain visible for correction). */
export function getUnifiedTasks({ includeDisabled = false, snapshot: requestedSnapshot = null } = {}) {
  const snapshot = requestedSnapshot || getTaskCenterSnapshot()
  const sourceState = unifiedApiSourceState(snapshot)
  const rawApiTasks = buildApiSpuTasks(snapshot, { includeDisabled: true })
  const allApiTasks = sourceState.ready
    ? rawApiTasks
    : rawApiTasks.map((task) => blockedUnifiedTask(task, sourceState, 'api_spu'))
  const apiTasks = includeDisabled
    ? allApiTasks
    : allApiTasks.filter((task) => task.enabled !== false && task.executable !== false)
  // Disabled API-SPU rows remain authoritative for identity de-duplication;
  // otherwise a same-SPU Excel row could silently re-enter the crawl queue.
  const apiSpus = new Set(rawApiTasks.map((task) => canonicalSpu(task.spuCode || task.spu_code)).filter(Boolean))
  // Historical API identities are tombstones as well as current rows. An API
  // departure must not release the same SPU for automatic Excel re-entry.
  const historicalApiSpus = new Set(Object.keys(snapshot.apiSpuLedger || {}).map(canonicalSpu).filter(Boolean))
  const seenExtraSpus = new Set()
  const excelTasks = getActiveTasks({ includeDisabled: true, snapshot })
    .filter((task) => includeDisabled || task.enabled !== false)
    .filter((task) => {
      const spu = canonicalSpu(task.spuCode || task.spu_code)
      if (!spu) return true
      if (apiSpus.has(spu) || historicalApiSpus.has(spu) || seenExtraSpus.has(spu)) return false
      seenExtraSpus.add(spu)
      return true
    })
    .map((task) => ({
      ...task,
      source: 'excel_extension',
      sourceLabel: 'Excel 扩展采购',
      extensionReason: 'api_spu_missing',
      apiSpuSource: 'extension'
    }))
  // Excel remains an extension source only after at least one successful API
  // snapshot exists.  Before that point includeDisabled is intentionally
  // useful for the UI/audit view, while the executable projection is empty.
  const gatedExcelTasks = sourceState.ready
    ? excelTasks
    : includeDisabled
      ? excelTasks.map((task) => blockedUnifiedTask(task, sourceState, 'excel_extension'))
      : []
  return [...apiTasks, ...gatedExcelTasks]
}

function persistCollections(collections) {
  meta.set('collections', collections)
  invalidateTaskCenterSnapshot()
}

export function hasActiveCollection() {
  return !!activeCollection()
}

function taskAiDefaults(task = {}) {
  return {
    aiNormalizationStatus: 'pending',
    aiNormalizationSource: 'legacy-migration',
    aiNormalizationUpdatedAt: null,
    aiNormalizationReason: '',
    aiCorrectionStatus: 'not_needed',
    aiCorrectionAttempts: 0,
    aiCorrectionSource: '',
    aiCorrectionUpdatedAt: null,
    aiCorrectionReason: '',
    aiCorrectionCandidate: null,
    aiReviewStatus: 'none',
    aiReviewReason: '',
    aiReviewUpdatedAt: null,
    aiWebSearchStatus: 'not_requested',
    aiWebSearchQuery: '',
    aiWebSearchResults: [],
    aiWebSearchSource: '',
    aiWebSearchUpdatedAt: null,
    ...task
  }
}

/**
 * 将接入 AI 之前导入的历史任务补齐到当前三阶段清洗结构。
 * 只增加字段，不改历史结果、不改任务 id；真正的首轮模型清洗由调度器在后台执行。
 */
export function migrateAiPipeline() {
  const collection = activeCollection()
  if (!collection) return { ok: false, migrated: 0, pending: 0, reason: '当前没有 Excel 任务清单' }
  const currentTasks = Array.isArray(collection.tasks) ? collection.tasks : []
  let migrated = 0
  let changed = false
  const tasks = currentTasks.map((task) => {
    const next = taskAiDefaults(task)
    const missing = !Object.prototype.hasOwnProperty.call(task, 'aiNormalizationStatus')
      || !Object.prototype.hasOwnProperty.call(task, 'aiCorrectionStatus')
      || !Object.prototype.hasOwnProperty.call(task, 'aiCorrectionAttempts')
    if (missing) migrated++
    if (JSON.stringify(next) !== JSON.stringify(task)) changed = true
    return next
  })
  const pending = tasks.filter((task) => task.aiNormalizationStatus !== 'done').length
  const versionChanged = Number(collection.aiPipelineSchemaVersion) !== AI_PIPELINE_SCHEMA_VERSION
  if (changed || versionChanged) {
    const now = new Date().toISOString()
    const nextCollection = {
      ...collection,
      tasks,
      aiPipelineSchemaVersion: AI_PIPELINE_SCHEMA_VERSION,
      aiMigrationAt: collection.aiMigrationAt || now
    }
    persistCollections((meta.get('collections') || []).map((item) => item.id === collection.id ? nextCollection : item))
    if (migrated > 0) recordAiEvent({
      type: 'ai-pipeline-migration',
      collectionId: collection.id,
      collectionName: collection.name,
      migrated,
      pending,
      message: `已将 ${migrated} 条历史任务补齐 AI 三阶段字段，等待首轮型号清洗`
    })
  }
  return { ok: true, collectionId: collection.id, migrated, pending, changed: changed || versionChanged }
}

/** 返回需要首轮型号清洗的任务；短时间内失败的任务不会在每次点击开爬时重复轰炸接口。 */
export function getAiNormalizationTasks({ includeDisabled = true, force = false, retryAfterMs = 5 * 60 * 1000 } = {}) {
  migrateAiPipeline()
  const now = Date.now()
  return getActiveTasks({ includeDisabled }).filter((task) => {
    if (task.aiNormalizationStatus === 'done') return false
    // 历史任务或上次失败后的本地确定性结果不再随应用启动全量重打；需要重跑时由重新导入 Excel（force=true）明确触发。
    // 当前异常任务会进入 ai_correction 队列，按单条任务处理，不把成功的历史任务带进模型请求。
    if (!force && task.aiNormalizationSource === 'local-rule') return false
    if (force) return true
    const updatedAt = Date.parse(task.aiNormalizationUpdatedAt || '')
    return !Number.isFinite(updatedAt) || now - updatedAt >= retryAfterMs
  })
}

export function recordAiEvent(event = {}) {
  const row = {
    at: new Date().toISOString(),
    type: text(event.type || 'ai-event'),
    ...event
  }
  const events = Array.isArray(meta.get('aiEvents')) ? meta.get('aiEvents') : []
  meta.set('aiEvents', [...events, row].slice(-AI_EVENT_CAP))
  return row
}

export function getAiEvents({ limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(AI_EVENT_CAP, Number(limit) || 100))
  return (meta.get('aiEvents') || []).slice(-safeLimit).reverse()
}

export function recordAiNormalizationRun({ collectionId = null, attempted = 0, updated = 0, configured = false, ok = false, fallback = false, errors = [] } = {}) {
  const collection = activeCollection()
  if (collection && (!collectionId || collection.id === collectionId)) {
    const now = new Date().toISOString()
    const result = { at: now, attempted, updated, configured, ok, fallback, errors: (errors || []).map((item) => text(item)).slice(0, 8) }
    persistCollections((meta.get('collections') || []).map((item) => item.id === collection.id
      ? { ...item, aiNormalizationLastAttemptAt: now, aiNormalizationLastResult: result }
      : item))
    return recordAiEvent({
      type: 'ai-normalization',
      collectionId: collection.id,
      collectionName: collection.name,
      ...result,
      message: ok ? `首轮型号清洗完成，更新 ${updated} 条` : (fallback ? `首轮型号清洗未完成，已保留本地规则，待补偿 ${updated} 条` : `首轮型号清洗失败，待补偿 ${updated} 条`)
    })
  }
  return recordAiEvent({ type: 'ai-normalization', attempted, updated, configured, ok, fallback, errors })
}

export function getActiveTasks({ includeDisabled = false, snapshot: requestedSnapshot = null } = {}) {
  const snapshot = requestedSnapshot || getTaskCenterSnapshot()
  const collection = activeCollection(snapshot)
  if (!collection) return []
  const tasks = collection.tasks || []
  const taskMap = buildTaskMap(snapshot)
  return (includeDisabled ? tasks : tasks.filter((task) => task.enabled !== false)).map((task) => decorateTask(task, snapshot, taskMap))
}

export function getActiveTask(id) {
  // A matching Excel extension row and an API-SPU task can coexist during the
  // migration window. Resolve explicit IDs to the editable Excel row first;
  // stable api-spu-* IDs then resolve through the same source-gated unified
  // projection used by the queue. This prevents a direct detail lookup from
  // bypassing the no-source execution gate.
  return getActiveTasks({ includeDisabled: true }).find((task) => task.id === id)
    || getUnifiedTasks({ includeDisabled: true }).find((task) => task.id === id)
    || null
}

function emptyQueueView(kind = 'all') {
  return buildQueueView({ tasks: [], runs: [], runResults: [], kind, page: 1, pageSize: 100 })
}

/** 当前 Excel 的状态队列：只认当前清单，历史尝试仍通过“行情记录”查看。 */
export function getTaskQueues({ kind = 'all', page = 1, pageSize = 100, q = '' } = {}) {
  const snapshot = getTaskCenterSnapshot()
  const collection = activeCollection(snapshot)
  const sourceState = unifiedApiSourceState(snapshot)
  const tasks = getUnifiedTasks({ snapshot })
  if (!collection && !snapshot.wmsSpuCatalog.items.length) {
    return {
      ...emptyQueueView(kind),
      sourceState,
      blockedReason: sourceState.ready ? null : sourceState.reason
    }
  }
  const view = buildQueueView({
    collectionId: collection?.id || null,
    tasks,
    runs: snapshot.runs,
    runResults: snapshot.runResults,
    kind,
    page,
    pageSize,
    q
  })
  // Queue cards are another entry point into the same history contract as the
  // history table. Normalize their latest result before IPC so mixed legacy
  // paths and named log-only diagnostics cannot disappear in the queue UI.
  return {
    ...view,
    items: view.items.map((row) => ensureSnapshotHistory(row)),
    sourceState,
    blockedReason: sourceState.ready ? null : sourceState.reason
  }
}

/**
 * Resolve one row from the same unified API-SPU + Excel projection used by
 * the queue IPC.  This is intentionally main-process only: renderers receive
 * bounded pages and never ask the task store to materialize an unbounded list.
 */
export function getMarketTask(taskId) {
  const id = text(taskId)
  if (!id) return null
  const snapshot = getTaskCenterSnapshot()
  const tasks = getUnifiedTasks({ snapshot, includeDisabled: true })
  if (!tasks.length) return null
  const view = buildQueueView({
    tasks,
    runs: snapshot.runs,
    runResults: snapshot.runResults,
    kind: 'all',
    page: 1,
    pageSize: tasks.length
  })
  const row = view.items.find((item) => item.taskId === id || item.id === id)
  return row ? ensureSnapshotHistory(row) : null
}

/** 给调度器取出某个异常队列的任务，并绑定一次性的特殊搜索策略。 */
export function getQueueTasks(kind = 'anomaly') {
  if (!retryableQueue(kind)) return { ok: false, reason: '风控或成功队列不支持自动重试，请人工处理', tasks: [], total: 0 }
  // This is a main-process scheduler read, not a renderer bulk query. Build
  // one bounded-in-memory queue view from the shared projection instead of
  // exposing the old pageSize=100000 escape hatch over IPC.
  const sourceState = unifiedApiSourceState(getTaskCenterSnapshot())
  const projected = getUnifiedTasks()
  const view = buildQueueView({
    tasks: projected,
    runs: getTaskCenterSnapshot().runs,
    runResults: getTaskCenterSnapshot().runResults,
    kind,
    page: 1,
    pageSize: Math.max(1, projected.length || 1)
  })
  const tasks = view.items
    // 风控必须可见、可审计，但绝不能被“失败复采”按钮批量再次撞击平台。
    .filter((row) => !(kind === 'failed' && row.queueKind === 'risk_control'))
    .map((row) => ({
    ...row,
    queueKind: row.queueKind,
    queueStrategy: queueRetryMode(row.queueKind).strategy
    }))
  return {
    ok: true,
    tasks,
    total: tasks.length,
    counts: view.counts,
    aiCorrectionCount: view.aiCorrectionCount || 0,
    aiReviewCount: view.aiReviewCount || 0,
    mode: queueRetryMode(kind),
    sourceState,
    blockedReason: sourceState.ready ? null : sourceState.reason
  }
}

export function setTaskAliases(id, aliases = [], source = 'manual') {
  const collection = activeCollection()
  const apiTask = getUnifiedTasks({ includeDisabled: true }).find((task) => task.id === id && task.source === 'api_spu')
  if (apiTask) {
    const result = applyTaskPatches([{ id, aliases, aiReviewStatus: 'needs_review', aiReviewReason: '人工修改搜索别称后待复核' }])
    return result.ok ? { ...result, taskId: id, aliases: getActiveTask(id)?.aliases || [], source: source || 'manual' } : result
  }
  if (!collection) return { ok: false, reason: '请先导入 Excel 任务清单' }
  const current = (collection.tasks || []).find((task) => task.id === id)
  if (!current) return { ok: false, reason: '当前 Excel 中找不到这条任务' }
  const categorySearchModes = currentCategorySearchModes()
  const categoryBaseQueries = buildCategorySearchQueries(current, categorySearchModes)
  const effectiveAliases = effectiveManualAliases(
    Array.isArray(aliases) ? aliases : [],
    [current.model, ...categoryBaseQueries],
    { brand: current.brand, category: current.category }
  )
  const effectiveAlias = effectiveAliases[0] || ''
  const clean = effectiveAliases
  const now = new Date().toISOString()
  const nextTasks = (collection.tasks || []).map((task) => task.id === id
    ? {
        ...task,
        aliases: clean,
        effectiveAlias,
        aliasSource: effectiveAlias ? (text(source) || 'manual') : '',
        aliasOverride: true,
        // An explicit edit replaces the imported legacy slots. Keeping them
        // here would make a later read resurrect values the operator cleared.
        alias1: '',
        alias2: '',
        aliasUpdatedAt: now
      }
    : task)
  const nextCollection = { ...collection, tasks: nextTasks }
  persistCollections((meta.get('collections') || []).map((item) => item.id === collection.id ? nextCollection : item))
  return { ok: true, taskId: id, aliases: clean, source: effectiveAlias ? (source || 'manual') : '', updatedAt: now }
}

/** 人工修正失败任务的搜索信息，先进入待复核，不触碰 API 主数据。 */
export function applyManualTaskCorrection(id, { brand, model, keyword, searchTerms, search_terms, alias, aliases, operator = 'manual', reason = '' } = {}) {
  const task = getActiveTask(id)
  if (!task) return { ok: false, reason: '当前 Excel 中找不到这条任务' }
  const nextBrand = brand === undefined ? (task.brand || '') : text(brand)
  const nextModel = model === undefined ? (task.model || '') : text(model)
  const nextAliasValues = aliases !== undefined ? aliases : alias === undefined ? (task.aliases || task.effectiveAlias || []) : [alias]
  const nextSearchTerms = searchTerms !== undefined ? searchTerms : search_terms !== undefined ? search_terms : (keyword === undefined ? (task.searchKeywords || []) : [keyword])
  const correctionPatch = {
    brand: nextBrand,
    model: nextModel,
    keyword: keyword === undefined ? (text(task.keyword) || `${nextBrand} ${nextModel}`.trim()) : text(keyword),
    search_terms: nextSearchTerms,
    aliases: nextAliasValues
  }
  const version = correctionVersionFor(correctionPatch)
  if (text(task.correctionVersion) === version && ['recollect_pending', 'success_pending_review', 'approved'].includes(text(task.correctionWorkflowStatus))) {
    return { ok: true, changed: false, idempotent: true, taskId: id, correctionVersion: version, recollectKey: task.correctionRecollectKey }
  }
  const correctedAt = new Date().toISOString()
  const audit = Array.isArray(task.correctionAudit) ? task.correctionAudit.slice(-19) : []
  const auditRow = buildWmsCorrectionAudit({
    task,
    skuCode: task.apiSkuCode || '',
    before: { brand: task.brand, model: task.model, keyword: task.keyword, search_terms: task.searchKeywords, aliases: task.aliases },
    after: correctionPatch,
    operator,
    reason: reason || '人工修改搜索信息',
    correctionVersion: version,
    queueIntent: 'review_pending',
    result: 'saved'
  })
  return applyTaskPatches([{
    id,
    brand: nextBrand,
    model: nextModel,
    keyword: correctionPatch.keyword,
    searchKeywords: nextSearchTerms,
    aliases: nextAliasValues,
    aiCorrectionStatus: 'done',
    aiCorrectionAt: correctedAt,
    aiCorrectionReason: reason || '人工修改搜索信息',
    aiReviewStatus: 'needs_review',
    aiReviewReason: '人工修改后待复核',
    correctionReviewStatus: 'review_pending',
    correctionWorkflowStatus: 'recollect_pending',
    correctionWorkflowReason: '搜索信息已修改，等待人工复核后显式复采',
    correctionWorkflowUpdatedAt: correctedAt,
    correctionRecollectKey: `${id}:${version}`,
    correctionRecollectRequestedAt: null,
    correctionVersion: version,
    correctionOperator: text(operator).slice(0, 48) || 'manual',
    correctionAudit: [...audit, auditRow].slice(-20)
  }])
}

/** 由 UI 明确触发一次复采意图；同一修正版本只允许生成一个幂等键。 */
export function requestTaskRecollect(id, { mode = 'local', syncWms = false, operator = 'manual' } = {}) {
  const task = getActiveTask(id)
  if (!task) return { ok: false, reason: '当前任务不存在，不能发起复采' }
  const now = new Date().toISOString()
  const key = text(task.correctionRecollectKey) || `${id}:${text(task.aiCorrectionAt) || now}`
  if (task.correctionRecollectRequestedAt && text(task.correctionRecollectKey) === key) {
    return { ok: true, changed: false, idempotent: true, taskId: id, recollectKey: key, mode: syncWms ? 'wms' : 'local' }
  }
  if (task.correctionReviewStatus === 'review_pending' && task.aiReviewStatus !== 'approved' && task.correctionRecollectRequestedAt) {
    return { ok: false, reason: '搜索修正尚未完成人工复核，不能重复入队' }
  }
  const audit = Array.isArray(task.correctionAudit) ? task.correctionAudit.slice(-19) : []
  const patch = {
    id,
    correctionWorkflowStatus: 'recollect_pending',
    correctionWorkflowReason: syncWms ? '已明确选择同步 WMS 后复采' : '已明确选择本地策略复采',
    correctionWorkflowUpdatedAt: now,
    correctionRecollectKey: key,
    correctionRecollectRequestedAt: now,
    correctionAudit: [...audit, {
      at: now,
      action: 'recollect_requested',
      taskId: id,
      canonicalSpu: canonicalSpu(task.spuCode || task.spu_code),
      correctionVersion: text(task.correctionVersion),
      mode: mode === 'wms' || syncWms ? 'wms' : 'local',
      queueIntent: 'recollect_pending',
      operator: text(operator).slice(0, 48) || 'manual'
    }].slice(-20)
  }
  const result = applyTaskPatches([patch])
  return result.ok ? { ...result, taskId: id, recollectKey: key, mode: syncWms ? 'wms' : 'local' } : result
}

/** 复采后仍无结果时升级为人工配置搜索/价格复核，防止无限循环。 */
export function recordCorrectionOutcome(id, { status = '', reason = '' } = {}) {
  const task = getActiveTask(id)
  if (!task) return { ok: false, reason: '当前任务不存在' }
  const normalized = text(status)
  const failed = ['empty', 'fail', 'invalid_price'].includes(normalized)
  const needsEscalation = failed && ['recollect_pending', 'correction_saved', 'done', 'custom_search_pending', 'price_review'].includes(text(task.correctionWorkflowStatus))
  const nextStatus = normalized === 'success' && task.correctionVersion
    ? 'success_pending_review'
    : normalized === 'success'
      ? 'completed'
      : needsEscalation ? (normalized === 'invalid_price' ? 'price_review' : 'custom_search_pending') : task.correctionWorkflowStatus || 'idle'
  if (nextStatus === task.correctionWorkflowStatus && !reason) return { ok: true, changed: false, status: nextStatus }
  const now = new Date().toISOString()
  const audit = Array.isArray(task.correctionAudit) ? task.correctionAudit.slice(-19) : []
  const result = applyTaskPatches([{
    id,
    correctionWorkflowStatus: nextStatus,
    correctionWorkflowReason: text(reason).slice(0, 240),
    correctionWorkflowUpdatedAt: now,
    ...(normalized === 'success' && task.correctionVersion ? {
      aiReviewStatus: 'needs_review',
      aiReviewReason: '修正后的复采已成功，请人工确认后回写 API',
      correctionReviewStatus: 'success_pending_review'
    } : {}),
    correctionAudit: [...audit, {
      at: now,
      action: 'recollect_outcome',
      taskId: id,
      canonicalSpu: canonicalSpu(task.spuCode || task.spu_code),
      correctionVersion: text(task.correctionVersion),
      status: normalized,
      reason: text(reason).slice(0, 160),
      result: nextStatus
    }].slice(-20)
  }])
  return result.ok ? { ...result, changed: true, status: nextStatus } : result
}

/** 将当前供应商的型号清洗结果安全地合并回当前 Excel 清单；任务 id 保持不变，历史结果可继续关联。 */
export function applyTaskPatches(patches = [], { collectionId = null } = {}) {
  const collection = activeCollection()
  const allowed = new Set([
    'brand', 'model', 'name', 'keyword', 'searchKeywords', 'aliases', 'confidence', 'enabled', 'category', 'spec', 'size',
    'aiNormalizationStatus', 'aiNormalizationSource', 'aiNormalizationReason',
    'aiCorrectionStatus', 'aiCorrectionAttempts', 'aiCorrectionSource', 'aiCorrectionReason', 'aiCorrectionCandidate',
    'aiCorrectionAt', 'correctionWorkflowStatus', 'correctionWorkflowReason', 'correctionWorkflowUpdatedAt',
    'correctionRecollectKey', 'correctionRecollectRequestedAt', 'correctionVersion', 'correctionOperator', 'correctionReviewStatus', 'correctionAudit', 'writebackAudit',
    'aiReviewStatus', 'aiReviewReason', 'aiWebSearchStatus', 'aiWebSearchQuery', 'aiWebSearchResults', 'aiWebSearchSource'
  ])
  const patchMap = new Map((Array.isArray(patches) ? patches : []).map((patch) => [text(patch.id), patch]))
  const now = new Date().toISOString()
  let updated = 0
  const nextTasks = collection && (!collectionId || collection.id === collectionId)
    ? (collection.tasks || []).map((task) => {
    const patch = patchMap.get(task.id)
    if (!patch) return task
    const next = { ...task }
    for (const key of allowed) {
      if (patch[key] !== undefined) next[key] = key === 'aliases'
        ? cleanConfiguredTaskAliases([
          ...(Array.isArray(next[key]) ? next[key] : []),
          ...(Array.isArray(patch[key]) ? patch[key] : [])
        ])
        : key === 'searchKeywords'
          ? cleanSearchKeywords(patch[key])
        : patch[key]
    }
    if (patch.aliases !== undefined) {
      const categorySearchModes = currentCategorySearchModes()
      const categoryBaseQueries = buildCategorySearchQueries(next, categorySearchModes)
      const effectiveAliases = effectiveManualAliases(
        Array.isArray(patch.aliases) ? patch.aliases : [],
        [next.model, ...categoryBaseQueries],
        { brand: next.brand, category: next.category }
      )
      next.aliases = effectiveAliases
      next.effectiveAlias = effectiveAliases[0] || ''
      next.aliasSource = effectiveAliases.length ? 'manual' : ''
      next.aliasOverride = true
      next.alias1 = ''
      next.alias2 = ''
    }
    const identity = normalizeTaskIdentity(next)
    next.brand = identity.brand
    next.model = identity.model
    next.name = displayNameFor(identity)
    if (identity.category === '空气净化器' && identity.brand && identity.model) next.keyword = `${identity.brand}${identity.model}`
    if (patch.aiNormalizationStatus || patch.aiNormalizationSource) next.aiNormalizationUpdatedAt = now
    if (patch.aiCorrectionStatus || patch.aiCorrectionSource) next.aiCorrectionUpdatedAt = now
    if (patch.aiReviewStatus || patch.aiWebSearchStatus || patch.aiWebSearchSource) {
      next.aiReviewUpdatedAt = now
      next.aiWebSearchUpdatedAt = now
    }
    updated++
    return next
      })
    : []
  const apiTasks = buildApiSpuTasks(getTaskCenterSnapshot())
  const apiTaskById = new Map(apiTasks.map((task) => [task.id, task]))
  const apiPatches = [...patchMap.values()].filter((patch) => apiTaskById.has(text(patch.id)))
  if (!nextTasks.length && !apiPatches.length) {
    return { ok: false, reason: '当前没有匹配的任务清单或 API-SPU', updated: 0 }
  }
  if (collection && (!collectionId || collection.id === collectionId)) {
    persistCollections((meta.get('collections') || []).map((item) => item.id === collection.id ? { ...item, tasks: nextTasks } : item))
  }
  if (apiPatches.length) {
    const overrides = meta.get('apiTaskOverrides') && typeof meta.get('apiTaskOverrides') === 'object'
      ? { ...meta.get('apiTaskOverrides') }
      : {}
    for (const patch of apiPatches) {
      const task = apiTaskById.get(text(patch.id))
      const spu = canonicalSpu(task.spuCode || task.spu_code)
      const previous = overrides[spu] && typeof overrides[spu] === 'object' ? { ...overrides[spu] } : {}
      for (const key of allowed) {
        if (patch[key] !== undefined) previous[key] = key === 'aliases'
          ? cleanConfiguredTaskAliases(patch[key])
          : key === 'searchKeywords'
            ? cleanSearchKeywords(patch[key])
            : patch[key]
      }
      if (patch.aliases !== undefined) {
        const effectiveAliases = effectiveManualAliases(
          Array.isArray(patch.aliases) ? patch.aliases : [],
          [previous.model || task.model, previous.keyword || task.keyword],
          { brand: previous.brand || task.brand, category: previous.category || task.category }
        )
        previous.aliases = effectiveAliases
        previous.effectiveAlias = effectiveAliases[0] || ''
        previous.aliasSource = effectiveAliases.length ? 'manual' : ''
        previous.aliasOverride = true
      }
      if (patch.aiCorrectionStatus || patch.aiCorrectionSource) previous.aiCorrectionUpdatedAt = now
      if (patch.aiCorrectionAt) previous.aiCorrectionAt = patch.aiCorrectionAt
      if (patch.aiReviewStatus || patch.aiWebSearchStatus || patch.aiWebSearchSource) {
        previous.aiReviewUpdatedAt = now
        previous.aiWebSearchUpdatedAt = now
      }
      previous.updatedAt = now
      overrides[spu] = previous
      updated++
    }
    meta.set('apiTaskOverrides', overrides)
  }
  invalidateTaskCenterSnapshot()
  const updatedTasks = nextTasks.filter((task) => patchMap.has(task.id))
  return { ok: true, collectionId: collection?.id || null, updated, tasks: updatedTasks }
}

/** 异常结果出现时只记一次 AI 纠改尝试，避免每次重试都重复消耗模型额度。 */
export function markAiCorrectionAttempt(id) {
  const task = getActiveTask(id)
  if (!task) return { ok: false, reason: '当前 Excel 中找不到这条任务' }
  const attempts = Number(task.aiCorrectionAttempts) || 0
  const result = applyTaskPatches([{ id, aiCorrectionAttempts: attempts + 1, aiCorrectionStatus: 'processing' }])
  return { ...result, attempts: attempts + 1 }
}

export function applyAiCorrection(id, result = {}) {
  const task = getActiveTask(id)
  if (!task) return { ok: false, reason: '当前 Excel 中找不到这条任务' }
  const correctedIdentity = normalizeTaskIdentity({
    brand: text(result.brand) || task.brand,
    model: text(result.model) || task.model,
    category: task.category
  })
  const patch = {
    id,
    aiCorrectionStatus: result.ok && result.corrected ? 'done' : 'failed',
    aiCorrectionSource: result.source || 'zhipu',
    aiCorrectionReason: text(result.reason),
    ...(result.ok && result.corrected ? {
      brand: correctedIdentity.brand,
      model: correctedIdentity.model,
      name: displayNameFor(correctedIdentity),
      keyword: correctedIdentity.category === '空气净化器' ? `${correctedIdentity.brand}${correctedIdentity.model}` : (text(result.keyword) || displayNameFor(correctedIdentity)),
      aliases: result.aliases || task.aliases || [],
      aiCorrectionCandidate: {
        brand: correctedIdentity.brand,
        model: correctedIdentity.model,
        name: displayNameFor(correctedIdentity),
        keyword: correctedIdentity.category === '空气净化器' ? `${correctedIdentity.brand}${correctedIdentity.model}` : (text(result.keyword) || displayNameFor(correctedIdentity)),
        aliases: result.aliases || task.aliases || [],
        source: result.source || 'zhipu',
        reason: text(result.reason)
      },
      aiReviewStatus: 'candidate',
      aiReviewReason: 'AI 已生成纠错候选，等待人工确认；如不正确可打回并联网核查'
    } : {})
  }
  return applyTaskPatches([patch])
}

export function applyAiWebSearch(id, result = {}) {
  const task = getActiveTask(id)
  if (!task) return { ok: false, reason: '当前 Excel 中找不到这条任务' }
  const results = (Array.isArray(result.results) ? result.results : []).slice(0, 10).map((item) => ({
    title: text(item.title).slice(0, 200),
    content: text(item.content).slice(0, 800),
    link: text(item.link).slice(0, 1000),
    media: text(item.media).slice(0, 120),
    publish_date: text(item.publish_date).slice(0, 80)
  }))
  const ok = !!(result.ok && results.length)
  return applyTaskPatches([{
    id,
    aiReviewStatus: ok ? 'needs_review' : 'search_failed',
    aiReviewReason: ok ? '已完成联网核查，等待人工审阅' : text(result.reason) || '联网核查未完成，等待人工处理',
    aiWebSearchStatus: ok ? 'done' : 'failed',
    aiWebSearchQuery: text(result.query).slice(0, 70),
    aiWebSearchResults: results,
    aiWebSearchSource: text(result.source) || 'web-search'
  }])
}

export function approveAiReview(id) {
  const task = getActiveTask(id)
  if (!task) return { ok: false, reason: '当前任务不存在，不能完成人工复核' }
  if (!['needs_review', 'candidate', 'search_failed'].includes(text(task.aiReviewStatus)) && !text(task.correctionVersion)) {
    return { ok: false, reason: '当前任务没有待复核的搜索修正' }
  }
  return applyTaskPatches([{
    id,
    aiReviewStatus: 'approved',
    aiReviewReason: text(task.correctionVersion) ? '人工确认搜索修正，可显式复采；成功后再确认 API 回写' : '人工确认 AI 型号候选',
    ...(task.correctionVersion ? {
      correctionReviewStatus: 'approved',
      correctionWorkflowStatus: task.lastStatus === 'success' ? 'approved' : (task.correctionWorkflowStatus || 'recollect_pending'),
      correctionWorkflowReason: task.lastStatus === 'success' ? '修正复采成功，已人工确认 API 回写门禁' : '搜索修正已人工确认，等待显式复采'
    } : {})
  }])
}

export function rejectAiReview(id, reason = '') {
  return applyTaskPatches([{ id, aiReviewStatus: 'rejected', aiReviewReason: text(reason) || '人工打回 AI 型号候选' }])
}

export function resetAiCorrection(id) {
  return applyTaskPatches([{ id, aiCorrectionStatus: 'pending', aiCorrectionReason: '' }])
}

export function getResumeInfo(tasks = null, requestedSnapshot = null) {
  const snapshot = requestedSnapshot || getTaskCenterSnapshot()
  const resolvedTasks = tasks || getUnifiedTasks({ snapshot })
  const collection = activeCollection(snapshot)
  return buildResumePlan({
    collectionId: collection?.id || null,
    tasks: resolvedTasks,
    runs: snapshot.runs,
    runResults: snapshot.runResults
  })
}

export function getResumeTasks(tasks = null, requestedSnapshot = null) {
  const snapshot = requestedSnapshot || getTaskCenterSnapshot()
  const resolvedTasks = tasks || getUnifiedTasks({ snapshot })
  const info = getResumeInfo(resolvedTasks, snapshot)
  if (!info.available) return { info, tasks: [] }
  const pendingIds = new Set(info.pendingTaskIds)
  return { info, tasks: resolvedTasks.filter((task) => pendingIds.has(task.id)) }
}

export function getSummary() {
  const snapshot = getTaskCenterSnapshot()
  const collection = activeCollection(snapshot)
  const tasks = getUnifiedTasks({ snapshot })
  const categories = {}
  for (const task of tasks) categories[task.category || '未分类'] = (categories[task.category || '未分类'] || 0) + 1
  const runs = snapshot.runs
  const latestRun = runs[0] || null
  return {
    active: collection
      ? {
          id: collection.id,
          name: collection.name,
          sourceFile: collection.sourceFile,
          sheetName: collection.sheetName,
          importedAt: collection.importedAt,
          rowCount: collection.rowCount
        }
      : null,
    activeCount: tasks.filter((task) => task.enabled !== false).length,
    totalCount: tasks.length,
    categoryCount: Object.keys(categories).length,
    categories,
    latestRun,
    queues: getTaskQueues({ kind: 'all', page: 1, pageSize: 1 }).counts,
    resume: getResumeInfo(tasks, snapshot),
    nextSchedule: getNextSchedule(new Date(), snapshot),
    hasLocalTasks: !!collection
  }
}

export function getSample() {
  const snapshot = getTaskCenterSnapshot()
  const collection = activeCollection(snapshot)
  if (!collection) return { ...getBuiltinTemplateSample(), ...taskTemplateMetadataDto(), isBuiltin: true }
  const taskMap = buildTaskMap(snapshot)
  return {
    ...taskTemplateMetadataDto(),
    sourceFile: collection.sourceFile,
    sheetName: collection.sheetName,
    rowCount: collection.rowCount,
    // Preview must use the same decoration path as the task list: raw import
    // rows do not yet contain WMS/API SPU fields or the cleaned SPU alias.
    rows: (collection.tasks || []).slice(0, 10).map((task) => decorateTask(task, snapshot, taskMap)),
    isBuiltin: false
  }
}

function getBuiltinTemplateSample() {
  if (builtinTemplateSample) return builtinTemplateSample
  try {
    const workbook = XLSX.read(readFileSync(getTaskTemplatePath()), { type: 'buffer', cellDates: false })
    const sheetName = workbook.SheetNames.includes(TASK_TEMPLATE_SHEET) ? TASK_TEMPLATE_SHEET : workbook.SheetNames[0]
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' })
    const headerIndex = rows.findIndex((row) => Array.isArray(row) && row.length >= TASK_TEMPLATE_COLUMNS.length)
    if (headerIndex < 0) throw new Error('卖家工作台模板没有标准表头')
    const headers = rows[headerIndex]
    const tasks = rows
      .slice(headerIndex + 1)
      .map((row, index) => normalizeRow(row, headers, headerIndex + index + 2))
      .filter(Boolean)
    if (!tasks.length) throw new Error('卖家工作台模板没有示例任务')
    // The input sheet deliberately stays limited to user-owned fields.  A
    // separate read-only sheet carries API examples so the built-in preview
    // can still demonstrate the independent API original and cleaned alias.
    const apiSheet = workbook.Sheets['API字段示例']
    if (apiSheet) {
      const apiRows = XLSX.utils.sheet_to_json(apiSheet, { header: 1, raw: false, defval: '' })
      const apiHeaderIndex = apiRows.findIndex((row) => Array.isArray(row) && row.includes('API SKU/序列号') && row.includes('SPU编码'))
      const apiHeaders = apiHeaderIndex >= 0 ? apiRows[apiHeaderIndex] : []
      const apiColumn = (name) => apiHeaders.indexOf(name)
      const apiBySpu = new Map(apiRows.slice(apiHeaderIndex + 1).map((row) => [text(row[apiColumn('SPU编码')]), row]).filter(([spuCode]) => spuCode))
      for (const task of tasks) {
        const apiRow = apiBySpu.get(text(task.spuCode))
        if (!apiRow) continue
        const rawProductName = text(apiRow[apiColumn('API商品名原文（中国商品信息网）')])
        if (!rawProductName || rawProductName.startsWith('按实际 API')) continue
        task.apiSkuCode = text(apiRow[apiColumn('API SKU/序列号')]) || null
        task.apiSpuCode = text(task.spuCode) || null
        task.apiSpuProductName = rawProductName
        task.apiSpuCleanedAlias = null
        task.apiSpuAlias = null
        task.apiSpuAliasUsed = false
        task.apiSpuAliasReason = '仅展示 API 原文，不参与任务 SPU 关联或搜索'
      }
    }
    builtinTemplateSample = {
      sourceFile: TASK_TEMPLATE_FILE,
      sheetName,
      rowCount: tasks.length,
      rows: tasks.slice(0, 10)
    }
  } catch {
    // A source checkout should always contain the asset; keep a readable
    // fallback for damaged/partial installs so Task Center can still open.
    builtinTemplateSample = BUILTIN_SAMPLE
  }
  return builtinTemplateSample
}

function taskTemplateCandidates() {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'templates', TASK_TEMPLATE_FILE))
  }
  // In development this resolves from src/main; in a packaged app it resolves
  // from out/main inside app.asar. electron-builder keeps resources/templates
  // at the project-relative path in both layouts.
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), '../../resources/templates', TASK_TEMPLATE_FILE))
  candidates.push(join(process.cwd(), 'resources/templates', TASK_TEMPLATE_FILE))
  return candidates.filter(Boolean)
}

export function getTaskTemplatePath() {
  const path = taskTemplateCandidates().find((candidate) => existsSync(candidate))
  if (!path) throw new Error(`卖家工作台模板未找到，请检查 ${TASK_TEMPLATE_FILE} 是否已随应用打包`)
  return path
}

export function copyTaskTemplate(outputPath) {
  const requested = text(outputPath)
  if (!requested) throw new Error('未提供卖家工作台模板保存路径')
  const target = resolve(requested)
  if (extname(target).toLowerCase() !== '.xlsx') throw new Error('卖家工作台模板必须保存为 .xlsx 文件')
  copyFileSync(getTaskTemplatePath(), target)
  return {
    ok: true,
    path: target,
    fileName: TASK_TEMPLATE_FILE,
    ...taskTemplateMetadataDto()
  }
}

export function getTasks({ page = 1, pageSize = 100, category = '', q = '', includeDisabled = true } = {}) {
  // Task Center remains the user-owned Excel/extension editor. The automatic
  // crawler and market queues use getUnifiedTasks(); keeping this endpoint
  // Excel-scoped preserves the editable source table and legacy import UX.
  let rows = getActiveTasks({ includeDisabled, snapshot: getTaskCenterSnapshot() })
  const query = text(q).toLowerCase()
  if (category) rows = rows.filter((task) => task.category === category)
  if (query) rows = rows.filter((task) => [task.name, task.brand, task.model, task.size, task.spec, task.keyword, ...(task.searchKeywords || [])].some((value) => text(value).toLowerCase().includes(query)))
  const total = rows.length
  const safePage = Math.max(1, Math.floor(Number(page) || 1))
  const safePageSize = Math.max(1, Math.min(500, Math.floor(Number(pageSize) || 100)))
  const start = (safePage - 1) * safePageSize
  return { items: rows.slice(start, start + safePageSize), total, page: safePage, pageSize: safePageSize }
}

export function getUnifiedTaskList({ page = 1, pageSize = 100, category = '', q = '', includeDisabled = true } = {}) {
  let rows = getUnifiedTasks({ includeDisabled })
  const query = text(q).toLowerCase()
  if (category) rows = rows.filter((task) => task.category === category)
  if (query) rows = rows.filter((task) => [
    task.name, task.brand, task.model, task.size, task.spec, task.keyword,
    task.spuCode, task.apiSpuCode, task.apiProductName, ...(task.searchKeywords || [])
  ].some((value) => text(value).toLowerCase().includes(query)))
  const total = rows.length
  const safePage = Math.max(1, Math.floor(Number(page) || 1))
  const safePageSize = Math.max(1, Math.min(500, Math.floor(Number(pageSize) || 100)))
  const start = (safePage - 1) * safePageSize
  return { items: rows.slice(start, start + safePageSize), total, page: safePage, pageSize: safePageSize }
}

export function setTaskEnabled(id, enabled) {
  const collection = activeCollection()
  const apiTask = getUnifiedTasks({ includeDisabled: true }).find((task) => task.id === id && task.source === 'api_spu')
  if (apiTask) {
    const result = applyTaskPatches([{ id, enabled: !!enabled }])
    return result.ok ? getActiveTask(id) : null
  }
  if (!collection) return null
  const collections = meta.get('collections') || []
  const nextTasks = (collection.tasks || []).map((task) => (task.id === id ? { ...task, enabled: !!enabled } : task))
  const nextCollection = { ...collection, tasks: nextTasks }
  persistCollections(collections.map((item) => (item.id === collection.id ? nextCollection : item)))
  return decorateTask(nextTasks.find((task) => task.id === id) || {})
}

export function getCollections() {
  const snapshot = getTaskCenterSnapshot()
  const activeId = snapshot.activeCollectionId
  return snapshot.collections.map((collection) => ({
    id: collection.id,
    name: collection.name,
    sourceFile: collection.sourceFile,
    sheetName: collection.sheetName,
    rowCount: collection.rowCount,
    importedAt: collection.importedAt,
    archivedAt: collection.archivedAt || null,
    status: collection.id === activeId ? 'active' : 'archived'
  }))
}

export function importSpreadsheet(buffer, fileName = '') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  if (!workbook.SheetNames.length) throw new Error('Excel 没有可读取的工作表')
  const sheetName = workbook.SheetNames.find((name) => /库存|任务|型号|清洗|汇总|明细|monitor|task/i.test(name)) || workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
  const headerIndex = rows.findIndex((row) => {
    if (!Array.isArray(row)) return false
    const hasBrand = row.some((cell) => ['品牌', '清洗品牌', 'brand', '厂商'].includes(headerKey(cell)))
    const hasModel = row.some((cell) => isPrimaryModelHeader(cell))
    return hasBrand && hasModel
  })
  if (headerIndex < 0) {
    throw new Error(`未找到任务表头；至少需要“${TASK_TEMPLATE_REQUIRED_COLUMNS.join(' / ')}”（也兼容“清洗品牌 / 清洗型号”）。请在行情任务中心点击“下载卖家工作台模板”，按“${TASK_TEMPLATE_SHEET}”工作表格式填写后再导入`)
  }
  const headers = rows[headerIndex]
  const tasks = rows
    .slice(headerIndex + 1)
    .map((row, index) => normalizeRow(row, headers, headerIndex + index + 2))
    .filter(Boolean)
  if (!tasks.length) throw new Error('Excel 中没有可执行的型号任务')

  const now = new Date().toISOString()
  const oldCollections = meta.get('collections') || []
  const oldActiveId = meta.get('activeCollectionId')
  const collections = oldCollections.map((collection) =>
    collection.id === oldActiveId ? { ...collection, archivedAt: now } : collection
  )
  const collection = {
    id: randomUUID(),
    name: basename(fileName).replace(/\.(xlsx?|xlsm)$/i, '') || 'Excel 任务清单',
    sourceFile: basename(fileName) || '未命名.xlsx',
    sheetName,
    rowCount: tasks.length,
    importedAt: now,
    tasks
  }
  collections.unshift(collection)
  // 任务快照不是历史结果，保留最近 12 份便于回看来源。
  persistCollections(collections.slice(0, 12))
  meta.set('activeCollectionId', collection.id)
  meta.set('lastImport', { sourceFile: collection.sourceFile, sheetName, rowCount: tasks.length, at: now })
  invalidateTaskCenterSnapshot()
  return {
    ok: true,
    collectionId: collection.id,
    sourceFile: collection.sourceFile,
    sheetName,
    rowCount: tasks.length,
    categories: [...new Set(tasks.map((task) => task.category))],
    sample: getSample()
  }
}

export function getSettings(snapshot = getTaskCenterSnapshot()) {
  const settings = { ...snapshot.settings }
  settings.categorySearchModes = normalizeCategorySearchModes(settings.categorySearchModes)
  // 旧版本默认 1.5~3.5 秒，连续搜索容易触发平台验证；升级到保守节奏一次。
  if (Number(settings.rateSafetyVersion) < 2 || Number(settings.throttleMinMs) < 8000 || Number(settings.throttleMaxMs) < 8000 || Number(settings.queryDelayMinMs) < 5000) {
    settings.throttleMinMs = 12000
    settings.throttleMaxMs = 20000
    settings.queryDelayMinMs = 8000
    settings.queryDelayMaxMs = 14000
    settings.rateSafetyVersion = 2
    meta.set('settings', { ...snapshot.settings, ...settings })
    invalidateTaskCenterSnapshot()
  }
  return { ...settings, blacklistKeywords: normalizeBlacklist(settings.blacklistKeywords) }
}

export function setSettings(patch = {}) {
  const snapshot = getTaskCenterSnapshot()
  const next = { ...snapshot.settings, ...patch }
  next.dailyTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(text(next.dailyTime)) ? next.dailyTime : '02:00'
  next.dailyEnabled = !!next.dailyEnabled
  next.launchAtLogin = !!next.launchAtLogin
  next.autoResumeExecutors = next.autoResumeExecutors !== false
  next.throttleMinMs = Math.max(8000, Number(next.throttleMinMs) || 12000)
  next.throttleMaxMs = Math.max(next.throttleMinMs, Number(next.throttleMaxMs) || 20000)
  next.queryDelayMinMs = Math.max(5000, Number(next.queryDelayMinMs) || 8000)
  next.queryDelayMaxMs = Math.max(next.queryDelayMinMs, Number(next.queryDelayMaxMs) || 14000)
  next.rateSafetyVersion = 2
  next.recycleEvery = Math.max(0, Number(next.recycleEvery) || 0)
  next.maxTasks = Math.max(0, Number(next.maxTasks) || 0)
  next.syncToErp = !!next.syncToErp
  next.wmsSource = ['auto', 'rest', 'mcp'].includes(next.wmsSource) ? next.wmsSource : 'auto'
  next.wmsMcpUrl = text(next.wmsMcpUrl)
  next.wmsMcpKey = text(next.wmsMcpKey)
  next.wmsRestUsername = text(next.wmsRestUsername)
  next.wmsRestPassword = text(next.wmsRestPassword)
  next.blacklistKeywords = normalizeBlacklist(next.blacklistKeywords)
  next.categorySearchModes = normalizeCategorySearchModes(next.categorySearchModes)
  meta.set('settings', next)
  invalidateTaskCenterSnapshot()
  return next
}

function scheduleDate(now, time) {
  const [hour, minute] = text(time || '02:00').split(':').map(Number)
  const target = new Date(now)
  target.setHours(hour || 0, minute || 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  return target
}

export function getNextSchedule(now = new Date(), snapshot = null) {
  // 自动开爬不再有开关（见 scheduler.rearmDaily）：是否真跑看租约和账号，这里只报到点时间
  const settings = getSettings(snapshot || getTaskCenterSnapshot())
  return scheduleDate(now, settings.dailyTime).toISOString()
}

export function startRun({ trigger = 'manual', total = 0, source = 'local_excel', resumeOf = null, queueKind = null } = {}) {
  const collection = activeCollection()
  const run = {
    id: randomUUID(),
    collectionId: collection?.id || null,
    collectionName: collection?.name || '服务端任务',
    source,
    trigger,
    queueKind,
    resumeOf,
    total,
    success: 0,
    empty: 0,
    fail: 0,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null
  }
  meta.set('runs', [run, ...(meta.get('runs') || [])].slice(0, RUN_CAP))
  invalidateTaskCenterSnapshot()
  return run
}

export function recordRunResult(runId, task, result) {
  const normalizedTask = normalizeTaskIdentity(task)
  const wmsMatch = result.wmsMatch || wmsMatchSummary(task, getWmsSkus())
  // These are distinct sources in history: task SPU is supplied by the task
  // sheet; API SPU and its product fields are read from the authoritative API.
  const taskSpuCode = normalizedTask.spuCode || null
  const apiAssociated = Boolean(wmsMatch.associated)
  const apiSpuProductName = apiAssociated ? text(wmsMatch.product_name || task.apiSpuProductName || task.wmsProductName) : ''
  const apiSpuCleanedAlias = null
  const apiSpuAlias = null
  const apiSpuAliasUsed = false
  const effectiveAlias = text(task.effectiveAlias)
  const aliasSource = text(task.aliasSource)
  const apiSpuAliasReason = apiSpuProductName ? '仅展示 API 原文，不参与任务 SPU 关联或搜索' : ''
  const priceComparison = result.priceComparison || classifyPriceAgainstPurchase({
    marketPrice: result.price,
    purchasePrice: task.referencePrice,
    purchasePriceStatus: task.referencePriceStatus,
    purchasePriceReason: task.referencePriceReason
  })
  // Persist a stable query-scoped identity before creating diagnostic files.
  // New crawl results already carry one entry per query; older callers may
  // only provide searchKeywords/queryResults, so fill those gaps explicitly
  // instead of reconstructing a path from an array position later in the UI.
  const normalizedEntries = normalizeSnapshotEntries(result)
  const entriesWithFallbacks = ensureFailureSnapshotEntries(result, normalizedEntries)
  const snapshotEntries = entriesWithFallbacks.map((entry) => ({
    ...entry,
    entryId: text(entry.entryId) || snapshotEntryId(runId, task.id, entry.query)
  }))
  const queryLogs = normalizeQueryLogs(result, snapshotEntries).map((log) => ({
    ...log,
    entryId: text(log.entryId) || snapshotEntryId(runId, task.id, log.query)
  }))
  const persistedSnapshotEntries = persistDiagnosticSnapshots({
    entries: snapshotEntries,
    logs: queryLogs,
    runId,
    taskId: task.id,
    row: { ...result, name: displayNameFor({ ...normalizedTask, category: task.category }), model: normalizedTask.model }
  })
  const persistedSnapshotPaths = [...new Set([
    ...(Array.isArray(result.snapshotPaths) ? result.snapshotPaths : []),
    ...persistedSnapshotEntries.map((entry) => text(entry.path))
  ].map((path) => text(path)).filter(Boolean))]
  const firstPersistedSnapshot = persistedSnapshotEntries.find((entry) => entry.path) || null
  const persistedQueryLogs = queryLogs.map((log) => {
    const entry = persistedSnapshotEntries.find((candidate) => candidate.entryId === log.entryId || (candidate.query && candidate.query === log.query))
    return entry ? { ...log, entryId: entry.entryId, path: entry.path || null, snapshotStatus: entry.snapshotStatus } : log
  })
  const row = {
    id: randomUUID(),
    runId,
    taskId: task.id,
    name: displayNameFor({ ...normalizedTask, category: task.category }),
    brand: normalizedTask.brand,
    model: normalizedTask.model,
    size: task.size,
    spec: task.spec,
    category: task.category || '未分类',
    spuCode: taskSpuCode,
    spu_code: taskSpuCode,
    referencePrice: task.referencePrice ?? null,
    referencePriceStatus: task.referencePriceStatus || (task.referencePrice == null ? 'missing' : 'valid'),
    referencePriceReason: task.referencePriceReason || '',
    keyword: task.keyword || task.name,
    searchKeywords: Array.isArray(result.searchKeywords) && result.searchKeywords.length
      ? cleanSearchKeywords(result.searchKeywords)
      : cleanSearchKeywords(task.searchKeywords),
    searchFieldLabels: task.searchFieldLabels || [],
    effectiveAlias,
    aliasSource,
    account: result.account || '',
    snapshotPath: result.snapshotPath || firstPersistedSnapshot?.path || null,
    snapshotQuery: result.snapshotQuery || firstPersistedSnapshot?.query || '',
    snapshotPaths: persistedSnapshotPaths.length ? persistedSnapshotPaths : (Array.isArray(result.snapshotPaths) ? result.snapshotPaths : []),
    snapshotViewport: result.snapshotViewport || null,
    pageUrl: result.pageUrl || '',
    snapshotEntries: persistedSnapshotEntries,
    queryLogs: persistedQueryLogs,
    decisionMapByQuery: normalizeDecisionMaps(result.decisionMapByQuery),
    at: new Date().toISOString(),
    price: result.price ?? null,
    priceComparison,
    priceBand: priceComparison.key,
    priceRatioPercent: priceComparison.ratioPercent,
    priceMarkupPercent: priceComparison.markupPercent,
    priceReason: priceComparison.reason,
    source: result.source || null,
    priceBreakdown: result.priceBreakdown || null,
    // Task-level purchase-price fence evidence is intentionally separate from
    // per-card reasonCode values such as blacklist/low_price/relevance.
    purchasePriceFence: result.purchasePriceFence || null,
    queueKind: result.queueKind || task.queueKind || null,
    attemptStrategy: result.attemptStrategy || task.queueStrategy || 'normal',
    publicationCheck: result.publicationCheck || null,
    apiSpuAssociated: Boolean(wmsMatch.associated),
    apiSpuAssociationStatus: wmsMatch.associationStatus || 'api_not_synced',
    apiSpuAssociationPercent: wmsMatch.associationPercent ?? null,
    apiSpuAssociationReason: wmsMatch.reason || '',
    apiSpuDataQualityStatus: wmsMatch.dataQualityStatus || 'unknown',
    apiSkuCode: apiAssociated ? (wmsMatch.sku_code || null) : null,
    apiSkuCodes: apiAssociated && Array.isArray(wmsMatch.sku_codes) ? wmsMatch.sku_codes : [],
    apiSkuCount: apiAssociated ? (Number(wmsMatch.sku_count) || 0) : 0,
    apiSpuCode: apiAssociated ? (wmsMatch.spu_code || null) : null,
    apiBrand: apiAssociated ? (wmsMatch.brand || null) : null,
    apiModel: apiAssociated ? (wmsMatch.model || null) : null,
    apiProductName: apiSpuProductName || null,
    apiSpec: apiAssociated ? (wmsMatch.spec || null) : null,
    apiSalePrice: apiAssociated ? (wmsMatch.sale_price || null) : null,
    apiSalePriceValues: apiAssociated && Array.isArray(wmsMatch.sale_price_values) ? wmsMatch.sale_price_values : [],
    apiSuggestPrice: apiAssociated ? (wmsMatch.suggest_price || null) : null,
    apiSuggestPriceValues: apiAssociated && Array.isArray(wmsMatch.suggest_price_values) ? wmsMatch.suggest_price_values : [],
    apiDataConflict: apiAssociated && Boolean(wmsMatch.api_data_conflict),
    apiSpuProductName: apiSpuProductName || null,
    apiSpuCleanedAlias: apiSpuCleanedAlias || null,
    apiSpuAlias,
    apiSpuAliasUsed,
    apiSpuAliasReason,
    status: result.status,
    reason: result.reason || ''
  }
  meta.set('runResults', [row, ...(meta.get('runResults') || [])].slice(0, RESULT_CAP))
  const runs = meta.get('runs') || []
  const counterKey = result.status === 'risk_control' ? 'riskControl' : result.status
  const nextRuns = runs.map((run) => (run.id === runId ? { ...run, [counterKey]: (run[counterKey] || 0) + 1 } : run))
  meta.set('runs', nextRuns)
  // Keep the correction state machine adjacent to the durable result. A
  // failed one-time recollect escalates to custom search/price review; it is
  // never auto-requeued indefinitely.
  recordCorrectionOutcome(task.id, { status: result.status, reason: result.reason })
  invalidateTaskCenterSnapshot()
  return row
}

function normalizeDecisionMaps(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output = {}
  for (const [query, map] of Object.entries(value)) {
    if (!map || typeof map !== 'object') continue
    const entries = Array.isArray(map.entries) ? map.entries.slice(0, 120).map((entry) => ({
      itemId: text(entry?.itemId),
      itemUrl: text(entry?.itemUrl),
      title: text(entry?.title).slice(0, 180),
      price: Number.isFinite(Number(entry?.price)) ? Number(entry.price) : null,
      decision: text(entry?.decision) || 'accepted',
      reasonCode: text(entry?.reasonCode) || 'accepted',
      keys: Array.isArray(entry?.keys) ? entry.keys.map((key) => text(key)).filter(Boolean).slice(0, 4) : []
    })) : []
    output[text(query)] = { entries }
  }
  return output
}

function normalizeSnapshotEntries(result = {}) {
  const usedEntryIds = new Set()
  const queryCounts = new Map()
  const rawEntries = Array.isArray(result.snapshotEntries) && result.snapshotEntries.length
    ? result.snapshotEntries
    : []
  for (const entry of rawEntries) {
    const query = text(entry?.query)
    if (query) queryCounts.set(query, (queryCounts.get(query) || 0) + 1)
  }
  let generatedIndex = 0
  const allocateEntryId = (entry = {}) => {
    const explicit = text(entry?.entryId)
    const path = text(entry?.path || entry?.snapshotPath)
    const query = text(entry?.query)
    const pathIdentity = path ? `legacy:path:${path}` : ''
    const seed = explicit
      || pathIdentity
      || (query && queryCounts.get(query) === 1 ? query : `legacy:entry:${generatedIndex}`)
    let entryId = explicit || (pathIdentity ? pathIdentity : snapshotEntryId(result.runId, result.taskId, seed))
    let suffix = 2
    const baseEntryId = entryId
    while (usedEntryIds.has(entryId)) entryId = `${baseEntryId}:${suffix++}`
    usedEntryIds.add(entryId)
    generatedIndex += 1
    return entryId
  }
  const normalizeEntry = (entry, compatibility = false) => ({
    entryId: allocateEntryId(entry),
    query: text(entry?.query),
    path: text(entry?.path || entry?.snapshotPath) || null,
    pageUrl: text(entry?.pageUrl),
    capturedAt: text(entry?.capturedAt) || null,
    viewport: entry?.viewport || null,
    snapshotStatus: text(entry?.snapshotStatus) || (entry?.path ? 'saved' : 'not_captured'),
    error: text(entry?.error) || null,
    cardCount: Number(entry?.cardCount) || 0,
    acceptedCount: Number(entry?.acceptedCount) || 0,
    blockedCount: Number(entry?.blockedCount) || 0,
    nonTargetCount: Number(entry?.nonTargetCount) || 0,
    lowPriceCount: Number(entry?.lowPriceCount) || 0,
    markedCount: Number(entry?.markedCount) || 0,
    unmatchableCount: Number(entry?.unmatchableCount) || 0,
    unmappedCount: Number(entry?.unmappedCount ?? entry?.unmatchableCount) || 0,
    markReasonCodes: Array.isArray(entry?.markReasonCodes) ? entry.markReasonCodes.map((code) => text(code)).filter(Boolean).slice(0, 20) : [],
    cardSummaries: Array.isArray(entry?.cardSummaries) ? entry.cardSummaries.slice(0, 10).map((card) => ({
      itemId: text(card?.itemId),
      itemUrl: text(card?.itemUrl),
      title: text(card?.title).slice(0, 180),
      price: Number.isFinite(Number(card?.price)) ? Number(card.price) : null,
      decision: text(card?.decision),
      reasonCode: text(card?.reasonCode)
    })) : [],
    compatibility: Boolean(entry?.compatibility || compatibility),
    ...(entry?.label ? { label: text(entry.label) } : {})
  })
  const legacyEntry = (path, overrides = {}) => normalizeEntry({
    query: '',
    path,
    // Legacy paths intentionally remain unbound to a query. They still need
    // distinct opaque identities so renderer keys and path-scoped diagnostics
    // cannot collapse several unlabeled files into one entry.
    snapshotStatus: 'legacy_unlabeled',
    error: '兼容快照/未记录关键词',
    label: '兼容快照/未记录关键词',
    compatibility: true,
    ...overrides
  }, true)
  const entries = rawEntries.map((entry) => normalizeEntry(entry))
  // A single legacy path carries its own reliable snapshotQuery label. Handle
  // it before the conservative supplementary-path branch; only genuinely
  // unlabeled multi-path rows must degrade to compatibility entries.
  if (!entries.length && text(result.snapshotPath) && !(Array.isArray(result.snapshotPaths) && result.snapshotPaths.length)) {
    return [normalizeEntry({
      entryId: snapshotEntryId(result.runId, result.taskId, text(result.snapshotQuery) || '默认快照'),
      query: text(result.snapshotQuery) || '默认快照',
      path: text(result.snapshotPath),
      pageUrl: text(result.pageUrl),
      viewport: result.snapshotViewport || null,
      snapshotStatus: 'legacy_default',
      compatibility: true
    }, true)]
  }
  const representedPaths = new Set(entries.map((entry) => text(entry.path)).filter(Boolean))
  const hasMultiPathArray = Array.isArray(result.snapshotPaths) && result.snapshotPaths.length > 0
  const supplementaryPaths = [
    ...(hasMultiPathArray ? result.snapshotPaths : []),
    // Mixed legacy rows can carry a first path plus a multi-path array. Keep
    // both real values when they are distinct; never bind the extra path to a
    // searchKeywords position.
    ...(text(result.snapshotPath) && (hasMultiPathArray || entries.length) ? [result.snapshotPath] : [])
  ].map((path) => text(path)).filter(Boolean)
  for (const path of [...new Set(supplementaryPaths)]) {
    if (representedPaths.has(path)) continue
    entries.push(legacyEntry(path))
    representedPaths.add(path)
  }
  if (entries.length) return entries

  return []
}

function normalizeQueryLogs(result = {}, snapshotEntries = []) {
  const liveItems = Array.isArray(result.queryLogs) ? result.queryLogs : []
  const projectionItems = Array.isArray(result.priceBreakdown?.queryResults)
    ? result.priceBreakdown.queryResults
    : []
  const sources = [
    liveItems.map((raw, index) => ({ raw, source: 'live', index })),
    projectionItems.map((raw, index) => ({ raw, source: 'projection', index }))
  ]
  const entriesByQuery = new Map()
  for (const entry of snapshotEntries) {
    const query = text(entry?.query)
    if (!query) continue
    const list = entriesByQuery.get(query) || []
    list.push(entry)
    entriesByQuery.set(query, list)
  }
  const consumed = sources.map(() => new Set())

  const selectForEntry = (sourceRecords, entry) => {
    const entryId = text(entry?.entryId)
    const exact = sourceRecords.filter((record) => text(record.raw?.entryId) === entryId)
    if (exact.length) return exact
    const query = text(entry?.query)
    // An entryId is authoritative. Query fallback is allowed only for a
    // source record that has no entryId and a query that names one entry.
    if (!query || (entriesByQuery.get(query) || []).length !== 1) return []
    return sourceRecords.filter((record) => !text(record.raw?.entryId) && text(record.raw?.query) === query)
  }

  const mergeRaw = (records = []) => records.reduce((merged, record) => ({ ...merged, ...(record.raw || {}) }), {})
  const normalizeLog = (raw = {}, entry = null, index = 0, logOnly = false) => {
    const query = text(raw.query) || text(entry?.query)
    const path = text(raw.path || raw.snapshotPath) || text(entry?.path) || null
    const pageUrl = text(raw.pageUrl) || text(entry?.pageUrl)
    const capturedAt = text(raw.capturedAt) || text(entry?.capturedAt) || null
    const effectiveLogOnly = entry ? Boolean(raw.logOnly) : true
    return {
      entryId: text(entry?.entryId) || text(raw.entryId) || snapshotEntryId(result.runId, result.taskId, `log:${index}:${query}`),
      query,
      queryIndex: Number.isInteger(raw.queryIndex) ? raw.queryIndex : index,
      path,
      pageUrl,
      capturedAt,
      snapshotStatus: text(raw.snapshotStatus) || text(entry?.snapshotStatus) || (logOnly ? 'log_only' : 'not_captured'),
      error: text(raw.error) || text(raw.reason) || text(entry?.error) || (logOnly ? '旧版日志未绑定到具体快照路径' : null),
      cardCount: Number(raw.cardCount ?? raw.cards ?? entry?.cardCount) || 0,
      acceptedCount: Number(raw.acceptedCount ?? raw.accepted ?? raw.priced ?? entry?.acceptedCount) || 0,
      blockedCount: Number(raw.blockedCount ?? raw.blocked ?? entry?.blockedCount) || 0,
      nonTargetCount: Number(raw.nonTargetCount ?? raw.nonTarget ?? entry?.nonTargetCount) || 0,
      lowPriceCount: Number(raw.lowPriceCount ?? raw.lowPrice ?? entry?.lowPriceCount) || 0,
      markedCount: Number(raw.markedCount ?? entry?.markedCount) || 0,
      unmatchableCount: Number(raw.unmatchableCount ?? entry?.unmatchableCount) || 0,
      unmappedCount: Number(raw.unmappedCount ?? raw.unmatchableCount ?? entry?.unmappedCount ?? entry?.unmatchableCount) || 0,
      markReasonCodes: Array.isArray(raw.markReasonCodes)
        ? raw.markReasonCodes.map((code) => text(code)).filter(Boolean).slice(0, 20)
        : (entry?.markReasonCodes || []),
      cardSummaries: Array.isArray(raw.cardSummaries) ? raw.cardSummaries.slice(0, 10) : (entry?.cardSummaries || []),
      reason: text(raw.reason) || text(entry?.error) || (entry?.markedCount ? `按接口商品 ID/链接标记 ${entry.markedCount} 张卡片` : '接口判定通过，未标记卡片'),
      purchasePriceFence: raw.purchasePriceFence || null,
      compatibility: Boolean(raw.compatibility || entry?.compatibility || logOnly),
      logOnly: effectiveLogOnly
    }
  }

  const logs = []
  for (const [index, entry] of snapshotEntries.entries()) {
    const selected = sources.map((records, sourceIndex) => {
      const matches = selectForEntry(records, entry)
      for (const record of matches) consumed[sourceIndex].add(record.index)
      return matches
    })
    const records = [...selected[1], ...selected[0]] // live source wins on field conflicts
    logs.push(normalizeLog(mergeRaw(records), entry, index, false))
  }

  // Keep extra live/projection queries as explicit log-only rows. Same-source
  // records without an entryId are grouped by query; records with an entryId
  // remain keyed by that opaque identity and are never positionally rebound.
  const extras = sources.flatMap((records, sourceIndex) => records
    .filter((record) => !consumed[sourceIndex].has(record.index))
    .map((record) => ({ ...record, sourceIndex })))
  const extraGroups = new Map()
  for (const record of extras) {
    const rawEntryId = text(record.raw?.entryId)
    const query = text(record.raw?.query)
    const key = rawEntryId
      ? `id:${rawEntryId}`
      : query
        ? `query:${query}`
        : `anonymous:${record.source}:${record.index}`
    const group = extraGroups.get(key) || []
    group.push(record)
    extraGroups.set(key, group)
  }
  for (const records of extraGroups.values()) {
    const merged = mergeRaw([...records.filter((record) => record.source === 'projection'), ...records.filter((record) => record.source === 'live')])
    logs.push(normalizeLog(merged, null, logs.length, true))
  }
  return logs
}

function snapshotEntryId(runId = '', taskId = '', query = '') {
  return createHash('sha256')
    .update(`${text(runId)}\u0000${text(taskId)}\u0000${text(query)}`)
    .digest('hex')
    .slice(0, 24)
}

function failureSnapshotQueries(result = {}, entries = []) {
  const sourceLogs = [
    ...(Array.isArray(result.queryLogs) ? result.queryLogs : []),
    ...(Array.isArray(result.priceBreakdown?.queryResults) ? result.priceBreakdown.queryResults : [])
  ]
  const values = [
    ...entries.map((entry) => entry?.query),
    ...sourceLogs.map((log) => log?.query),
    ...(Array.isArray(result.searchKeywords) ? result.searchKeywords : []),
    result.keyword
  ]
  return [...new Set(values.map((value) => text(value)).filter(Boolean))]
}

function ensureFailureSnapshotEntries(result = {}, entries = []) {
  if (result.status === 'success') return entries
  const queries = failureSnapshotQueries(result, entries)
  const known = new Set(entries.map((entry) => text(entry?.query)).filter(Boolean))
  const missingQueries = queries.filter((query) => !known.has(query))
  if (!missingQueries.length) return entries
  const reason = text(result.reason) || '该关键词未保存原始网页快照'
  return [...entries, ...missingQueries.map((query) => ({
    query,
    path: null,
    pageUrl: text(result.pageUrl),
    capturedAt: null,
    viewport: result.snapshotViewport || null,
    snapshotStatus: 'not_captured',
    error: reason,
    cardCount: 0,
    acceptedCount: 0,
    blockedCount: 0,
    nonTargetCount: 0,
    lowPriceCount: 0,
    markedCount: 0,
    unmatchableCount: 0,
    unmappedCount: 0,
    markReasonCodes: [],
    cardSummaries: [],
    compatibility: false
  }))]
}

function escapeSnapshotHtml(value) {
  return text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function diagnosticSnapshotHtml({ entry = {}, log = {}, row = {} } = {}) {
  const query = text(entry.query) || '未记录关键词'
  const reason = text(entry.error) || text(log.error) || text(log.reason) || text(row.reason) || '原始网页快照未保存'
  const status = text(entry.snapshotStatus) || 'not_captured'
  const codes = Array.isArray(log.markReasonCodes) ? log.markReasonCodes.filter(Boolean).slice(0, 20) : []
  const summaries = Array.isArray(log.cardSummaries) ? log.cardSummaries.slice(0, 10) : []
  const metric = (keys) => {
    for (const key of keys) if (log[key] != null && log[key] !== '') return log[key]
    return 0
  }
  const stats = [
    ['卡片', metric(['cardCount', 'cards'])],
    ['通过', metric(['acceptedCount', 'accepted'])],
    ['黑名单', metric(['blockedCount', 'blocked'])],
    ['非目标', metric(['nonTargetCount', 'nonTarget'])],
    ['低价剔除', metric(['lowPriceCount', 'lowPrice'])],
    ['标记', metric(['markedCount', 'marked'])]
  ].map(([label, value]) => `<span><b>${escapeSnapshotHtml(label)}</b> ${escapeSnapshotHtml(value)}</span>`).join('')
  const reasonCodes = codes.length
    ? `<section><b>判定码</b> ${codes.map((code) => `<code>${escapeSnapshotHtml(code)}</code>`).join(' ')}</section>`
    : ''
  const items = summaries.length
    ? `<section><b>卡片摘要（最多10条）</b><ul>${summaries.map((item) => `<li>${escapeSnapshotHtml(item.title || item.itemId || item.itemUrl || '未命名卡片')}</li>`).join('')}</ul></section>`
    : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>快照诊断 · ${escapeSnapshotHtml(query)}</title><style>body{margin:0;padding:28px;background:#f6f8f7;color:#26332d;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{max-width:900px;margin:0 auto;padding:26px 30px;border:1px solid #d9e5de;border-radius:14px;background:#fff;box-shadow:0 8px 30px rgba(25,55,42,.08)}h1{margin:0 0 8px;font-size:24px}.badge{display:inline-block;margin:0 0 18px;padding:4px 10px;border-radius:999px;color:#8f1f28;background:#fff0f1;border:1px solid #ed9aa0;font-weight:700}.warning{padding:14px 16px;border-left:4px solid #d9363e;background:#fff6f6;color:#6f2027}.meta{display:grid;grid-template-columns:120px 1fr;gap:7px 12px;margin:20px 0}.stats{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}.stats span{padding:6px 10px;border-radius:7px;background:#f0f6f2}section{margin-top:18px}code{display:inline-block;margin:4px;padding:3px 7px;border-radius:5px;background:#eef2f0}</style></head><body><main class="card"><h1>快照诊断 · ${escapeSnapshotHtml(query)}</h1><div class="badge">${escapeSnapshotHtml(status)}</div><div class="warning">原始网页快照未保存或不可读取；以下内容来自本次关键词运行日志。</div><div class="meta"><b>商品</b><span>${escapeSnapshotHtml(row.name || row.model || '—')}</span><b>关键词</b><span>${escapeSnapshotHtml(query)}</span><b>判定原因</b><span>${escapeSnapshotHtml(reason)}</span></div><div class="stats">${stats}</div>${reasonCodes}${items}</main></body></html>`
}

function persistDiagnosticSnapshots({ entries = [], logs = [], runId = '', taskId = '', row = {} } = {}) {
  return entries.map((entry) => {
    const log = logs.find((candidate) => candidate.entryId === entry.entryId || (candidate.query && candidate.query === entry.query)) || {}
    if (entry.path) return entry
    const html = diagnosticSnapshotHtml({ entry, log, row })
    const saved = saveSnapshot(html, {
      runId,
      taskId,
      query: entry.query,
      pageUrl: entry.pageUrl || row.pageUrl || '',
      viewport: entry.viewport || row.snapshotViewport || null
    })
    return {
      ...entry,
      path: saved.path,
      capturedAt: saved.capturedAt,
      snapshotStatus: 'diagnostic',
      error: entry.error || log.error || log.reason || null
    }
  })
}

function snapshotPath({ runId = '', taskId = '', query = '' } = {}) {
  mkdirSync(snapshotDir, { recursive: true })
  const stamp = Date.now()
  const id = createHash('sha1').update(`${runId}|${taskId}|${query}|${stamp}`).digest('hex').slice(0, 24)
  return join(snapshotDir, `${id}.html`)
}

function snapshotRecord(filePath, { query = '', pageUrl = '', viewport = null } = {}) {
  const target = resolve(text(filePath))
  const root = resolve(snapshotDir)
  if (!target.startsWith(root + sep) || !existsSync(target)) throw new Error('网页快照不存在或路径无效')
  return { path: target, query, pageUrl, viewport, capturedAt: new Date().toISOString() }
}

function referencedSnapshotPaths() {
  const refs = new Set()
  for (const row of meta.get('runResults') || []) {
    for (const value of snapshotPathsOfResult(row)) {
      const raw = text(value)
      if (raw) refs.add(resolve(raw))
    }
  }
  return refs
}

/**
 * 清理网页快照：删掉已经没有任何结果行引用得到的文件，以及超过保留期的旧文件。
 * 判定在 snapshot-retention.js（纯函数，独立回归），这里只做目录扫描与落盘删除。
 * dryRun 只统计不删，便于先看清会删多少。
 */
export function pruneSnapshots(options = {}) {
  const stats = { scanned: 0, deleted: 0, kept: 0, freedBytes: 0, failed: 0 }
  if (!existsSync(snapshotDir)) return stats

  const entries = []
  for (const name of readdirSync(snapshotDir)) {
    const target = join(snapshotDir, name)
    let stat
    try {
      stat = statSync(target)
    } catch {
      continue  // 扫描期间被别处删掉了
    }
    if (stat.isDirectory() && name.endsWith('_files')) {
      entries.push({ name, path: resolve(target), mtimeMs: stat.mtimeMs, size: 0, kind: 'resourceDir' })
    } else if (stat.isFile() && name.toLowerCase().endsWith('.html')) {
      entries.push({ name, path: resolve(target), mtimeMs: stat.mtimeMs, size: stat.size, kind: 'html' })
      stats.scanned += 1
    }
  }

  const { deleteHtml, deleteDirs, keptCount } = planSnapshotPrune({
    entries,
    referenced: referencedSnapshotPaths(),
    ...options
  })
  stats.kept = keptCount

  for (const entry of deleteHtml) {
    if (!options.dryRun) {
      try {
        unlinkSync(entry.path)
      } catch {
        stats.failed += 1
        continue
      }
    }
    stats.deleted += 1
    stats.freedBytes += entry.size
  }
  for (const dir of deleteDirs) {
    if (options.dryRun) continue
    try {
      rmSync(dir.path, { recursive: true, force: true })
    } catch {
      stats.failed += 1
    }
  }
  return stats
}

/** 为 Electron savePage 分配一个应用内 HTML 路径。该 API 会额外保存图片、CSS 等资源。 */
export function createSnapshotPath({ runId = '', taskId = '', query = '' } = {}) {
  return snapshotPath({ runId, taskId, query })
}

/** 保存某次搜索结束时真实网页的 DOM 快照，供 savePage 失败时兜底使用。 */
export function saveSnapshot(html, { runId = '', taskId = '', query = '', pageUrl = '', viewport = null } = {}) {
  if (!html || typeof html !== 'string') throw new Error('网页快照内容为空')
  const filePath = snapshotPath({ runId, taskId, query })
  writeFileSync(filePath, html, 'utf8')
  return snapshotRecord(filePath, { query, pageUrl, viewport })
}

/** 登记 Electron savePage 已经写入的完整网页快照。 */
export function registerSnapshot(filePath, { query = '', pageUrl = '', viewport = null } = {}) {
  return snapshotRecord(filePath, { query, pageUrl, viewport })
}

/**
 * 只读取当前应用或明确白名单内旧应用生成的快照；兼容早期图片快照。
 * 旧目录兼容是为任务中心迁移保留的，不能退化成任意绝对路径读取。
 */
export function readSnapshot(filePath) {
  const { target, legacy } = resolveReadableSnapshot(filePath)
  if (extname(target).toLowerCase() === '.html') {
    return { ok: true, kind: 'html', path: target, url: pathToFileURL(target).href, legacy }
  }
  const mimeByExtension = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif'
  }
  const mime = mimeByExtension[extname(target).toLowerCase()] || 'application/octet-stream'
  return {
    ok: true,
    kind: 'image',
    path: target,
    legacy,
    dataUrl: `data:${mime};base64,${readFileSync(target).toString('base64')}`
  }
}

/** 给错误 HTML 快照加醒目的标记和可追溯原因；采购价围栏不能伪装成“低于100元”。 */
export function markSnapshotPriceError(paths = [], price = '', options = {}) {
  const config = typeof options === 'string' ? { reason: options } : (options || {})
  const kind = text(config.kind || 'minimum_price')
  const isPurchaseFence = kind === 'purchase_price_fence'
  const safePrice = text(price).replace(/[^0-9.]/g, '').slice(0, 20)
  const escapeHtml = (value) => text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
  const defaultReason = isPurchaseFence
    ? `抓取价格 ¥${safePrice || '未知'} 未通过采购价围栏判定`
    : `系统判定价格低于 100 元，请更正型号后重新扫码`
  const reason = escapeHtml(config.reason || defaultReason).slice(0, 500)
  const watermark = isPurchaseFence ? '采购价围栏' : '价格错误'
  const root = resolve(snapshotDir)
  const style = `<style data-xianyu-price-error>
  .xianyu-price-error-watermark{position:fixed;top:24px;right:28px;z-index:2147483647;pointer-events:none;padding:10px 18px;border:4px solid #d9363e;border-radius:8px;color:#d9363e;background:rgba(255,246,246,.92);font:800 30px/1.1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:2px;transform:rotate(-10deg);box-shadow:0 4px 16px rgba(120,20,25,.2)}
  .xianyu-price-error-banner{position:fixed;left:0;right:0;top:0;z-index:2147483646;pointer-events:none;padding:7px 18px;color:#8f1f28;background:rgba(255,232,234,.96);border-bottom:2px solid #ed9aa0;text-align:center;font:700 15px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  </style>`
  const marker = `<div class="xianyu-price-error-banner">${reason}</div><div class="xianyu-price-error-watermark">${escapeHtml(watermark)}</div>`
  let updated = 0
  for (const filePath of [...new Set(paths.filter(Boolean))]) {
    const target = resolve(text(filePath))
    if (!target.startsWith(root + sep) || extname(target).toLowerCase() !== '.html' || !existsSync(target)) continue
    let html = readFileSync(target, 'utf8')
    if (html.includes('data-xianyu-price-error')) continue
    html = html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : `${style}${html}`
    html = html.includes('</body>') ? html.replace('</body>', `${marker}</body>`) : `${html}${marker}`
    writeFileSync(target, html, 'utf8')
    updated++
  }
  return { ok: true, updated }
}

/**
 * HTMLComplete 有时不会保留运行时注入的卡片 class；保存完成后只按
 * 保存前同一份 query-scoped decisionMap 补回标记。这里绝不读取卡片
 * innerText，也不按 snapshotPaths 的数组位置或型号文本重新判定。
 */
export function markSnapshotNonTarget(snapshotEntry = [], { decisionMap = null } = {}) {
  const entries = Array.isArray(snapshotEntry)
    ? snapshotEntry.map((path) => ({ path }))
    : [snapshotEntry]
  const lookup = decisionMap?.byKey && typeof decisionMap.byKey === 'object' ? decisionMap.byKey : {}
  if (!Object.keys(lookup).length) return { ok: true, updated: 0, marked: 0, reason: 'decision_map_missing' }
  const root = resolve(snapshotDir)
  const style = `<style data-xianyu-snapshot-non-target>
  [data-xianyu-non-target="true"]{position:relative!important}
  [data-xianyu-non-target="true"]::before{content:"";position:absolute;left:0;right:0;top:0;height:62%;z-index:2147483645;border:2px solid rgba(110,118,126,.72);border-radius:8px;background:linear-gradient(45deg,transparent 47%,rgba(110,118,126,.66) 49%,rgba(110,118,126,.66) 51%,transparent 53%),linear-gradient(-45deg,transparent 47%,rgba(110,118,126,.66) 49%,rgba(110,118,126,.66) 51%,transparent 53%),rgba(110,118,126,.12);box-sizing:border-box;pointer-events:none}
  [data-xianyu-non-target="true"]::after{content:attr(data-xianyu-reason-code);position:absolute;right:8px;top:8px;z-index:2147483646;padding:4px 7px;border:1px solid rgba(255,255,255,.75);border-radius:4px;color:#fff;background:rgba(91,101,110,.84);font:700 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none}
  </style>`
  const normalizeUrl = (value) => {
    try {
      const url = new URL(String(value || ''), 'https://www.goofish.com')
      url.hash = ''
      return url.href
    } catch {
      return String(value || '')
    }
  }
  const attrValue = (attrs, name) => {
    const match = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
    return match ? match[1] : ''
  }
  const decodeHtml = (value) => String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  const keysFor = (attrs) => {
    const href = decodeHtml(attrValue(attrs, 'href') || attrValue(attrs, 'data-item-url'))
    const dataId = attrValue(attrs, 'data-item-id') || attrValue(attrs, 'data-id')
    let idFromUrl = ''
    try {
      const url = new URL(href, 'https://www.goofish.com')
      idFromUrl = url.searchParams.get('id') || url.searchParams.get('itemId') || (url.pathname.match(/\/(?:item|detail)\/?([^/?#]+)/i) || [])[1] || ''
    } catch {
      /* keep the data attribute path only */
    }
    const keys = []
    if (dataId || idFromUrl) keys.push(`id:${String(dataId || idFromUrl).trim()}`)
    const canonical = normalizeUrl(href)
    if (canonical && canonical !== 'https://www.goofish.com/') keys.push(`url:${canonical}`)
    return [...new Set(keys)]
  }
  const resolveRecord = (keys) => {
    const urlKey = keys.find((key) => key.startsWith('url:'))
    if (urlKey && lookup[urlKey]) return lookup[urlKey]
    const idKey = keys.find((key) => key.startsWith('id:'))
    return idKey && lookup[idKey] ? lookup[idKey] : null
  }
  let updated = 0
  let marked = 0
  let matched = 0
  let unmatchable = 0
  for (const entry of entries) {
    const filePath = entry?.path
    const target = resolve(text(filePath))
    if (!target.startsWith(root + sep) || extname(target).toLowerCase() !== '.html' || !existsSync(target)) continue
    let html = readFileSync(target, 'utf8')
    const before = html
    html = html.replace(/<a\b([^>]*feeds-item-wrap[^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
      const record = resolveRecord(keysFor(attrs))
      if (!record) {
        unmatchable++
        return full
      }
      matched++
      const reasonCode = text(record.reasonCode) || 'accepted'
      if (reasonCode === 'accepted' || reasonCode === 'unpriced_card') {
        return full
          .replace(/\sdata-xianyu-(?:non-target|reason-code|decision)="[^"]*"/gi, '')
          .replace(/\sclass="([^"]*)"/i, (_, className) => {
            const clean = className.split(/\s+/).filter((name) => name && name !== 'xianyu-blacklist-card').join(' ')
            return ` class="${clean}"`
          })
      }
      marked++
      return `<a${attrs} data-xianyu-non-target="true" data-xianyu-decision="${text(record.decision) || 'rejected'}" data-xianyu-reason-code="${reasonCode}">${inner}</a>`
    })
    if (html !== before) {
      if (!html.includes('data-xianyu-snapshot-non-target')) {
        html = html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : `${style}${html}`
      }
      writeFileSync(target, html, 'utf8')
      updated++
    }
  }
  return { ok: true, updated, marked, matched, unmatchable }
}

/** 导出低价错误任务，供员工更正型号并重新扫码确认。 */
export function exportInvalidPrices({ runId = null, outputPath } = {}) {
  if (!outputPath) throw new Error('未指定错误 Excel 保存路径')
  const seenTaskIds = new Set()
  const rows = (meta.get('runResults') || [])
    .filter((row) => (row.status === 'invalid_price' || Number(row.price) < 100) && (!runId || row.runId === runId))
    .filter((row) => {
      const key = row.taskId || `${row.brand || ''}|${row.model || ''}|${row.keyword || ''}`
      if (seenTaskIds.has(key)) return false
      seenTaskIds.add(key)
      return true
    })
    .map((row) => ({
      错误类型: '价格低于100元',
      品牌: row.brand || '',
      型号: row.model || '',
      尺寸: row.size || '',
      规格: row.spec || '',
      原关键词: row.keyword || '',
      实际搜索词: Array.isArray(row.searchKeywords) ? row.searchKeywords.join('；') : '',
      抓取价格: row.price ?? '',
      错误原因: row.reason || '历史结果低于100元，按新规则判定为错误价格',
      账号: row.account || '',
      采集时间: row.at || '',
      ['员工更正品牌']: '',
      ['员工更正型号']: '',
      扫码确认: '',
      处理备注: ''
    }))
  if (!rows.length) throw new Error('当前没有低于100元的错误价格')
  const sheet = XLSX.utils.json_to_sheet(rows)
  sheet['!cols'] = [
    { wch: 18 }, { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 22 }, { wch: 24 },
    { wch: 28 }, { wch: 12 }, { wch: 42 }, { wch: 16 }, { wch: 22 }, { wch: 18 },
    { wch: 22 }, { wch: 12 }, { wch: 24 }
  ]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '错误型号')
  XLSX.writeFile(workbook, outputPath)
  return { ok: true, path: outputPath, count: rows.length }
}

const WMS_STATUS_LABEL = {
  success: '成功',
  empty: '无在售',
  fail: '失败',
  invalid_price: '错误价格',
  risk_control: '风控暂停'
}

/** 导出 API-SPU 关联证据：一个任务 SPU 一行，不导出任何旧匹配/候选字段。 */
export function exportWmsMapping({ outputPath } = {}) {
  if (!outputPath) throw new Error('未指定对应表保存路径')
  const tasks = getActiveTasks({ includeDisabled: true })
  if (!tasks.length) throw new Error('当前没有可导出的任务清单')
  const rows = tasks.map((task) => ({
    品牌: task.brand || '',
    型号: task.model || '',
    [TASK_ALIAS_COLUMN]: task.effectiveAlias || '',
    别称来源: task.aliasSource === 'manual' ? '人工填写' : (task.aliasSource === 'spu' ? 'SPU读取' : ''),
    尺寸: task.size || '',
    规格: task.spec || '',
    分类: task.category || '未分类',
    ['任务SPU编码']: task.spuCode || task.spu_code || '',
    ['API SKU/序列号']: task.apiSkuCode || task.wmsSkuCode || '',
    ['API SPU编码']: task.apiSpuCode || task.wmsSpuCode || '',
    ['API型号']: task.apiModel || task.wmsModel || '',
    ['API品牌']: task.apiBrand || task.wmsBrand || '',
    ['API商品名原文']: task.apiProductName || task.apiSpuProductName || task.wmsProductName || '',
    ['API规格']: task.apiSpec || '',
    ['API当前销售价']: task.apiSalePrice || '',
    ['API建议售价']: task.apiSuggestPrice || '',
    ['SPU关联状态']: task.apiSpuAssociationStatus || 'api_not_synced',
    ['SPU关联百分比']: task.apiSpuAssociationPercent ?? '',
    ['API数据质量']: task.apiSpuDataQualityStatus || 'unknown',
    ['API数据冲突']: task.apiDataConflict ? '是' : '否',
    ['API SKU数量']: task.apiSkuCount || 0,
    最新行情价: task.lastPrice ?? '',
    行情状态: WMS_STATUS_LABEL[task.lastStatus] || '未采集',
    采集时间: task.lastRunAt || '',
    采购价: task.referencePrice ?? ''
  }))
  const sheet = XLSX.utils.json_to_sheet(rows)
  sheet['!cols'] = [
    { wch: 12 }, { wch: 22 }, { wch: 32 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 10 }, { wch: 18 },
    { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 38 }, { wch: 22 },
    { wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
    { wch: 22 }, { wch: 12 }
  ]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '行情WMS对应表')
  XLSX.writeFile(workbook, outputPath)
  return { ok: true, path: outputPath, count: rows.length, associated: rows.filter((row) => row['SPU关联状态'] === 'exact').length }
}

export function finishRun(runId, patch = {}) {
  const runs = meta.get('runs') || []
  const nextRuns = runs.map((run) =>
    run.id === runId
      ? { ...run, ...patch, status: patch.status || (patch.stopped ? 'stopped' : 'done'), finishedAt: new Date().toISOString() }
      : run
  )
  meta.set('runs', nextRuns)
  invalidateTaskCenterSnapshot()
  return nextRuns.find((run) => run.id === runId) || null
}

export function getRuns({ page = 1, pageSize = 20 } = {}) {
  const rows = getTaskCenterSnapshot().runs
  const total = rows.length
  const start = Math.max(0, (Number(page) - 1) * Number(pageSize))
  return { items: rows.slice(start, start + Number(pageSize)), total }
}

export function getRankings({ limit = 8, order = 'asc' } = {}) {
  const latest = new Map()
  for (const row of getTaskCenterSnapshot().runResults) {
    if (latest.has(row.taskId)) continue
    latest.set(row.taskId, row)
  }
  const rows = [...latest.values()]
    .filter((row) => row.status === 'success' && row.price != null && Number(row.price) >= 100)
    .sort((a, b) => (Number(a.price) - Number(b.price)) * (order === 'desc' ? -1 : 1))
  return rows.slice(0, Number(limit)).map((row, index) => ({ rank: index + 1, ...row }))
}

export function getRunResults({ page = 1, pageSize = 50, q = '', status = null, group = 'all', priceBand = null } = {}) {
  const snapshot = getTaskCenterSnapshot()
  const taskMap = buildTaskMap(snapshot)
  const currentTaskMap = new Map(getUnifiedTasks({ snapshot, includeDisabled: true }).map((task) => [task.id, task]))
  // Enrich every historical attempt before filtering. Older rows may not have
  // carried a purchase price (or a comparison at all), so filtering the raw
  // history first would make a valid price-band query silently miss them.
  let rows = snapshot.runResults
    .map((row) => refreshHistoryApiSnapshot(row, snapshot, currentTaskMap))
    .map((row) => withPriceComparison(ensureSnapshotHistory(row), taskMap))
    .map((row) => {
      const task = currentTaskMap.get(row.taskId)
      if (!task) return row
      return {
        ...row,
        spuSearchPolicy: task.spuSearchPolicy ? { ...task.spuSearchPolicy } : null,
        effectiveSearchPolicy: task.effectiveSearchPolicy ? { ...task.effectiveSearchPolicy, queries: [...(task.effectiveSearchPolicy.queries || [])] } : null,
        effectiveBlacklist: task.effectiveBlacklist ? { ...task.effectiveBlacklist, terms: [...(task.effectiveBlacklist.terms || [])] } : null,
        effectivePriceFence: task.effectivePriceFence ? { ...task.effectivePriceFence } : null,
        effectivePageFilter: task.effectivePageFilter ? { ...task.effectivePageFilter } : null,
        localizedDisplayName: task.localizedDisplayName || row.name || task.name,
        localizedDisplayNameSource: task.localizedDisplayNameSource || 'task_name'
      }
    })
  const query = text(q).toLowerCase()
  if (status) rows = rows.filter((row) => row.status === status)
  if (query) rows = rows.filter((row) => [row.name, row.keyword, row.category, row.brand, row.model, row.account].some((value) => text(value).toLowerCase().includes(query)))
  if (priceBand) rows = rows.filter((row) => row.priceComparison?.key === priceBand)
  const groupCounts = { all: rows.length, failed: 0, pending: 0, success: 0, review: 0 }
  for (const row of rows) {
    const displayGroup = runResultGroup(row, currentTaskMap.get(row.taskId) || taskMap.get(row.taskId))
    if (Object.hasOwn(groupCounts, displayGroup)) groupCounts[displayGroup] += 1
  }
  if (isRunResultGroup(group) && group !== 'all') {
    rows = rows.filter((row) => {
      const displayGroup = runResultGroup(row, currentTaskMap.get(row.taskId) || taskMap.get(row.taskId))
      return group === 'attention' ? ['failed', 'review'].includes(displayGroup) : displayGroup === group
    })
  }
  const total = rows.length
  const start = Math.max(0, (Number(page) - 1) * Number(pageSize))
  return {
    items: rows.slice(start, start + Number(pageSize)),
    total,
    groupCounts
  }
}

const RUN_RESULT_GROUPS = new Set(['all', 'failed', 'pending', 'success', 'review', 'attention'])

function isRunResultGroup(value) {
  return RUN_RESULT_GROUPS.has(String(value || 'all'))
}

/**
 * Historical rows use their persisted status, while the active task remains
 * authoritative for AI review/correction state. This is deliberately a
 * display-only aggregation: it never changes row.status or queueKind.
 */
function runResultGroup(row = {}, task = null) {
  const queueKind = row.queueKind || queueKeyForStatus(row.status)
  const aiState = {
    ...row,
    // Prefer the current task's AI state when present; old result rows can
    // otherwise appear successful after a task was sent to human review.
    aiCorrectionStatus: task?.aiCorrectionStatus ?? row.aiCorrectionStatus,
    aiReviewStatus: task?.aiReviewStatus ?? row.aiReviewStatus,
    queueKind
  }
  if (isReviewRow(aiState)) return 'review'
  if (isFailedRow(aiState) || needsAiCorrection(aiState)) return 'failed'
  if (row.status === 'success') return 'success'
  // A persisted pending row is unusual (the queue normally represents this
  // state), but if one exists it remains queryable without fabricating rows.
  if (row.status === 'pending') return 'pending'
  // Unknown/failed historical statuses are safer to surface as attention than
  // to hide them from the broad anomaly view.
  return 'failed'
}

function withPriceComparison(row, taskMap) {
  const task = taskMap?.get(row.taskId) || null
  const referencePrice = row.referencePrice ?? task?.referencePrice ?? null
  const referencePriceStatus = row.referencePriceStatus || task?.referencePriceStatus || (referencePrice == null ? 'missing' : 'valid')
  const referencePriceReason = row.referencePriceReason || task?.referencePriceReason || ''
  const persistedComparisonHasPurchase = row.priceComparison?.purchasePrice != null
  const priceComparison = (row.priceComparison && (referencePrice == null || persistedComparisonHasPurchase)) ? row.priceComparison : priceComparisonFor({
    ...row,
    referencePrice,
    referencePriceStatus,
    referencePriceReason
  }, task)
  return {
    ...row,
    referencePrice,
    referencePriceStatus,
    referencePriceReason,
    priceComparison,
    priceBand: row.priceBand || priceComparison.key,
    priceReason: row.priceReason || priceComparison.reason
  }
}

// API 销售价属于当前库存主数据，不是一次行情抓取的历史快照。历史查询
// 每次都用最近一次有效 WMS 缓存重新装饰，避免库存价格更新后页面继续显示旧值。
function clearCurrentApiSnapshot(row = {}, snapshot = getTaskCenterSnapshot(), status = 'spu_not_found', reason = '') {
  // Keep the last API payload as auditable evidence while making every field
  // labelled as the *current* association unavailable. This matters when a
  // successful sync is followed by an empty cache or a vanished SPU.
  const historicalApiEvidence = row.historicalApiEvidence || {
    spuCode: row.apiSpuCode ?? null,
    skuCode: row.apiSkuCode ?? null,
    skuCodes: Array.isArray(row.apiSkuCodes) ? row.apiSkuCodes : [],
    brand: row.apiBrand ?? null,
    model: row.apiModel ?? null,
    productName: row.apiProductName ?? row.apiSpuProductName ?? null,
    spec: row.apiSpec ?? null,
    salePrice: row.apiSalePrice ?? null,
    salePriceValues: Array.isArray(row.apiSalePriceValues) ? row.apiSalePriceValues : [],
    suggestPrice: row.apiSuggestPrice ?? null,
    suggestPriceValues: Array.isArray(row.apiSuggestPriceValues) ? row.apiSuggestPriceValues : [],
    dataQualityStatus: row.apiSpuDataQualityStatus ?? null,
    syncedAt: row.apiSnapshotSyncedAt ?? null
  }
  return {
    ...row,
    historicalApiEvidence,
    historicalApiAssociationStatus: row.historicalApiAssociationStatus ?? row.apiSpuAssociationStatus ?? null,
    historicalApiAssociationReason: row.historicalApiAssociationReason ?? row.apiSpuAssociationReason ?? '',
    historicalApiSpuCode: row.historicalApiSpuCode ?? row.apiSpuCode ?? null,
    historicalApiSalePrice: row.historicalApiSalePrice ?? row.apiSalePrice ?? null,
    historicalApiSuggestPrice: row.historicalApiSuggestPrice ?? row.apiSuggestPrice ?? null,
    historicalApiProductName: row.historicalApiProductName ?? row.apiProductName ?? row.apiSpuProductName ?? null,
    apiSpuAssociated: false,
    apiSpuAssociationStatus: status,
    apiSpuAssociationPercent: null,
    apiSpuAssociationReason: reason || `当前 API 中不存在 SPU：${text(row.spuCode || row.spu_code)}`,
    apiSpuDataQualityStatus: 'unknown',
    apiSkuCode: null,
    apiSkuCodes: [],
    apiSkuCount: 0,
    apiSpuCode: null,
    apiBrand: null,
    apiModel: null,
    apiProductName: null,
    apiSpuProductName: null,
    apiSpuCleanedAlias: null,
    apiSpuAlias: null,
    apiSpuAliasUsed: false,
    apiSpec: null,
    apiSalePrice: null,
    apiSalePriceValues: [],
    apiSuggestPrice: null,
    apiSuggestPriceValues: [],
    apiDataConflict: false,
    apiSnapshotSyncedAt: snapshot.wmsSyncedAt || null
  }
}

function refreshHistoryApiSnapshot(row = {}, snapshot = getTaskCenterSnapshot(), currentTaskMap = null) {
  const spuCode = text(row.spuCode || row.spu_code)
  if (!spuCode) return row
  // A historical mismatch is retained as evidence while the current API
  // fields are allowed to recover when the same SPU appears in a later sync.
  const historicalMismatch = row.apiSpuAssociationStatus && row.apiSpuAssociationStatus !== 'exact'
    ? {
        historicalApiAssociationStatus: row.historicalApiAssociationStatus ?? row.apiSpuAssociationStatus,
        historicalApiAssociationReason: row.historicalApiAssociationReason ?? row.apiSpuAssociationReason ?? '',
        historicalApiSpuCode: row.historicalApiSpuCode ?? row.apiSpuCode ?? null,
        historicalApiProductName: row.historicalApiProductName ?? row.apiProductName ?? row.apiSpuProductName ?? null,
        historicalApiSalePrice: row.historicalApiSalePrice ?? row.apiSalePrice ?? null,
        historicalApiSuggestPrice: row.historicalApiSuggestPrice ?? row.apiSuggestPrice ?? null
      }
    : {}
  const catalog = snapshot.wmsSpuCatalog || { items: [] }
  const hadCurrentAssociation = row.apiSpuAssociationStatus === 'exact'
    || row.apiSpuAssociated === true
    || row.apiSpuCode
    || row.apiSalePrice != null
    || row.apiSuggestPrice != null
  // Without a sync timestamp, an old catalog (including one with rows but a
  // missing target) is not evidence that the SPU disappeared. Preserve the
  // historical current fields and expose the source as not yet synced.
  if (!text(snapshot.wmsSyncedAt)) {
    if (!hadCurrentAssociation) return row
    return {
      ...row,
      apiSpuAssociationStatus: 'api_not_synced',
      apiSpuAssociationReason: 'API-SPU 尚未同步'
    }
  }
  if (!catalog.items.length) {
    if (!hadCurrentAssociation) return row
    return clearCurrentApiSnapshot(row, snapshot, 'spu_not_found', `当前 API 缓存为空，无法确认 SPU：${spuCode}`)
  }
  const current = wmsMatchSummary({ spuCode }, catalog)
  if (!current.associated) {
    return clearCurrentApiSnapshot(row, snapshot, 'spu_not_found', `当前 API 中不存在 SPU：${spuCode}`)
  }
  const currentTask = currentTaskMap?.get(row.taskId) || null
  return {
    ...row,
    ...historicalMismatch,
    apiSpuAssociated: true,
    apiSpuAssociationStatus: current.associationStatus,
    apiSpuAssociationPercent: current.associationPercent,
    apiSpuAssociationReason: current.reason || '',
    apiSpuDataQualityStatus: current.dataQualityStatus || 'unknown',
    apiSkuCode: current.sku_code || null,
    apiSkuCodes: Array.isArray(current.sku_codes) ? current.sku_codes : [],
    apiSkuCount: Number(current.sku_count) || 0,
    apiSpuCode: current.spu_code || null,
    apiBrand: current.brand || null,
    apiModel: current.model || null,
    apiProductName: current.product_name || null,
    apiSpuProductName: current.product_name || null,
    apiSpec: current.spec || null,
    apiSalePrice: current.sale_price || null,
    apiSalePriceValues: Array.isArray(current.sale_price_values) ? current.sale_price_values : [],
    apiSuggestPrice: current.suggest_price || null,
    apiSuggestPriceValues: Array.isArray(current.suggest_price_values) ? current.suggest_price_values : [],
    apiDataConflict: Boolean(current.api_data_conflict),
    apiSnapshotSyncedAt: snapshot.wmsSyncedAt || null,
    aiReviewStatus: currentTask?.aiReviewStatus ?? row.aiReviewStatus,
    aiCorrectionAt: currentTask?.aiCorrectionAt ?? row.aiCorrectionAt,
    lastStatus: currentTask?.lastStatus ?? row.lastStatus,
    lastRunAt: currentTask?.lastRunAt ?? row.lastRunAt
  }
}

function ensureSnapshotHistory(row = {}) {
  const entries = normalizeSnapshotEntries(row)
  const logs = normalizeQueryLogs(row, entries)
  const hasEntries = Array.isArray(row.snapshotEntries) && row.snapshotEntries.length > 0
  const hasLogs = Array.isArray(row.queryLogs) && row.queryLogs.length > 0
  const sameEntries = hasEntries && entries.length === row.snapshotEntries.length
    && entries.every((entry, index) => text(entry.entryId) === text(row.snapshotEntries[index]?.entryId)
      && text(entry.path) === text(row.snapshotEntries[index]?.path)
      && text(entry.query) === text(row.snapshotEntries[index]?.query)
      && text(entry.snapshotStatus) === text(row.snapshotEntries[index]?.snapshotStatus))
  const sameLogs = hasLogs && logs.length === row.queryLogs.length
    && logs.every((log, index) => {
      const persisted = row.queryLogs[index] || {}
      return text(log.entryId) === text(persisted.entryId)
        && text(log.query) === text(persisted.query)
        && text(log.path) === text(persisted.path)
        && text(log.snapshotStatus) === text(persisted.snapshotStatus)
        && Boolean(log.logOnly) === Boolean(persisted.logOnly)
    })
  if (sameEntries && sameLogs) return row
  return { ...row, snapshotEntries: entries, queryLogs: logs }
}

export function getDataPath() {
  return meta.path
}

// ---------- 公司 WMS 型号缓存（与任务中心同库，避免额外依赖 Electron 主进程 store） ----------
export const getWmsSkus = () => getTaskCenterSnapshot().wmsSkus
export const setWmsSkus = (list) => {
  meta.set('wmsSkus', Array.isArray(list) ? list : [])
  invalidateTaskCenterSnapshot()
}
export const getWmsSyncedAt = () => meta.get('wmsSyncedAt') || null
export const setWmsSyncedAt = (value) => {
  meta.set('wmsSyncedAt', value || null)
  invalidateTaskCenterSnapshot()
}
// WMS 同步成功后一次性替换库存与时间戳，避免渲染层在两次 set 之间观察到
// “新 SKU + 旧时间”或“旧 SKU + 新时间”的半完成状态。
export const replaceWmsCache = (list, syncedAt) => {
  return replaceWmsSnapshot(list, syncedAt)
}

export const getWmsSyncState = () => {
  const value = meta.get('wmsSyncState')
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export const setWmsSyncState = (state = {}) => {
  const current = getWmsSyncState() || {}
  meta.set('wmsSyncState', {
    ...current,
    ...state,
    counts: { ...(current.counts || {}), ...(state.counts || {}) }
  })
  invalidateTaskCenterSnapshot()
  return getWmsSyncState()
}

/**
 * Persist a complete cache and its metadata through one task-store boundary.
 * electron-store still serializes the file itself, while callers cannot
 * accidentally publish a new timestamp without the corresponding snapshot.
 */
export const replaceWmsSnapshot = (list, syncedAt, syncState = {}) => {
  const rows = Array.isArray(list) ? list : []
  const snapshotHash = text(syncState.snapshotHash) || apiSpuSnapshotHash(rows)
  const nextLedger = updateApiSpuLedger(rows, syncedAt, snapshotHash)
  const previousState = getWmsSyncState() || {}
  // The compatibility cache writer is also used by offline fixtures and by
  // the successful REST/MCP sync path.  A non-empty success timestamp must
  // publish a connected state; leaving the default `unconfigured` status here
  // makes a valid last-good cache look like a first-run/no-source state.
  const effectiveStatus = text(syncState.status) || (syncedAt ? 'synced' : text(previousState.status) || 'unconfigured')
  meta.set('wmsSkus', rows)
  meta.set('wmsSyncedAt', syncedAt || null)
  if (syncedAt) meta.set('apiSpuLedger', nextLedger)
  meta.set('wmsSyncState', {
    ...previousState,
    ...syncState,
    status: effectiveStatus,
    snapshotHash,
    lastSuccessAt: syncState.lastSuccessAt || syncedAt || null,
    counts: { ...(getWmsSyncState()?.counts || {}), ...(syncState.counts || {}), skuTotal: rows.length }
  })
  invalidateTaskCenterSnapshot()
  return { wmsSkus: getWmsSkus(), wmsSyncedAt: getWmsSyncedAt(), wmsSyncState: getWmsSyncState() }
}

/**
 * Persist only a listing price after the remote GET-after-PUT verification
 * succeeds.  This map is keyed by exact SPU and never overwrites inventory
 * sale_price or suggest_price facts.
 */
export function updateWmsListingPrice({ skuCode, spuCode, price, updatedAt = null, version = null, etag = null } = {}) {
  const sku = text(skuCode)
  const spu = canonicalSpu(spuCode)
  const numericPrice = Number(price)
  if (!sku || !spu || !Number.isFinite(numericPrice) || numericPrice <= 0) {
    return { ok: false, reason: 'listing 价格缓存缺少 SKU/SPU/有效价格' }
  }
  const current = meta.get('apiListingPrices') && typeof meta.get('apiListingPrices') === 'object'
    ? { ...meta.get('apiListingPrices') }
    : {}
  current[spu] = {
    skuCode: sku,
    spuCode: spu,
    price: numericPrice,
    updatedAt: updatedAt || null,
    version: version == null ? null : String(version),
    etag: etag == null ? null : String(etag),
    verifiedAt: new Date().toISOString()
  }
  meta.set('apiListingPrices', current)
  invalidateTaskCenterSnapshot()
  return { ok: true, item: current[spu] }
}

export function getWmsListingPrice(spuCode) {
  const key = canonicalSpu(spuCode)
  if (!key) return null
  const values = meta.get('apiListingPrices')
  return values && typeof values === 'object' && !Array.isArray(values) ? values[key] || null : null
}

export function hasPriceApplyIdempotency(idempotencyKey) {
  const key = text(idempotencyKey)
  if (!key) return false
  const groups = meta.get('priceApplyAudits')
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return false
  return Object.values(groups).flatMap((rows) => Array.isArray(rows) ? rows : []).some((row) => text(row?.idempotencyKey) === key && row?.status === 'success')
}

export function appendPriceApplyAudit({ taskId, audit } = {}) {
  const id = text(taskId)
  if (!id || !audit || typeof audit !== 'object') return { ok: false, reason: '价格回写审计缺少任务或记录' }
  const groups = meta.get('priceApplyAudits') && typeof meta.get('priceApplyAudits') === 'object'
    ? { ...meta.get('priceApplyAudits') }
    : {}
  const rows = Array.isArray(groups[id]) ? groups[id] : []
  groups[id] = [...rows, { ...audit, taskId: id }].slice(-50)
  meta.set('priceApplyAudits', groups)
  invalidateTaskCenterSnapshot()
  return { ok: true, audit: groups[id].at(-1), count: groups[id].length }
}

export function getPriceApplyAudits(taskId) {
  const id = text(taskId)
  const groups = meta.get('priceApplyAudits')
  return groups && typeof groups === 'object' && !Array.isArray(groups) && Array.isArray(groups[id])
    ? groups[id].slice(-50)
    : []
}
