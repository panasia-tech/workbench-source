import { appendFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { basename, isAbsolute, join } from 'path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron'
import { isPrimaryInstance, focusMainWindow } from './instance.js'
import * as api from './api.js'
import * as scheduler from './scheduler.js'
import * as sellerScheduler from './seller-scheduler.js'
import * as sellerStore from './seller-store.js'
import { destroySellerWorkers } from './seller-worker.js'
import * as sm from './session-manager.js'
import * as store from './store.js'
import * as taskStore from './task-store.js'
import * as workbenchDevice from './workbench-device.js'
import * as vaultAds from './vault-ads.js'
import * as llmAlias from './llm-alias.js'
import * as wms from './wms.js'
import { createPriceCandidatePreview, selectPriceCandidate } from './price-candidate.js'
import { migrateTaskStoreWmsState } from './wms-persistence.js'
import { getWmsSyncService } from './wms-sync-service.js'
import * as codeUpdate from './code-update.js'
import { normalizeSpuSearchPolicy } from '../shared/spu-search-policy.js'
import { evaluateSchedule, SELLER_TIMEZONE } from './seller-schedule.js'
import { hasAuthenticatedXianyuCookies } from './xianyu-auth.js'
import {
  adsPowerHealth,
  closeAllAdsPowerWebContents,
  closeAdsPowerWebContents,
  createEnv,
  deleteEnvs,
  getAdsPowerWebContents,
  getDirectApiUrl,
  setDirectApiUrl,
  hasAuthenticatedAdsPowerSession,
  isAdsPowerAccount,
  listAdsPowerProfiles,
  listEnvs,
  listEnvPurposes,
  listExecutors,
  openAdsPowerProfile,
  removeEnvPurpose,
  saveEnvPurpose,
  startExecutorFor,
  stopExecutorFor,
  probeEnvLogin,
  setEnvPurpose,
  startEnv,
  stopEnv
} from './adspower.js'
import { createLocalExecutor, executorDirCandidates } from './executor-local.js'
import { installExecutor, fetchLatestExecutorPackage, writeProdConfig } from './executor-install.js'
import { fetchExecutorCodeManifest, syncExecutorCode, updateExecutors } from './executor-code.js'
import { createPlanStore, pauseForRestart, resumeAfterPause, waitForAdsPower } from './restart-pause.js'
import { shopsForEnv } from './env-shops.js'
import * as XLSX from 'xlsx'
import { installFileLogging, logSummary, startLogAgent } from './local-logs.js'

// 文件日志要在所有模块干活之前装好——装晚了，启动阶段的报错就只留在控制台里，
// 而操作员那边根本没有控制台。
installFileLogging()

// session-manager is also exercised by a pure Node data-URL regression.  A
// late-bound bridge keeps that test independent from Electron/AdsPower
// while the real main process gets the adapter before any IPC handler runs.
globalThis.__xianyuAdsPower = {
  adsPowerHealth,
  closeAllAdsPowerWebContents,
  closeAdsPowerWebContents,
  getAdsPowerWebContents,
  hasAuthenticatedAdsPowerSession,
  isAdsPowerAccount,
  listAdsPowerProfiles,
  openAdsPowerProfile
}

let win = null
let tray = null
let isQuiting = false
let quitCleanupDone = false
let quitCleanupPromise = null
let sellerRuntime = null
const aiWebSearchInFlight = new Map()

// 第二个实例在拿到锁失败时立即退出；第一个实例把已有窗口叫到前面。
if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      focusMainWindow(() => win)
    } else if (app.isReady()) {
      // 窗口被关掉只剩下托盘时，再点一次图标应该把主窗口建回来
      createWindow()
    }
  })
}

let authExpiredNotifiedAt = 0

/**
 * 群控/ERP 返回 401 时统一收口：清掉本地登录态、通知所有窗口回登录页。
 * 本地配置写不进去也照样通知——退出登录/重新登录不能被文件锁卡死。
 */
function notifyAuthExpired(detail = '登录已过期，请重新登录') {
  if (store.getLocalMode()) return
  const now = Date.now()
  if (now - authExpiredNotifiedAt < 3000) return
  authExpiredNotifiedAt = now
  try {
    store.clearAuth()
  } catch (error) {
    // 清本地登录态失败也必须继续通知窗口；日志本身再失败也不能挡住回登录页。
    try {
      logCrash('auth-expired-clear', error?.message || String(error))
    } catch {
      /* ignore */
    }
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('auth:expired', { detail })
  }
}

const SELLER_QUEUE_DIMENSIONS = Object.freeze(['indexed', 'loaded', 'crawled', 'status', 'group'])
const SELLER_QUEUE_STATUSES = Object.freeze(['pending', 'running', 'completed', 'no_active', 'incomplete', 'needs_review', 'failed', 'login_expired', 'risk_cooldown'])
const SELLER_QUEUE_STATUS_GROUPS = Object.freeze(['all', 'pending', 'completed', 'failed'])
const SELLER_START_TRIGGERS = Object.freeze(['manual', 'resume', 'canary', 'observation'])
const SELLER_SAMPLE_LIMITS = Object.freeze({ all: 0, canary20: 20 })
const SELLER_TEST_FAST_MANIFESTS = Object.freeze({
  20: '10e30787d45c9a0db17d9d948e1b8ffdee223542a31a454f48d8408aa4915fb5'
})
const SELLER_EXPORT_PAGE_SIZE = 100
const TASK_SETTINGS_KEYS = Object.freeze([
  'dailyEnabled', 'dailyTime', 'launchAtLogin', 'throttleMinMs', 'throttleMaxMs',
  'queryDelayMinMs', 'queryDelayMaxMs', 'rateSafetyVersion', 'recycleEvery',
  'maxTasks', 'syncToErp', 'wmsSource', 'wmsMcpUrl', 'wmsMcpKey',
  'wmsRestUsername', 'wmsRestPassword', 'blacklistKeywords', 'categorySearchModes'
])
const MARKET_DISPLAY_GROUPS = Object.freeze(['all', 'failed', 'pending', 'success', 'review'])
const MARKET_IPC_PAGE_SIZE = 100

function assertPlainObject(value, label = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
}

function assertOnlyKeys(value, allowed, label = 'payload') {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} contains unsupported field: ${key}`)
  }
}

function validateMarketProjectionPayload(payload = {}) {
  assertPlainObject(payload, 'market projection')
  assertOnlyKeys(payload, ['q', 'page', 'pageSize', 'marketGroup', 'marketPage', 'marketPageSize'], 'market projection')
  const readText = (key, max = 128) => {
    if (payload[key] == null) return ''
    if (typeof payload[key] !== 'string') throw new TypeError(`${key} must be a string`)
    const value = payload[key].trim()
    if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${key} is invalid`)
    return value
  }
  const readPage = (key, fallback) => {
    const value = payload[key] == null ? fallback : Number(payload[key])
    if (!Number.isInteger(value) || value < 1 || value > 1000000) throw new TypeError(`${key} must be a positive integer`)
    return value
  }
  const readSize = (key, fallback) => {
    const value = payload[key] == null ? fallback : Number(payload[key])
    if (!Number.isInteger(value) || value < 1 || value > MARKET_IPC_PAGE_SIZE) throw new TypeError(`${key} must be an integer from 1 to ${MARKET_IPC_PAGE_SIZE}`)
    return value
  }
  const marketGroup = readText('marketGroup', 24) || 'all'
  if (!MARKET_DISPLAY_GROUPS.includes(marketGroup)) throw new TypeError('marketGroup is invalid')
  return {
    q: readText('q'),
    page: readPage('page', 1),
    pageSize: readSize('pageSize', 50),
    marketGroup,
    marketPage: readPage('marketPage', 1),
    marketPageSize: readSize('marketPageSize', 50)
  }
}

function validateMarketHistoryPayload(payload = {}) {
  assertPlainObject(payload, 'market history')
  assertOnlyKeys(payload, ['q', 'page', 'pageSize', 'group', 'priceBand'], 'market history')
  const q = payload.q == null ? '' : String(payload.q).trim()
  if (q.length > 128 || /[\u0000-\u001f\u007f]/.test(q)) throw new TypeError('q is invalid')
  const page = payload.page == null ? 1 : Number(payload.page)
  const pageSize = payload.pageSize == null ? 30 : Number(payload.pageSize)
  if (!Number.isInteger(page) || page < 1 || page > 1000000) throw new TypeError('page must be a positive integer')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MARKET_IPC_PAGE_SIZE) throw new TypeError(`pageSize must be an integer from 1 to ${MARKET_IPC_PAGE_SIZE}`)
  const group = payload.group == null || payload.group === '' ? 'all' : String(payload.group)
  if (!MARKET_DISPLAY_GROUPS.includes(group)) throw new TypeError('group is invalid')
  const priceBand = payload.priceBand == null || payload.priceBand === '' ? null : String(payload.priceBand).slice(0, 48)
  return { q, page, pageSize, group, priceBand }
}

function validatePricePreviewPayload(payload = {}, { selection = false } = {}) {
  assertPlainObject(payload, selection ? 'price selection' : 'price preview')
  const allowed = selection
    ? ['taskId', 'previewId', 'policyVersion', 'choice', 'customPrice', 'confirmed', 'operatorId', 'note']
    : ['taskId']
  assertOnlyKeys(payload, allowed, selection ? 'price selection' : 'price preview')
  const taskId = String(payload.taskId || '').trim()
  if (!taskId || taskId.length > 160 || /[\u0000-\u001f\u007f]/.test(taskId)) throw new TypeError('taskId is invalid')
  if (!selection) return { taskId }
  const previewId = String(payload.previewId || '').trim()
  const policyVersion = String(payload.policyVersion || '').trim()
  const choice = String(payload.choice || '').trim()
  if (!/^[a-f0-9]{32,128}$/i.test(previewId)) throw new TypeError('previewId is invalid')
  if (policyVersion !== 'price-policy-v1') throw new TypeError('policyVersion is invalid')
  if (!['market_median', 'recommendation', 'custom'].includes(choice)) throw new TypeError('choice is invalid')
  if (payload.confirmed !== true) throw new TypeError('price selection requires explicit confirmation')
  const customPrice = payload.customPrice == null || payload.customPrice === '' ? null : Number(payload.customPrice)
  if (choice === 'custom' && (!Number.isFinite(customPrice) || customPrice <= 0)) throw new TypeError('customPrice is invalid')
  const operatorId = String(payload.operatorId || 'manual').trim().slice(0, 48) || 'manual'
  const note = String(payload.note || '').trim().slice(0, 240)
  return { taskId, previewId, policyVersion, choice, customPrice, confirmed: true, operatorId, note }
}

function sanitizeMarketRow(row = {}) {
  const safeSnapshots = (Array.isArray(row.snapshotEntries) ? row.snapshotEntries : []).slice(0, 24).map((entry) => ({
    entryId: String(entry?.entryId || '').slice(0, 160),
    query: String(entry?.query || '').slice(0, 240),
    path: entry?.path ? String(entry.path).slice(0, 1000) : null,
    snapshotStatus: String(entry?.snapshotStatus || '').slice(0, 40),
    capturedAt: entry?.capturedAt || null,
    error: String(entry?.error || '').slice(0, 240),
    cards: Number(entry?.cards) || 0,
    accepted: Number(entry?.accepted) || 0,
    reasonCodes: Array.isArray(entry?.reasonCodes) ? entry.reasonCodes.map((value) => String(value).slice(0, 80)).slice(0, 24) : []
  }))
  const lastStatus = String(row.lastStatus || row.status || 'pending').slice(0, 40)
  const lastPrice = row.lastPrice ?? row.price ?? null
  const lastRunAt = row.lastRunAt || row.at || null
  const lastReason = String(row.lastReason || row.reason || '').slice(0, 300)
  return {
    taskId: String(row.taskId || row.id || '').slice(0, 160),
    id: String(row.id || '').slice(0, 160),
    source: String(row.source || '').slice(0, 48),
    sourceLabel: String(row.sourceLabel || '').slice(0, 80),
    name: String(row.name || '').slice(0, 240),
    brand: String(row.brand || '').slice(0, 120),
    model: String(row.model || '').slice(0, 160),
    spuCode: String(row.spuCode || row.spu_code || '').trim().toUpperCase().slice(0, 160),
    apiSpuCode: String(row.apiSpuCode || '').trim().toUpperCase().slice(0, 160) || null,
    apiSkuCode: String(row.apiSkuCode || '').slice(0, 160) || null,
    apiSkuCount: Number(row.apiSkuCount) || 0,
    apiListingPrice: row.apiListingPrice ?? null,
    apiListingUpdatedAt: row.apiListingUpdatedAt || null,
    apiListingVersion: row.apiListingVersion ?? null,
    apiDataConflict: Boolean(row.apiDataConflict),
    apiSalePrice: row.apiSalePrice ?? null,
    apiSuggestPrice: row.apiSuggestPrice ?? null,
    referencePrice: row.referencePrice ?? null,
    // 成本价“为什么没有”和成本价本身一样要过 IPC：界面要能区分“库存没填”和
    // “同一 SPU 多个在库 SKU 成本不一致”，否则调价台上只剩一个没法解释的破折号。
    referencePriceStatus: String(row.referencePriceStatus || '').slice(0, 24),
    referencePriceReason: String(row.referencePriceReason || '').slice(0, 300),
    apiCostPrice: row.apiCostPrice ?? null,
    apiCostPriceValues: Array.isArray(row.apiCostPriceValues)
      ? row.apiCostPriceValues.map((value) => String(value).slice(0, 32)).slice(0, 12)
      : [],
    lastPrice,
    lastStatus,
    lastRunAt,
    lastReason,
    // Stable aliases keep the read-only history surface compatible with
    // retained run records while the new API uses explicit last* names.
    price: lastPrice,
    status: lastStatus,
    at: lastRunAt,
    reason: lastReason,
    reasonCode: String(row.reasonCode || row.lastReasonCode || '').slice(0, 80),
    queueKind: String(row.queueKind || '').slice(0, 40),
    displayGroup: String(row.displayGroup || '').slice(0, 24),
    correctionWorkflowStatus: String(row.correctionWorkflowStatus || '').slice(0, 48),
    correctionReviewStatus: String(row.correctionReviewStatus || '').slice(0, 48),
    correctionVersion: String(row.correctionVersion || '').slice(0, 64),
    aiReviewStatus: String(row.aiReviewStatus || '').slice(0, 40),
    aiReviewReason: String(row.aiReviewReason || '').slice(0, 300),
    correctionAudit: Array.isArray(row.correctionAudit) ? row.correctionAudit.slice(-20) : [],
    writebackAudit: Array.isArray(row.writebackAudit) ? row.writebackAudit.slice(-20) : [],
    searchKeywords: Array.isArray(row.searchKeywords) ? row.searchKeywords.map((value) => String(value).slice(0, 240)).slice(0, 12) : [],
    priceComparison: row.priceComparison || row.lastPriceComparison || null,
    priceBreakdown: row.priceBreakdown || null,
    snapshotEntries: safeSnapshots,
    queryLogs: Array.isArray(row.queryLogs) ? row.queryLogs.slice(0, 24) : [],
    snapshotPath: row.snapshotPath ? String(row.snapshotPath).slice(0, 1000) : null,
    snapshotQuery: String(row.snapshotQuery || '').slice(0, 240)
  }
}

function sanitizeMarketQueue(view = {}) {
  return {
    schemaVersion: Number(view.schemaVersion) || 1,
    kind: String(view.kind || '').slice(0, 24),
    group: String(view.group || '').slice(0, 24),
    page: Number(view.page) || 1,
    pageSize: Number(view.pageSize) || 0,
    total: Number(view.total) || 0,
    groupCounts: view.groupCounts && typeof view.groupCounts === 'object' ? { ...view.groupCounts } : {},
    priceBandCounts: view.priceBandCounts && typeof view.priceBandCounts === 'object' ? { ...view.priceBandCounts } : {},
    items: Array.isArray(view.items) ? view.items.map(sanitizeMarketRow) : [],
    hasMore: Boolean(view.hasMore)
  }
}

function sanitizeWmsItem(item = {}) {
  return {
    sku_code: String(item.sku_code || '').slice(0, 160),
    spu_code: String(item.spu_code || '').trim().toUpperCase().slice(0, 160),
    brand: String(item.brand || '').slice(0, 120),
    model: String(item.model || '').slice(0, 160),
    product_name: String(item.product_name || '').slice(0, 240),
    spec: String(item.spec || '').slice(0, 240),
    status: String(item.status || '').slice(0, 40),
    sale_price: item.sale_price ?? null,
    suggest_price: item.suggest_price ?? null,
    cost_price: item.cost_price ?? null,
    location_code: String(item.location_code || '').slice(0, 80),
    product_type: String(item.product_type || '').slice(0, 80),
    updated_at: item.updated_at || null,
    version: item.version ?? null
  }
}

function validateExternalGoofishUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    const hostname = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:') return { ok: false, reason: '仅允许 HTTPS 闲鱼链接' }
    if (!['goofish.com', 'www.goofish.com'].includes(hostname) || parsed.port) {
      return { ok: false, reason: '仅允许 goofish.com 官方域名链接' }
    }
    for (const key of parsed.searchParams.keys()) {
      if (/(token|secret|password|passwd|authorization|auth|session|cookie|api[_-]?key|access[_-]?key)/i.test(key)) {
        return { ok: false, reason: '链接包含敏感参数，已拒绝打开' }
      }
    }
    return { ok: true, url: parsed.toString() }
  } catch {
    return { ok: false, reason: '链接格式无效，已拒绝打开' }
  }
}

/**
 * AdsPower 官方文档。只放行这三条，别开成「任意外链」。
 *
 * 页面里已有的 setWindowOpenHandler 只认 goofish.com——它是为闲鱼商品链接写的，
 * 把官方文档塞进那张白名单会顺手放宽一条跟它无关的口子。这里单开一张表，
 * 改动一眼看得见改的是什么。
 */
const ADSPOWER_DOCS = Object.freeze({
  intro: 'https://www.adspower.net/local-api',
  api: 'https://localapi-doc-zh.adspower.net/docs/Udx0pH',
  help: 'https://help.adspower.net/docs/bBLQhb'
})

/**
 * 把设置里的 AdsPower 本体地址交给 adspower.js。
 *
 * 地址写坏了不能把应用带崩：退回默认端口、把原因记进日志，界面下一次报错时
 * 会把**实际在用**的地址写出来，人一眼能看出自己填的那个没生效。
 */
function applyAdsPowerDirectUrl() {
  const value = String(store.getSettings()?.adsPowerDirectUrl || '').trim()
  try {
    setDirectApiUrl(value)
  } catch (error) {
    console.warn(`[adspower] 设置里的本体地址「${value}」不是合法地址（${error?.message || error}），退回默认端口`)
    try { setDirectApiUrl('') } catch { /* 默认值不会不合法 */ }
  }
  return getDirectApiUrl()
}

function taskSettingsDto(settings = taskStore.getSettings()) {
  const dto = { ...settings }
  const secretStatus = store.getWmsSecretStatus?.() || {}
  delete dto.wmsMcpKey
  delete dto.wmsRestUsername
  delete dto.wmsRestPassword
  return {
    ...dto,
    wmsMcpKeyConfigured: Boolean(secretStatus.wmsMcpKeyConfigured),
    wmsRestUsernameConfigured: Boolean(secretStatus.wmsRestUsernameConfigured),
    wmsRestPasswordConfigured: Boolean(secretStatus.wmsRestPasswordConfigured),
    wmsSafeStorageAvailable: Boolean(secretStatus.safeStorageAvailable)
  }
}

function taskSettingsPatch(payload = {}) {
  assertPlainObject(payload, 'task settings')
  const patch = {}
  for (const key of TASK_SETTINGS_KEYS) {
    if (Object.hasOwn(payload, key)) patch[key] = payload[key]
  }
  return patch
}

function buildMarketPricePreview(taskId) {
  const row = taskStore.getMarketTask(taskId)
  if (!row) return null
  const breakdown = row.priceBreakdown || {}
  const observations = []
  const observedAt = row.lastRunAt || row.at || '1970-01-01T00:00:00.000Z'
  const skuCode = row.apiSkuCode || (Number(row.apiSkuCount) === 1 ? row.apiSkuCodes?.[0] : '') || ''
  const pushObservation = (value, index, query = '') => {
    const price = Number(value)
    if (!Number.isFinite(price) || price <= 0) return
    observations.push({ observationId: `${taskId}:${index}:${query}`.slice(0, 240), source: 'goofish', price, observedAt, skuCode: skuCode || null })
  }
  for (const [queryIndex, queryResult] of (Array.isArray(breakdown.queryResults) ? breakdown.queryResults : []).entries()) {
    const query = String(queryResult?.query || '').slice(0, 120)
    const values = Array.isArray(queryResult?.validPrices) ? queryResult.validPrices : Array.isArray(queryResult?.prices) ? queryResult.prices : []
    values.forEach((value, valueIndex) => pushObservation(value, `${queryIndex}-${valueIndex}`, query))
  }
  if (!observations.length && Number.isFinite(Number(row.lastPrice)) && Number(row.lastPrice) > 0) pushObservation(row.lastPrice, 'latest', 'latest-market-result')
  return createPriceCandidatePreview({ spuCode: row.spuCode || row.spu_code, skuCode, costPrice: row.referencePrice, apiCurrentSalePrice: row.apiSalePrice, apiSuggestPrice: row.apiSuggestPrice, marketObservations: observations })
}

function persistWmsSettingsPatch(patch = {}) {
  const nextPatch = { ...patch }
  const secretPatch = {}
  for (const key of ['wmsMcpKey', 'wmsRestUsername', 'wmsRestPassword']) {
    if (Object.hasOwn(nextPatch, key)) {
      const value = String(nextPatch[key] ?? '')
      // Empty renderer fields mean "keep existing".  There is no UI path to
      // clear a secret accidentally; explicit reset can be added separately.
      if (value.trim()) secretPatch[{ wmsMcpKey: 'mcpKey', wmsRestUsername: 'restUsername', wmsRestPassword: 'DEMO_ONLY_REDACTED' }[key]] = value.trim()
      delete nextPatch[key]
    }
  }
  if (Object.keys(secretPatch).length) {
    const result = store.setWmsSecrets(secretPatch)
    if (!result.ok) throw new Error('系统安全存储不可用，未保存库存 API 密钥')
  }
  return taskStore.setSettings(nextPatch)
}

function migrateLegacyWmsSettings() {
  const settings = taskStore.getSettings()
  const result = store.migrateLegacyWmsSecrets({
    mcpKey: settings.wmsMcpKey,
    restUsername: settings.wmsRestUsername,
    restPassword: settings.wmsRestPassword
  })
  if (result.ok && result.changed) {
    // Clear only after safeStorage confirmed a successful protected write.
    taskStore.setSettings({ wmsMcpKey: '', wmsRestUsername: '', wmsRestPassword: '' })
  }
  return result
}

function validateSpuPolicyPayload(payload = {}, { requirePolicy = false } = {}) {
  assertPlainObject(payload, 'SPU policy')
  const allowed = requirePolicy ? ['spuCode', 'policy', 'changedBy'] : ['spuCode']
  assertOnlyKeys(payload, allowed, 'SPU policy')
  const spuCode = String(payload.spuCode || '').trim().toUpperCase()
  if (!spuCode || spuCode.length > 160) throw new TypeError('spuCode is invalid')
  const task = taskStore.getUnifiedTasks({ includeDisabled: true }).find((item) => String(item.spuCode || item.spu_code || '').trim().toUpperCase() === spuCode)
  if (!task) throw new TypeError('SPU 不存在或未同步到当前库存')
  if (!requirePolicy) return { spuCode, task }
  const policy = normalizeSpuSearchPolicy(payload.policy || {})
  return { spuCode, task, policy, changedBy: String(payload.changedBy || '').trim().slice(0, 48) || null }
}

function validateSellerQueueFilter(payload, { paging = true } = {}) {
  assertPlainObject(payload, 'seller queue filter')
  assertOnlyKeys(payload, paging ? ['dimension', 'status', 'statusGroup', 'group', 'page', 'pageSize', 'q'] : ['dimension', 'status', 'statusGroup', 'group', 'q'], 'seller queue filter')
  const dimension = String(payload.dimension || '')
  if (!SELLER_QUEUE_DIMENSIONS.includes(dimension)) throw new TypeError('dimension must be indexed, loaded, crawled, status or group')
  const suppliedStatus = payload.status != null && String(payload.status).trim() !== ''
  const rawStatusGroup = payload.statusGroup ?? payload.group
  if (payload.statusGroup != null && payload.group != null && String(payload.statusGroup) !== String(payload.group)) {
    throw new TypeError('statusGroup and group must match when both are supplied')
  }
  const suppliedStatusGroup = rawStatusGroup != null && String(rawStatusGroup).trim() !== ''
  if (['status', 'group'].includes(dimension) && !suppliedStatus && !suppliedStatusGroup) {
    throw new TypeError('status is required and must be one of the nine seller states')
  }
  if (['status', 'group'].includes(dimension) && suppliedStatus && !SELLER_QUEUE_STATUSES.includes(String(payload.status || ''))) {
    throw new TypeError('status is required and must be one of the nine seller states')
  }
  if (suppliedStatusGroup && !SELLER_QUEUE_STATUS_GROUPS.includes(String(rawStatusGroup || ''))) throw new TypeError('statusGroup is invalid')
  if (!['status', 'group'].includes(dimension) && (suppliedStatus || suppliedStatusGroup)) throw new TypeError('status and statusGroup are only valid for status/group dimensions')
  if (suppliedStatus && suppliedStatusGroup) throw new TypeError('status and statusGroup cannot be combined')
  if (payload.q != null && typeof payload.q !== 'string') throw new TypeError('q must be a string')
  const q = String(payload.q || '').trim()
  if (q.length > 128 || /[\u0000-\u001f\u007f]/.test(q)) throw new TypeError('q must be at most 128 visible characters')
  const filter = { dimension, status: ['status', 'group'].includes(dimension) && suppliedStatus ? String(payload.status) : null, q }
  if (suppliedStatusGroup) filter.statusGroup = String(rawStatusGroup)
  if (dimension === 'group' && !suppliedStatus && !suppliedStatusGroup) filter.statusGroup = 'all'
  if (!paging) return filter
  const page = payload.page == null ? 1 : Number(payload.page)
  const pageSize = payload.pageSize == null ? 50 : Number(payload.pageSize)
  if (!Number.isInteger(page) || page < 1 || page > 1000000) throw new TypeError('page must be an integer from 1 to 1000000')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError('pageSize must be an integer from 1 to 100')
  return { ...filter, page, pageSize }
}

function validateSellerPaging(payload = {}) {
  assertPlainObject(payload, 'paging')
  assertOnlyKeys(payload, ['page', 'pageSize', 'q'], 'paging')
  const page = payload.page == null ? 1 : Number(payload.page)
  const pageSize = payload.pageSize == null ? 20 : Number(payload.pageSize)
  if (!Number.isInteger(page) || page < 1 || page > 1000000) throw new TypeError('page must be an integer from 1 to 1000000')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError('pageSize must be an integer from 1 to 100')
  if (payload.q != null && typeof payload.q !== 'string') throw new TypeError('q must be a string')
  const q = String(payload.q || '').trim()
  if (q.length > 128 || /[\u0000-\u001f\u007f]/.test(q)) throw new TypeError('q must be at most 128 visible characters')
  return { page, pageSize, q }
}

function validateSellerListPaging(payload = {}, allowedStatuses = [], allowedStatusGroups = SELLER_QUEUE_STATUS_GROUPS) {
  assertPlainObject(payload, 'seller list paging')
  assertOnlyKeys(payload, ['page', 'pageSize', 'q', 'status', 'statusGroup', 'group', 'sellerId', 'sourceId', 'runId', 'snapshotId'], 'seller list paging')
  const status = payload.status == null || payload.status === '' ? null : String(payload.status)
  if (status && !allowedStatuses.includes(status)) throw new TypeError('status is invalid')
  const rawStatusGroup = payload.statusGroup ?? payload.group
  if (payload.statusGroup != null && payload.group != null && String(payload.statusGroup) !== String(payload.group)) throw new TypeError('statusGroup and group must match when both are supplied')
  const statusGroup = rawStatusGroup == null || rawStatusGroup === '' ? null : String(rawStatusGroup)
  if (statusGroup && !allowedStatusGroups.includes(statusGroup)) throw new TypeError('statusGroup is invalid')
  if (status && statusGroup) throw new TypeError('status and statusGroup cannot be combined')
  const { page, pageSize, q } = validateSellerPaging({ page: payload.page, pageSize: payload.pageSize, q: payload.q })
  const selector = (key) => {
    if (payload[key] == null) return ''
    if (typeof payload[key] !== 'string') throw new TypeError(`${key} must be a string`)
    const value = String(payload[key]).trim()
    if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${key} is invalid`)
    return value
  }
  return { page, pageSize, q, status, ...(statusGroup ? { statusGroup } : {}), sellerId: selector('sellerId'), sourceId: selector('sourceId'), runId: selector('runId'), snapshotId: selector('snapshotId') }
}

function validateSellerSnapshotQuery(payload = {}) {
  assertPlainObject(payload, 'seller snapshot query')
  assertOnlyKeys(payload, ['page', 'pageSize', 'sellerId', 'sourceId', 'runId', 'snapshotId'], 'seller snapshot query')
  const selector = (key) => {
    if (payload[key] == null) return ''
    if (typeof payload[key] !== 'string') throw new TypeError(`${key} must be a string`)
    const value = String(payload[key]).trim()
    if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${key} is invalid`)
    return value
  }
  const page = payload.page == null ? 1 : Number(payload.page)
  const pageSize = payload.pageSize == null ? 50 : Number(payload.pageSize)
  if (!Number.isInteger(page) || page < 1 || page > 1000000) throw new TypeError('page must be an integer from 1 to 1000000')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError('pageSize must be an integer from 1 to 100')
  return { page, pageSize, sellerId: selector('sellerId'), sourceId: selector('sourceId'), runId: selector('runId'), snapshotId: selector('snapshotId') }
}

function validateSellerQueueDetailPayload(payload = {}) {
  assertPlainObject(payload, 'seller queue detail')
  assertOnlyKeys(payload, ['sellerId', 'sourceId', 'runId'], 'seller queue detail')
  const selector = (key) => {
    if (payload[key] == null) return ''
    if (typeof payload[key] !== 'string') throw new TypeError(`${key} must be a string`)
    const value = String(payload[key]).trim()
    if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${key} is invalid`)
    return value
  }
  const result = { sellerId: selector('sellerId'), sourceId: selector('sourceId'), runId: selector('runId') }
  if (!result.sellerId && !result.sourceId) throw new TypeError('sellerId or sourceId is required')
  return result
}

function validateSellerSettings(payload) {
  assertPlainObject(payload, 'seller settings')
  assertOnlyKeys(payload, ['throttleMinMs', 'throttleMaxMs'], 'seller settings')
  const throttleMinMs = Number(payload.throttleMinMs)
  const throttleMaxMs = Number(payload.throttleMaxMs)
  if (!Number.isInteger(throttleMinMs) || throttleMinMs < 15000 || throttleMinMs > 3600000) throw new TypeError('throttleMinMs must be an integer from 15000 to 3600000')
  if (!Number.isInteger(throttleMaxMs) || throttleMaxMs < throttleMinMs || throttleMaxMs > 3600000) throw new TypeError('throttleMaxMs must be an integer from throttleMinMs to 3600000')
  return { throttleMinMs, throttleMaxMs }
}

function serializeSellerError(error, context = 'seller') {
  const unsafe = error && typeof error === 'object' ? error : { message: String(error || '未知错误') }
  const message = String(unsafe.message || unsafe.reason || '操作失败')
    .replace(/(token|cookie|authorization|password|secret|session)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 500)
  const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(String(unsafe.code || '')) ? String(unsafe.code) : 'SELLER_REQUEST_FAILED'
  return { code, message, context: String(context || 'seller').slice(0, 80) }
}

function sellerThrottleLabel(settings = sellerStore.getSettings()) {
  const min = Math.max(15, Math.round((Number(settings?.throttleMinMs) || 15000) / 1000))
  const max = Math.max(min, Math.round((Number(settings?.throttleMaxMs) || min * 1000) / 1000))
  return min === max ? `${min} 秒固定间隔` : `${min}–${max} 秒随机间隔`
}

function sellerIpcHandler(context, handler) {
  return async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      const safe = serializeSellerError(error, context)
      const wrapped = new Error(JSON.stringify(safe))
      wrapped.code = safe.code
      throw wrapped
    }
  }
}

function sellerQueueRowDto(row = {}) {
  let url = ''
  try {
    const parsed = new URL(String(row.url || ''))
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|signature|sig|session|auth|credential|secret|password|cookie|access[_-]?key|authorization/i.test(key)) parsed.searchParams.delete(key)
    }
    parsed.username = ''
    parsed.password = ''
    parsed.hash = ''
    if (parsed.protocol === 'https:' && /(^|\.)goofish\.com$/i.test(parsed.hostname)) url = parsed.toString()
  } catch { /* invalid or non-public seller URL stays unavailable */ }
  return {
    id: String(row.id || ''),
    sellerId: String(row.sellerId || ''),
    url,
    sellerName: String(row.sellerName || ''),
    mainContent: String(row.mainContent || '').slice(0, 240),
    mainType: String(row.mainType || row.category || '').slice(0, 120),
    category: String(row.category || row.mainType || '').slice(0, 120),
    board: String(row.board || row.boardName || '').slice(0, 120),
    boardName: String(row.boardName || row.board || '').slice(0, 120),
    sourceBoardRanks: String(row.sourceBoardRanks || '').slice(0, 2000),
    rank: row.rank ?? row.sourceRank ?? null,
    sourceRank: row.sourceRank ?? row.rank ?? null,
    sourceOrdinal: row.sourceOrdinal ?? null,
    sourceSlotCount: row.sourceSlotCount ?? null,
    cities: String(row.cities || '').slice(0, 240),
    excelRow: row.excelRow ?? null,
    sourceSheet: String(row.sourceSheet || '').slice(0, 160),
    status: SELLER_QUEUE_STATUSES.includes(row.status) ? row.status : 'needs_review',
    reasonCode: String(row.reasonCode || ''),
    reason: String(row.reason || ''),
    attemptCount: Array.isArray(row.attempts) ? row.attempts.length : Number(row.attemptCount) || 0,
    runId: String(row.runId || ''),
    cycleKey: String(row.cycleKey || ''),
    activeCount: row.activeCount != null && Number.isFinite(Number(row.activeCount)) ? Number(row.activeCount) : null,
    soldCount: row.soldCount != null && Number.isFinite(Number(row.soldCount)) ? Number(row.soldCount) : null,
    expectedActive: row.expected?.active ?? null,
    expectedSold: row.expected?.sold ?? null,
    snapshotId: String(row.snapshotId || ''),
    snapshotHash: String(row.snapshotHash || ''),
    snapshotPath: String(row.snapshotPath || ''),
    latestSnapshotPath: String(row.snapshotPath || ''),
    snapshotAt: row.snapshotCapturedAt || null,
    snapshotViewport: row.snapshotViewport || null,
    snapshotCapturedAt: row.snapshotCapturedAt || null,
    snapshotBytes: row.snapshotBytes != null && Number.isFinite(Number(row.snapshotBytes)) ? Number(row.snapshotBytes) : null,
    snapshotComplete: row.snapshotComplete == null ? null : Boolean(row.snapshotComplete),
    snapshotExpectedCount: row.snapshotExpectedCount != null && Number.isFinite(Number(row.snapshotExpectedCount)) ? Number(row.snapshotExpectedCount) : null,
    snapshotObservedCount: row.snapshotObservedCount != null && Number.isFinite(Number(row.snapshotObservedCount)) ? Number(row.snapshotObservedCount) : null,
    updatedAt: row.updatedAt || row.finalizedAt || row.importedAt || null,
    lastDurableWriteAt: row.lastItemBatchCommittedAt || row.persistedAt || row.committedAt || row.updatedAt || null
  }
}

function sellerItemRowDto(row = {}) {
  const publicUrl = (value, kind) => {
    try {
      const url = new URL(String(value || ''))
      if (url.protocol !== 'https:') return ''
      if (kind === 'item' && !/(^|\.)goofish\.com$/i.test(url.hostname)) return ''
      for (const key of [...url.searchParams.keys()]) {
        if (kind === 'item' ? !['id', 'itemId'].includes(key) : /token|signature|sig|session|auth|credential|secret|password|cookie|access[_-]?key/i.test(key)) {
          url.searchParams.delete(key)
        }
      }
      url.username = ''
      url.password = ''
      url.hash = ''
      return url.href
    } catch {
      return ''
    }
  }
  return {
    observationId: String(row.observationId || ''),
    itemId: String(row.itemId || ''),
    itemUrl: publicUrl(row.itemUrl, 'item'),
    imageUrl: publicUrl(row.imageUrl, 'image'),
    title: String(row.title || '').slice(0, 240),
    price: Number.isFinite(Number(row.price)) && Number(row.price) > 0 ? Number(row.price) : null,
    status: ['active', 'sold', 'unknown'].includes(row.status) ? row.status : 'unknown',
    wants: Math.max(0, Number(row.wants) || 0),
    category: String(row.category || '').slice(0, 80),
    sellerId: String(row.sellerId || ''),
    sellerName: String(row.sellerName || '').slice(0, 128),
    sellerUrl: sellerQueueRowDto({ url: row.sellerUrl }).url,
    sourceId: String(row.sourceId || ''),
    runId: String(row.runId || ''),
    attemptKey: String(row.attemptKey || ''),
    snapshotId: String(row.snapshotId || ''),
    capturedAt: row.capturedAt || null,
    observedAt: row.observedAt || null
  }
}

function sellerAttemptDto(attempt = {}) {
  return {
    attemptKey: String(attempt.attemptKey || ''),
    runId: String(attempt.runId || ''),
    cycleKey: String(attempt.cycleKey || ''),
    sellerId: String(attempt.sellerId || ''),
    accountId: String(attempt.accountId || ''),
    branch: attempt.branch === 'sold' ? 'sold' : 'active',
    startedAt: attempt.startedAt || null,
    endedAt: attempt.endedAt || null,
    outcome: String(attempt.outcome || ''),
    reasonCode: String(attempt.reasonCode || ''),
    crawlStartedAt: attempt.crawlStartedAt || null,
    crawlFinishedAt: attempt.crawlFinishedAt || null,
    crawlResult: String(attempt.crawlResult || ''),
    snapshotId: String(attempt.snapshotId || ''),
    snapshotHash: String(attempt.snapshotHash || ''),
    snapshotCapturedAt: attempt.snapshotCapturedAt || null,
    snapshotComplete: attempt.snapshotComplete == null ? null : Boolean(attempt.snapshotComplete),
    snapshotExpectedCount: attempt.snapshotExpectedCount != null && Number.isFinite(Number(attempt.snapshotExpectedCount)) ? Number(attempt.snapshotExpectedCount) : null,
    snapshotObservedCount: attempt.snapshotObservedCount != null && Number.isFinite(Number(attempt.snapshotObservedCount)) ? Number(attempt.snapshotObservedCount) : null
  }
}

function sellerSnapshotDto(snapshot = {}) {
  return {
    snapshotId: String(snapshot.snapshotId || ''),
    snapshotHash: String(snapshot.snapshotHash || ''),
    bytes: Number.isFinite(Number(snapshot.bytes)) ? Number(snapshot.bytes) : null,
    evidenceKind: String(snapshot.evidenceKind || 'html'),
    runId: String(snapshot.runId || ''),
    sourceId: String(snapshot.sourceId || ''),
    sellerId: String(snapshot.sellerId || ''),
    capturedAt: snapshot.capturedAt || null,
    complete: snapshot.complete == null ? null : Boolean(snapshot.complete),
    expectedCount: snapshot.expectedCount != null && Number.isFinite(Number(snapshot.expectedCount)) ? Number(snapshot.expectedCount) : null,
    observedCount: snapshot.observedCount != null && Number.isFinite(Number(snapshot.observedCount)) ? Number(snapshot.observedCount) : null,
    inlineImageCount: snapshot.inlineImageCount != null && Number.isFinite(Number(snapshot.inlineImageCount)) ? Number(snapshot.inlineImageCount) : null,
    remoteImageCount: snapshot.remoteImageCount != null && Number.isFinite(Number(snapshot.remoteImageCount)) ? Number(snapshot.remoteImageCount) : null,
    pageUrl: sellerQueueRowDto({ url: snapshot.pageUrl || snapshot.sourceUrl }).url,
    viewport: snapshot.viewport || null
  }
}

function sellerSnapshotReadDto(snapshot = {}) {
  const dto = sellerSnapshotDto(snapshot)
  return {
    ...dto,
    ok: snapshot.ok !== false,
    kind: String(snapshot.kind || 'html'),
    url: snapshot.kind === 'html' ? String(snapshot.url || '') : '',
    html: snapshot.kind === 'html-srcdoc' ? String(snapshot.html || '') : ''
  }
}

function sellerQueueDetailDto(detail = {}) {
  if (detail?.ok === false) return { ok: false, reason: String(detail.reason || '卖家详情读取失败') }
  return {
    ok: true,
    seller: sellerQueueRowDto(detail.seller || {}),
    items: Array.isArray(detail.items) ? detail.items.map(sellerItemRowDto) : [],
    attempts: Array.isArray(detail.attempts) ? detail.attempts.map(sellerAttemptDto) : [],
    snapshots: Array.isArray(detail.snapshots) ? detail.snapshots.map(sellerSnapshotDto) : []
  }
}

function sellerSettingsDto() {
  const settings = sellerStore.getSettings()
  return {
    throttleMinMs: Math.max(15000, Number(settings.throttleMinMs) || 15000),
    throttleMaxMs: Math.max(15000, Number(settings.throttleMaxMs) || 30000)
  }
}

function sellerRunEventDto(event = {}) {
  const accountStats = event.accountStats && typeof event.accountStats === 'object' && !Array.isArray(event.accountStats)
    ? Object.fromEntries(Object.entries(event.accountStats).map(([id, stats]) => [String(id), {
      accountId: String(stats?.accountId || id),
      accountName: String(stats?.accountName || id).slice(0, 128),
      claimed: Math.max(0, Number(stats?.claimed) || 0),
      finished: Math.max(0, Number(stats?.finished) || 0),
      completed: Math.max(0, Number(stats?.completed) || 0),
      failed: Math.max(0, Number(stats?.failed) || 0),
      byStatus: stats?.byStatus && typeof stats.byStatus === 'object' && !Array.isArray(stats.byStatus)
        ? Object.fromEntries(Object.entries(stats.byStatus).map(([status, count]) => [String(status), Math.max(0, Number(count) || 0)]))
        : {}
    }]))
    : {}
  return {
    type: String(event.type || ''),
    runId: String(event.runId || event.priorRunId || ''),
    trigger: String(event.trigger || event.outcome || ''),
    cycleKey: String(event.cycleKey || ''),
    at: event.at || null,
    scheduledAt: event.scheduledAt || null,
    total: Number.isFinite(Number(event.total)) ? Number(event.total) : null,
    outcome: String(event.outcome || ''),
    reasonCode: String(event.reasonCode || ''),
    accounts: Array.isArray(event.accounts) ? event.accounts.map((account) => ({ id: String(account?.id || ''), name: String(account?.name || '').slice(0, 128) })) : [],
    accountStats
  }
}

function currentSellerRunDto() {
  if (!sellerRuntime) return null
  return { ...sellerRuntime }
}

function sellerSummaryDto() {
  const evidence = sellerStore.getSellerEvidenceSummary()
  const status = sellerScheduler.getStatus()
  const rows = sellerStore.getAllSourceRows()
  const updatedAt = rows.reduce((latest, row) => {
    const value = row.updatedAt || row.finalizedAt || row.importedAt || null
    return !latest || (value && value > latest) ? value : latest
  }, null)
  return { ...evidence, updatedAt, running: Boolean(status.running || status.job?.running), accountStats: status.accountStats || {}, currentRun: currentSellerRunDto() }
}

function sellerScheduleDto() {
  const settings = sellerStore.getSettings()
  const lastCycle = sellerStore.getScheduleState()
  const next = evaluateSchedule({ now: new Date(), settings: { ...settings, timezone: SELLER_TIMEZONE }, lastCycle, running: sellerScheduler.isRunning() })
  return {
    weeklyEnabled: Boolean(settings.weeklyEnabled),
    weeklyDay: Number(settings.weeklyDay),
    weeklyTime: String(settings.weeklyTime),
    timezone: SELLER_TIMEZONE,
    catchUpHours: 24,
    lastOutcome: lastCycle?.outcome || null,
    lastCycleKey: lastCycle?.cycleKey || null,
    lastScheduledAt: lastCycle?.scheduledAt || null,
    nextDecision: next
  }
}

function sellerExportFileName(filter) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')
  const suffix = ['status', 'group'].includes(filter.dimension) ? (filter.statusGroup || filter.status) : filter.dimension
  return `卖家队列_${suffix}_${stamp}.xlsx`
}

function productName() {
  const name = app.getName()
  return name && name !== 'xianyu-electron' ? name : '卖家工作台'
}

function invalidExcelFileName() {
  const d = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `闲鱼行情错误型号_${stamp}.xlsx`
}

function wmsMappingFileName() {
  const d = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `闲鱼行情API-SPU关联表_${stamp}.xlsx`
}

// 崩溃兜底：主进程未捕获异常默认会直接退出（用户看到的就是"自己退出"），
// 这里记到 userData/crash.log 并保持进程存活；排查问题让用户把这个文件发回来
function logCrash(kind, err) {
  try {
    const line = `[${new Date().toISOString()}] ${kind}: ${err?.stack || err}\n`
    appendFileSync(join(app.getPath('userData'), 'crash.log'), line)
  } catch {
    /* ignore */
  }
  console.error(kind, err)
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e))
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e))

// ---- 代码热更新 ----
// loader.js 在加载热更新副本前写下这个标记，窗口就绪即清除；下次启动若它还在，
// loader 会把那份副本隔离掉并回退内置版本。见 loader.js 的 BOOT_PENDING。
function bootPendingMarker() {
  return join(app.getPath('userData'), 'code-boot-pending')
}

function clearBootPendingMarker() {
  try {
    const marker = bootPendingMarker()
    if (existsSync(marker)) rmSync(marker, { force: true })
  } catch { /* 清不掉最多下次多回退一次，不该拦住启动 */ }
}

const codeUpdateState = {
  checking: false,
  downloading: false,
  current: null,
  latest: null,
  updateAvailable: false,
  readyToApply: false,
  error: ''
}

function codeUpdateDto() {
  return { ...codeUpdateState, current: { ...(codeUpdateState.current || {}) }, latest: codeUpdateState.latest ? { ...codeUpdateState.latest } : null }
}

function pushCodeUpdateState() {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('code-update:state', codeUpdateDto())
  } catch { /* 界面没起来时忽略 */ }
}

function currentCodeVersion() {
  return codeUpdate.readCurrentVersion({ userDataDir: app.getPath('userData'), appDir: app.getAppPath() })
}

// 与 loader.js 同一个开关：只有打包时带了 code-version.json 的构建（行情工作台）
// 才启用热更新。巡航台共用同一份代码但走整包分发，不该去拉工作台的清单。
function hotUpdateEnabled() {
  try {
    return app.isPackaged && existsSync(join(app.getAppPath(), 'code-version.json'))
  } catch {
    return false
  }
}

async function checkCodeUpdate({ silent = false } = {}) {
  if (!hotUpdateEnabled()) return { ...codeUpdateDto(), disabled: true }
  if (codeUpdateState.checking) return codeUpdateDto()
  codeUpdateState.checking = true
  codeUpdateState.error = ''
  pushCodeUpdateState()
  try {
    const latest = await codeUpdate.fetchManifest()
    codeUpdateState.current = currentCodeVersion()
    codeUpdateState.latest = latest
    codeUpdateState.updateAvailable = codeUpdate.shouldUpdate(codeUpdateState.current, latest)
    // readyToApply 只由下载落位置真；重启后 current 追平 latest，自然归位
    codeUpdateState.readyToApply = false
  } catch (e) {
    codeUpdateState.error = e?.message || String(e)
    if (!silent) console.error('[code-update] 检查更新失败：', codeUpdateState.error)
  } finally {
    codeUpdateState.checking = false
    pushCodeUpdateState()
  }
  return codeUpdateDto()
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: productName(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    // 窗口起来了才算这份代码能用。loader 在启动前写了这个标记，下次启动
    // 若发现它还在，就说明当前热更新副本加载成功却没跑起来，会自动隔离回退。
    clearBootPendingMarker()
  })

  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    const validated = validateExternalGoofishUrl(url)
    if (!validated.ok) {
      dialog.showErrorBox('无法打开外部链接', validated.reason)
      return { action: 'deny' }
    }
    shell.openExternal(validated.url)
    return { action: 'deny' }
  })

  // 关闭 = 收进托盘（除非设置为关闭即退出，或托盘菜单点了退出）
  win.on('close', (e) => {
    const closeToTray = store.getSettings().closeToTray
    if (!isQuiting && closeToTray) {
      e.preventDefault()
      win.hide()
    }
  })

  sm.initSessionManager(win)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray() {
  // 用 1x1 透明占位图，避免缺资源；生产可换 resources/tray.png
  const img = nativeImage.createEmpty()
  tray = new Tray(img)
  tray.setToolTip(productName())
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { win.show(); win.focus() } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuiting = true; app.quit() } }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => { win.show(); win.focus() })
}

function applyLaunchAtLogin(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled })
  } catch (e) {
    logCrash('login-item-settings', e)
  }
}

// 代理不在时，执行端由行情台照着执行端自己的台账直接起停（executor-local.js）。
// Windows 新安装包自带执行端（resources/gc-ads），数据放 userData/executor，老目录等执行端都停了搬过来。
// 老安装包和 Mac 还是固定位置（Windows C:\xianyu\gc-ads，Mac ~/xianyu/gc-ads），每次现找：刚放进去的下一下就认；
// 找不到就自己装（executor-install.js），下载进度推给「浏览器环境」页。
// 模块级单例工厂：registerIpc 的页面操作与 whenReady 的开机自恢复共用。
const localExecutor = () => {
  const { fixed, list } = executorDirCandidates({
    appData: app.getPath('appData'),
    devRoot: app.isPackaged ? '' : join(app.getAppPath(), '..', 'adspower-executor')
  })
  return createLocalExecutor(list, {
    fixed,
    embedded: app.isPackaged
      ? { programDir: join(process.resourcesPath, 'gc-ads'), dataDir: join(app.getPath('userData'), 'executor') }
      : null,
    prepareEmbedded: (home) => writeProdConfig(home.root, home.internal),
    syncCode: (home, disk) => syncExecutorCode(home.root, disk),
    openBrowser: (userId) => startEnv(userId),
    closeBrowser: (userId) => stopEnv(userId),
    install: (options = {}) => installExecutor({
      fixed,
      tempDir: app.getPath('temp'),
      onProgress: (progress) => {
        if (win && !win.isDestroyed()) win.webContents.send('executor:install-progress', progress)
      },
      ...options
    }),
    // 工位上的包比线上旧、又一个执行端都没在跑时，启动前顺手换新（09-10 那批老包不能热更新）
    latestPackage: () => fetchLatestExecutorPackage()
  })
}

// 开机自恢复执行端：机器重启 → 巡航台自启（launchAtLogin）→ 把台账里非人工停止的
// 执行端自动拉起，员工零操作。开机时序上 AdsPower 往往比巡航台慢半拍，第一两轮
// 失败多半是它的 Local API 还没就绪，所以按 30s 间隔重试几轮再放弃（只记日志，
// 不打扰用户——起来了浏览器环境页点「启动执行端」随时能补）。
async function resumeExecutorsWithRetry(attempts = 5, gapMs = 30_000) {
  // 有要拉的才等 AdsPower 开好（最多 30 分钟）：原来只按下面的节奏试 2 分钟，
  // 人晚点打开 AdsPower 就再也不拉了
  const status = await localExecutor().status().catch(() => ({}))
  if (!Object.values(status).some((s) => s.executor === '已停止')) return
  await waitForAdsPower({ adsReady: adsPowerReady })
  for (let i = 1; i <= attempts; i++) {
    try {
      const results = await localExecutor().resume()
      const failed = results.filter((r) => !r.ok)
      if (!failed.length) {
        if (results.length) console.log(`[executor] 开机自恢复完成：${results.map((r) => r.user_id).join(', ')}`)
        return
      }
      console.warn(`[executor] 开机自恢复第 ${i}/${attempts} 轮，${failed.length} 个未成：` +
        failed.map((f) => `${f.user_id}(${f.note})`).join('；'))
    } catch (error) {
      console.warn(`[executor] 开机自恢复第 ${i}/${attempts} 轮失败：${error?.message || error}`)
    }
    if (i < attempts) await new Promise((resolve) => setTimeout(resolve, gapMs))
  }
}

async function adsPowerReady() {
  try {
    await adsPowerHealth()
    return true
  } catch {
    return false
  }
}

// 「暂停，准备重启电脑」（restart-pause.js）：清单记在 userData，重启后照它恢复。
const restartPlan = () => createPlanStore(join(app.getPath('userData'), 'restart-pause.json'))
const restartOp = { busy: '', progress: null, last: null }
// 采集的 start 要等整轮跑完才返回（几个小时）。恢复只管把它拉起来：3 秒内就回了的
// （没有可接的中断任务之类）原样报，没回的就是跑起来了，让它自己跑完。
async function startCrawlInBackground(label, start) {
  const run = start()
  const early = await Promise.race([run, new Promise((resolve) => setTimeout(() => resolve(null), 3_000))])
  if (early) return early
  run.catch((error) => console.warn(`[restart] ${label}采集接着跑出错：${error?.message || error}`))
  return { ok: true }
}

// 巡航台自己的采集：暂停时在跑就停下、记进清单，恢复时接着跑（行情只接中断的那一轮，没有就不跑）
const restartCrawls = [
  {
    key: 'market',
    isRunning: () => scheduler.isRunning(),
    stop: () => scheduler.stop(),
    resume: () => startCrawlInBackground('行情', () => scheduler.start({ trigger: 'manual', resume: true }))
  },
  {
    key: 'seller',
    isRunning: () => Boolean(sellerScheduler.getStatus().running),
    stop: () => sellerScheduler.stop(),
    resume: () => startCrawlInBackground('卖家主页', () =>
      sellerScheduler.start({ reset: false, maxSellers: SELLER_SAMPLE_LIMITS.all, trigger: 'resume' }))
  }
]

// 调度中心的报错原话（没权限、没登录）比 axios 的「status code 403」好懂
const gcError = (error) => new Error(String(error?.response?.data?.detail || error?.message || error).slice(0, 240))

function restartSnapshot() {
  const plan = restartPlan().read()
  return {
    busy: restartOp.busy,
    progress: restartOp.progress,
    last: restartOp.last,
    plan: plan && {
      state: plan.state,
      pausedAt: plan.pausedAt,
      readyAt: plan.readyAt || '',
      envs: plan.envs.length,
      crawls: plan.crawls || [],
      resumeError: plan.resumeError || ''
    }
  }
}

function pushRestartState() {
  const state = restartSnapshot()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('restart:state', state)
  }
}

// 暂停和恢复不能叠着跑（开机正在自动恢复，人又点了一下）。结果记在 last 里推给界面
async function runRestartOp(kind, fn) {
  if (restartOp.busy) {
    return { ok: false, busy: true, reason: restartOp.busy === 'pause' ? '正在暂停，稍等' : '正在恢复，稍等' }
  }
  restartOp.busy = kind
  restartOp.progress = null
  pushRestartState()
  let result
  try {
    result = { ok: true, data: await fn((progress) => { restartOp.progress = progress; pushRestartState() }) }
  } catch (error) {
    result = { ok: false, reason: String(error?.message || error).slice(0, 400) }
  }
  restartOp.busy = ''
  restartOp.progress = null
  restartOp.last = { kind, at: Date.now(), ...result }
  pushRestartState()
  return result
}

async function pauseForRestartNow(onProgress) {
  const local = localExecutor()
  const { running } = await local.versions()   // 实际在跑的：台账记着、进程也在
  return pauseForRestart({
    envs: Object.keys(running || {}),
    deviceIdOf: (uid) => local.deviceIdOf(uid),
    begin: (deviceId, options) => api.beginDeviceMaintenance(deviceId, options).catch((error) => { throw gcError(error) }),
    // 连浏览器一起关：让 AdsPower 把登录状态存好，直接断电可能存不全
    stop: (uid) => stopExecutorFor(uid, { stopBrowser: true, local }),
    crawls: restartCrawls,
    plan: restartPlan(),
    onProgress
  })
}

async function resumeAfterPauseNow(onProgress) {
  const local = localExecutor()
  return resumeAfterPause({
    plan: restartPlan(),
    adsReady: adsPowerReady,
    start: (uid) => startExecutorFor(uid, { local }),
    end: (deviceId) => api.endDeviceMaintenance(deviceId).catch((error) => { throw gcError(error) }),
    crawls: restartCrawls,
    onProgress
  })
}

function sellerCliOptions() {
  if (!process.argv.includes('--seller-crawl')) return null
  const arg = process.argv.find((value) => value.startsWith('--seller-max='))
  const sourceArg = process.argv.find((value) => value.startsWith('--seller-source='))
  const maxSellers = arg ? Math.max(0, Number(arg.split('=')[1]) || 0) : 0
  const sourcePath = sourceArg ? sourceArg.slice('--seller-source='.length).trim() : ''
  const testFast = process.argv.includes('--seller-test-fast')
  const fixtureArg = process.argv.find((value) => value.startsWith('--seller-test-fixture='))
  const testFixturePath = fixtureArg ? fixtureArg.slice('--seller-test-fixture='.length).trim() : ''
  const manifestArg = process.argv.find((value) => value.startsWith('--seller-test-manifest-hash='))
  const testManifestHash = manifestArg ? manifestArg.slice('--seller-test-manifest-hash='.length).trim() : ''
  let allowedSellerIds = null
  if (testFast && testFixturePath && isAbsolute(testFixturePath)) {
    const fixture = JSON.parse(readFileSync(testFixturePath, 'utf8'))
    const ids = Array.isArray(fixture.sellers) ? fixture.sellers.map((seller) => String(seller?.id || '').trim()) : []
    const computed = createHash('sha256').update(ids.join('\n')).digest('hex')
    if (fixture.count !== maxSellers || ids.length !== maxSellers || new Set(ids).size !== ids.length || computed !== testManifestHash) {
      throw new Error('测试 fixture 与冻结样本哈希不匹配')
    }
    allowedSellerIds = ids
  }
  if (testFast && (sourcePath || process.argv.includes('--seller-reset') || !isAbsolute(testFixturePath) || maxSellers !== 20 || testManifestHash !== SELLER_TEST_FAST_MANIFESTS[maxSellers])) {
    throw new Error('--seller-test-fast 仅允许测试工具授权的冻结 20 条样本哈希，且禁止 source/reset')
  }
  if (!testFast && testFixturePath) throw new Error('测试 fixture 只能与 --seller-test-fast 一起使用')
  if (!testFast && testManifestHash) throw new Error('测试样本哈希只能与 --seller-test-fast 一起使用')
  return { maxSellers, sourcePath, reset: process.argv.includes('--seller-reset'), testFast, testManifestHash, allowedSellerIds }
}

// 把账号对象按 id 取出
function accountById(id) {
  return store.getAccounts().find((a) => a.id === id) || null
}

// 通过分区 cookie 判断是否持有真实闲鱼登录会话；访客 Cookie 不能作为登录证据。
async function checkXianyuLogin(account) {
  try {
    if (isAdsPowerAccount(account)) return await hasAuthenticatedAdsPowerSession(account)
    const ses = session.fromPartition(account.partition)
    const cookies = await ses.cookies.get({ domain: '.goofish.com' })
    const cookies2 = await ses.cookies.get({ domain: '.taobao.com' })
    const all = [...cookies, ...cookies2]
    return hasAuthenticatedXianyuCookies(all)
  } catch {
    return false
  }
}

// Both queues use the same factual login gate. Visitor cookies may render a
// public page, but they are never allowed to claim Excel or seller work.
scheduler.setAccountEligibilityChecker((account) => checkXianyuLogin(account))
sellerScheduler.setAccountEligibilityChecker((account) => checkXianyuLogin(account))

function registerIpc() {
  // ---- 鉴权 ----
  ipcMain.handle('auth:get-state', () => {
    const staff = store.getStaff()
    const token = store.getToken()
    return {
      serverBaseUrl: store.getServerBaseUrl(),
      defaultServerBaseUrl: store.DEFAULT_SERVER_BASE_URL,
      staff,
      // token 和 staff 必须同时在才算已登录：退出登录写盘失败可能只剩半个状态，
      // 只认 token 会让登录页以为已登录、把人挡在外面。
      hasToken: !!token && !!staff,
      localMode: store.getLocalMode()
    }
  })
  // 登录页预填用。只有登录页会要它，不并进 auth:get-state——那个每次切菜单都会调。
  ipcMain.handle('auth:remembered', () => store.getRememberedLogin())
  ipcMain.handle('auth:set-server', (_e, url) => {
    try {
      return { ok: true, serverBaseUrl: store.setServerBaseUrl(url) }
    } catch (e) {
      return { ok: false, reason: e?.message || '服务器地址无效', serverBaseUrl: store.getServerBaseUrl() }
    }
  })
  ipcMain.handle('auth:login', async (_e, { serverBaseUrl, username, password, remember }) => {
    // 地址先落库再登录：写坏的地址不能存进去，否则下次启动连登录页都连不上。
    if (serverBaseUrl) {
      try {
        store.setServerBaseUrl(serverBaseUrl)
      } catch (e) {
        return { ok: false, reason: e?.message || '服务器地址无效' }
      }
    }
    try {
      const data = await api.login(username, password)
      store.setToken(data.token)
      store.setStaff(data.staff)
      store.setLocalMode(false)
      // 登录成功才记：记一个错的密码，下次登录页就是一次必然失败的预填
      let passwordSaved = false
      if (remember) passwordSaved = store.setRememberedLogin(username, password).passwordSaved
      else store.clearRememberedLogin()
      return { ok: true, staff: data.staff, passwordSaved }
    } catch (e) {
      return { ok: false, reason: e?.response?.data?.detail || e?.message || '登录失败' }
    }
  })
  ipcMain.handle('auth:local', () => {
    store.setLocalMode(true)
    return { ok: true }
  })
  ipcMain.handle('auth:logout', () => store.clearAuth())

  // ---- 账号 ----
  ipcMain.handle('accounts:list', async () => {
    const list = store.getAccounts()
    const withStatus = await Promise.all(
      list.map(async (a) => ({ ...a, loggedIn: await checkXianyuLogin(a) }))
    )
    return withStatus
  })
  ipcMain.handle('accounts:add', (_e, name) => store.addAccount(name))
  ipcMain.handle('accounts:update', (_e, { id, patch }) => store.updateAccount(id, patch))
  ipcMain.handle('adspower:health', async () => {
    try {
      const data = await adsPowerHealth()
      return { ok: true, data: String(data || '') }
    } catch (error) {
      return { ok: false, reason: String(error?.message || 'AdsPower 本地服务不可用').slice(0, 240) }
    }
  })
  // 群控服务端调用统一在这里收口错误：后端用 detail 传人话，axios 默认只给
  // 「Request failed with status code 403」，直接抛给渲染层看不出是权限还是没登录。
  const gcCall = async (fn, fallback) => {
    try {
      return await fn()
    } catch (error) {
      if (error?.response?.status === 401) {
        notifyAuthExpired()
        throw new Error('登录已过期，请重新登录')
      }
      const detail = error?.response?.data?.detail || error?.message || fallback
      throw new Error(String(detail).slice(0, 240))
    }
  }

  // ERP 接口的失败原因也翻成人话，而且比 gcCall 多做一步：401/403 由端上组句。
  //
  // 服务端那边只回得出「权限不足」三个字——它不知道现在坐在前面的是谁、该换成
  // 什么账号；axios 更狠，message 只有「Request failed with status code 403」。
  // 2026-09-19 端上界面显示的就是后面这句，一屏 403 没人看得出是权限问题，
  // 最后靠翻服务器日志才定位。谁被拒、拒的是哪件事、下一步做什么，都要写在这句里。
  //
  // 其余状态仍以服务端 detail 为准：比如 409 会写清楚爬虫正占在哪台机器上，
  // 那句话比端上任何兜底都准。
  const erpReason = (error, what, fallback) => {
    const status = error?.response?.status
    if (status === 401) {
      notifyAuthExpired()
      return '登录已过期，请重新登录'
    }
    if (status === 403) {
      const me = store.getStaff()
      const name = me?.name || me?.username || ''
      return name
        ? `${what}只有管理员能用，当前登录的是「${name}」`
        : `${what}只有管理员能用，当前账号不是管理员`
    }
    return String(error?.response?.data?.detail || error?.message || fallback).slice(0, 300)
  }

  ipcMain.handle('gc:units', (_e, kind) => gcCall(() => api.fetchGcUnits(kind), '读取执行单元失败'))
  ipcMain.handle('gc:unfreeze', (_e, accountId) => gcCall(() => api.unfreezeGcAccount(accountId), '解冻失败'))
  ipcMain.handle('gc:update-device-code', (_e, deviceId) =>
    gcCall(() => api.updateDeviceCode(deviceId), '下发更新失败'))
  ipcMain.handle('chat:conversations', (_e, accountId) =>
    gcCall(() => api.fetchChatConversations(accountId), '读取会话失败'))
  ipcMain.handle('chat:messages', (_e, id) =>
    gcCall(() => api.fetchChatMessages(id), '读取消息失败'))
  ipcMain.handle('chat:reply', (_e, { conversationId, text } = {}) =>
    gcCall(() => api.replyChatConversation(conversationId, text), '回复排队失败'))
  ipcMain.handle('chat:read', (_e, id) =>
    gcCall(() => api.markChatRead(id), '标记已读失败'))
  ipcMain.handle('chat:reply-rate', (_e, { accountId, byAccount } = {}) =>
    gcCall(() => api.fetchChatReplyRate(accountId, byAccount), '读取回复率失败'))
  ipcMain.handle('adspower:profiles', async () => listAdsPowerProfiles({
    group: store.getSettings()?.adsPowerGroup || ''
  }))
  // ---- 浏览器环境管理（/envs 页面）----
  // 这一组**不做分组过滤**：环境管理页要看见全机所有环境，包括归执行端那批和
  // 还没登记用途的孤儿环境——看不见就没法把它们收编。驱动权仍由本机代理按
  // 用途登记表强制（start/stop 不符归属会被 403，界面如实显示理由）。
  const envCall = async (label, fn) => {
    try {
      return { ok: true, data: await fn() }
    } catch (error) {
      return { ok: false, reason: String(error?.message || `${label}失败`).slice(0, 400) }
    }
  }
  ipcMain.handle('envs:list', () => envCall('读取环境清单', () => listEnvs({ local: localExecutor() })))
  ipcMain.handle('envs:create', (_e, payload = {}) =>
    envCall('新建环境', () => createEnv(payload)))
  ipcMain.handle('envs:purpose', (_e, { userId, purpose } = {}) =>
    envCall('改用途', () => setEnvPurpose(userId, purpose)))
  ipcMain.handle('envs:delete', (_e, { userIds } = {}) =>
    envCall('删除环境', () => deleteEnvs(userIds)))
  // 删环境前查它对应哪几家店铺，删的时候一并停用（见 env-shops.js）。
  // 这两条打的是 ERP：失败原因走 erpReason，403 要说清是谁、缺什么权限。
  ipcMain.handle('envs:shops', async (_e, { userId } = {}) => {
    try {
      return { ok: true, data: shopsForEnv(await api.fetchGcBindShops(), userId) }
    } catch (error) {
      return { ok: false, reason: erpReason(error, '查环境对应的店铺', '查不到对应店铺') }
    }
  })
  ipcMain.handle('envs:disable-shops', async (_e, { shopIds } = {}) => {
    const ids = (Array.isArray(shopIds) ? shopIds : []).map((id) => String(id || '').trim()).filter(Boolean).slice(0, 20)
    try {
      for (const id of ids) await api.disableSaleShop(id)
      return { ok: true, data: { disabled: ids } }
    } catch (error) {
      return { ok: false, reason: erpReason(error, '停用店铺', '停用店铺失败') }
    }
  })
  ipcMain.handle('envs:start', (_e, { userId } = {}) =>
    envCall('启动环境', () => startEnv(userId)))
  ipcMain.handle('envs:stop', (_e, { userId } = {}) =>
    envCall('关闭环境', () => stopEnv(userId)))
  ipcMain.handle('envs:login-state', (_e, { userId, openTab } = {}) =>
    envCall('回读登录态', () => probeEnvLogin(userId, { openTab: Boolean(openTab) })))
  ipcMain.handle('envs:purposes', () => envCall('读取用途登记表', () => listEnvPurposes()))
  ipcMain.handle('envs:executors', () =>
    envCall('读取执行端状态', () => listExecutors({ local: localExecutor() })))
  ipcMain.handle('envs:executor-start', (_e, { userId } = {}) =>
    envCall('启动执行端', () => startExecutorFor(userId, { local: localExecutor() })))
  ipcMain.handle('envs:executor-stop', (_e, { userId, stopBrowser } = {}) =>
    envCall('停止执行端', () => stopExecutorFor(userId, { stopBrowser: Boolean(stopBrowser), local: localExecutor() })))
  // 执行端版本：本机下好的、每个在跑的实际跑的、线上最新的。线上取不到不算错，latest 给 null。
  ipcMain.handle('executor:versions', () => envCall('读取执行端版本', async () => {
    const local = await localExecutor().versions()
    const latest = await fetchExecutorCodeManifest().catch(() => null)
    return { ...local, latest: latest && { codeVersion: Number(latest.codeVersion), versionName: String(latest.versionName || '') } }
  }))
  // 更新执行端：下新代码 + 逐个重启落后的执行端。只重启进程，浏览器不关（stopBrowser=false）。
  ipcMain.handle('executor:update', () => envCall('更新执行端', async () => {
    const local = localExecutor()
    const v = await local.versions()
    if (v.kind !== 'packaged') throw new Error('这台电脑跑的是源码版执行端，改代码即生效，不走热更新')
    return updateExecutors({
      root: v.root,
      disk: v.disk,
      running: v.running,
      manifest: await fetchExecutorCodeManifest(),
      stop: (uid) => stopExecutorFor(uid, { stopBrowser: false, local }),
      start: (uid) => startExecutorFor(uid, { local }),
      // 重启前对调度中心报备、等手上的任务跑完；重启后收尾，被打断的任务由调度中心重新派
      deviceIdOf: (uid) => local.deviceIdOf(uid),
      begin: (deviceId) => api.beginDeviceMaintenance(deviceId),
      end: (deviceId) => api.endDeviceMaintenance(deviceId),
      runningNow: async () => (await local.versions()).running
    })
  }))
  // 暂停，准备重启电脑 / 恢复（restart-pause.js）。进度和结果经 restart:state 推给所有窗口
  ipcMain.handle('restart:state', () => restartSnapshot())
  ipcMain.handle('restart:pause', () => runRestartOp('pause', pauseForRestartNow))
  ipcMain.handle('restart:resume', () => runRestartOp('resume', resumeAfterPauseNow))
  ipcMain.handle('envs:purpose-save', (_e, { name, owner } = {}) =>
    envCall('保存用途', () => saveEnvPurpose(name, owner)))
  ipcMain.handle('envs:purpose-delete', (_e, { name } = {}) =>
    envCall('删除用途', () => removeEnvPurpose(name)))
  ipcMain.handle('adspower:open-preview', async (_e, { accountId } = {}) => {
    const acc = accountById(accountId)
    if (!acc) return { ok: false, reason: '找不到对应账号，无法打开 AdsPower 窗口' }
    if (!isAdsPowerAccount(acc)) {
      return { ok: false, reason: '当前账号未绑定 AdsPower，请先在账号设置中绑定 AdsPower 环境' }
    }
    try {
      const contents = await openAdsPowerProfile(acc)
      return {
        ok: true,
        provider: 'adspower',
        profileId: contents.profileId,
        url: contents.getURL()
      }
    } catch (error) {
      return { ok: false, reason: String(error?.message || '打开 AdsPower 窗口失败').slice(0, 240) }
    }
  })
  ipcMain.handle('accounts:remove', async (_e, id) => {
    await sm.destroyView(id)
    store.removeAccount(id)
    return { ok: true }
  })

  // ---- 设置 ----
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch) => {
    store.setSettings(patch)
    scheduler.rearmDaily()
    // 本体地址改了要当场生效：让人改完还得重启，跟不能改没区别。
    if (patch && 'adsPowerDirectUrl' in patch) applyAdsPowerDirectUrl()
    return store.getSettings()
  })

  // AdsPower 本体地址：设置项 → adspower.js。地址写坏了不让它把应用带崩，
  // 退回默认端口并出声——界面上那条报错会把当前用的地址写出来。
  // 只认表里这三条 key，渲染层传不进来任意 URL。
  // 用 hasOwn 而不是直接索引：'toString'/'constructor' 这类键会从 Object 原型上
  // 取到真值，照着往下走就等于拿一个函数去 openExternal。再补一道 https 断言兜底。
  ipcMain.handle('docs:open-adspower', (_e, key) => {
    const name = String(key || '')
    const url = Object.hasOwn(ADSPOWER_DOCS, name) ? ADSPOWER_DOCS[name] : ''
    if (typeof url !== 'string' || !url.startsWith('https://')) return { ok: false, reason: '未知的文档' }
    shell.openExternal(url)
    return { ok: true, url }
  })
  ipcMain.handle('docs:list-adspower', () => ({ ...ADSPOWER_DOCS }))

  ipcMain.handle('adspower:direct-url', () => ({
    url: getDirectApiUrl(),
    configured: String(store.getSettings()?.adsPowerDirectUrl || '')
  }))

  // ---- 任务 / 爬取 ----
  ipcMain.handle('tasks:plan', () => scheduler.previewPlan())
  ipcMain.handle('crawl:start', (_e, options) => scheduler.start(options || {}))
  ipcMain.handle('crawl:start-queue', (_e, { kind = 'anomaly' } = {}) => scheduler.start({ trigger: 'queue', queueKind: kind }))
  ipcMain.handle('crawl:stop', () => scheduler.stop())
  ipcMain.handle('crawl:status', () => ({ running: scheduler.isRunning() }))

  // ---- 本地 Excel 任务中心 ----
  ipcMain.handle('tasks:summary', () => taskStore.getSummary())
  ipcMain.handle('tasks:resume', () => taskStore.getResumeInfo())
  ipcMain.handle('tasks:sample', () => taskStore.getSample())
  ipcMain.handle('tasks:download-template', async () => {
    const picked = await dialog.showSaveDialog(win, {
      title: '保存卖家工作台任务 Excel 模板',
      defaultPath: join(app.getPath('downloads'), taskStore.TASK_TEMPLATE_FILE),
      filters: [{ name: '卖家工作台任务模板', extensions: ['xlsx'] }]
    })
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    try {
      return taskStore.copyTaskTemplate(picked.filePath)
    } catch (e) {
      return { ok: false, reason: '保存卖家工作台模板失败：' + (e?.message || e) }
    }
  })
  ipcMain.handle('tasks:list', (_e, params) => taskStore.getTasks(params || {}))
  ipcMain.handle('tasks:unified-list', (_e, params) => taskStore.getUnifiedTaskList(params || {}))
  ipcMain.handle('tasks:collections', () => taskStore.getCollections())
  ipcMain.handle('tasks:runs', (_e, params) => taskStore.getRuns(params || {}))
  ipcMain.handle('tasks:rankings', (_e, params) => taskStore.getRankings(params || {}))
  ipcMain.handle('tasks:results', (_e, params) => taskStore.getRunResults(params || {}))
  ipcMain.handle('tasks:ai-events', (_e, params) => taskStore.getAiEvents(params || {}))
  ipcMain.handle('tasks:queues', (_e, params) => ({ ...taskStore.getTaskQueues(params || {}), aliasProvider: llmAlias.getAliasProviderStatus() }))
  ipcMain.handle('tasks:alias-status', () => llmAlias.getAliasProviderStatus())
  ipcMain.handle('tasks:manual-correction', (_e, { taskId, patch = {} } = {}) => {
    const safe = {}
    for (const field of ['brand', 'model', 'keyword', 'alias']) {
      if (patch?.[field] !== undefined) safe[field] = String(patch[field] ?? '').trim().slice(0, 240)
    }
    for (const field of ['searchTerms', 'search_terms', 'aliases']) {
      if (patch?.[field] !== undefined) safe[field] = Array.isArray(patch[field]) ? patch[field].map((value) => String(value ?? '').trim().slice(0, 240)).filter(Boolean).slice(0, 12) : String(patch[field] ?? '').trim().slice(0, 240)
    }
    return taskStore.applyManualTaskCorrection(taskId, safe)
  })
  ipcMain.handle('tasks:recollect', (_e, { taskId, mode = 'local', syncWms = false, operator = 'manual' } = {}) => {
    const task = taskStore.getActiveTask(taskId)
    if (!task) return { ok: false, reason: '当前任务不存在，不能发起复采' }
    return taskStore.requestTaskRecollect(taskId, { mode, syncWms: syncWms === true || mode === 'wms', operator })
  })
  ipcMain.handle('spu-policy:list', () => taskStore.getSpuSearchPolicies())
  ipcMain.handle('spu-policy:get', (_e, payload = {}) => {
    const { spuCode } = validateSpuPolicyPayload(payload)
    return taskStore.getSpuSearchPolicy(spuCode)
  })
  ipcMain.handle('spu-policy:set', (_e, payload = {}) => {
    const { spuCode, policy, changedBy } = validateSpuPolicyPayload(payload, { requirePolicy: true })
    return taskStore.setSpuSearchPolicy(spuCode, policy, { source: 'manual', changedBy })
  })
  ipcMain.handle('spu-policy:preview', (_e, payload = {}) => {
    const { spuCode, task } = validateSpuPolicyPayload(payload)
    const record = taskStore.getSpuSearchPolicy(spuCode)
    return {
      ok: true,
      canonicalSpu: spuCode,
      policy: record,
      effective: {
        search: task.effectiveSearchPolicy,
        blacklist: task.effectiveBlacklist,
        priceFence: task.effectivePriceFence,
        pageFilter: task.effectivePageFilter,
        displayName: task.localizedDisplayName,
        displayNameSource: task.localizedDisplayNameSource
      }
    }
  })
  ipcMain.handle('tasks:alias-suggest', async (_e, { taskId } = {}) => {
    const task = taskStore.getActiveTask(taskId)
    if (!task) return { ok: false, reason: '当前 Excel 中找不到这条任务' }
    const result = await llmAlias.suggestAliases(task)
    if (!result.ok) return result
    const saved = taskStore.setTaskAliases(task.id, result.aliases, result.source || 'llm')
    return { ...result, ...saved }
  })
  ipcMain.handle('tasks:ai-reject-search', async (_e, { taskId, reason = '' } = {}) => {
    const task = taskStore.getActiveTask(taskId)
    if (!task) return { ok: false, reason: '当前 Excel 中找不到这条任务' }
    if (!['candidate', 'search_failed'].includes(task.aiReviewStatus)) {
      return { ok: false, reason: '这条任务当前没有可打回的 AI 候选，避免重复产生联网费用' }
    }
    if (aiWebSearchInFlight.has(taskId)) return { ok: false, reason: '这条任务的联网核查正在进行，请稍候' }
    // 只有人工明确打回才触发一次供应商联网核查；搜索结果只进入复核区，不自动改型号或发布。
    const request = (async () => {
      taskStore.rejectAiReview(taskId, reason)
      const result = await llmAlias.searchTaskEvidence(task, { reason })
      const saved = taskStore.applyAiWebSearch(taskId, result)
      taskStore.recordAiEvent({
        type: 'ai-web-search',
        taskId,
        name: task.name,
        query: result.query || '',
        source: result.source || 'web-search',
        estimatedCostCny: Number(result.estimatedCostCny) || 0,
        configured: Boolean(result.configured),
        ok: Boolean(result.ok),
        resultCount: Array.isArray(result.results) ? result.results.length : 0,
        reason: result.reason || ''
      })
      return { ...result, ...saved }
    })()
    aiWebSearchInFlight.set(taskId, request)
    try {
      return await request
    } finally {
      aiWebSearchInFlight.delete(taskId)
    }
  })
  ipcMain.handle('tasks:ai-review-approve', (_e, { taskId } = {}) => taskStore.approveAiReview(taskId))
  ipcMain.handle('tasks:snapshot', (_e, { path } = {}) => {
    try {
      return taskStore.readSnapshot(path)
    } catch (e) {
      return { ok: false, reason: e?.message || '快照读取失败' }
    }
  })
  ipcMain.handle('tasks:export-invalid', async (_e, { runId = null } = {}) => {
    const picked = await dialog.showSaveDialog(win, {
      title: '导出错误型号 Excel',
      defaultPath: join(app.getPath('downloads'), invalidExcelFileName()),
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
    })
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    try {
      return taskStore.exportInvalidPrices({ runId, outputPath: picked.filePath })
    } catch (e) {
      return { ok: false, reason: '导出错误 Excel 失败：' + (e?.message || e) }
    }
  })
  ipcMain.handle('tasks:export-wms', async () => {
    const picked = await dialog.showSaveDialog(win, {
      title: '导出 API-SPU 关联表',
      defaultPath: join(app.getPath('downloads'), wmsMappingFileName()),
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
    })
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    try {
      return taskStore.exportWmsMapping({ outputPath: picked.filePath })
    } catch (e) {
      return { ok: false, reason: '导出对应表失败：' + (e?.message || e) }
    }
  })
  ipcMain.handle('tasks:set-enabled', (_e, { id, enabled }) => taskStore.setTaskEnabled(id, enabled))
  ipcMain.handle('tasks:settings:get', () => taskSettingsDto())
  ipcMain.handle('tasks:settings:set', (_e, patch) => {
    const next = persistWmsSettingsPatch(taskSettingsPatch(patch || {}))
    applyLaunchAtLogin(next.launchAtLogin)
    scheduler.rearmDaily()
    void getWmsSyncService().refresh({ reason: 'settings' })
    return taskSettingsDto(next)
  })
  ipcMain.handle('tasks:import-file', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '替换行情任务 Excel',
      properties: ['openFile'],
      filters: [
        { name: 'Excel 任务清单', extensions: ['xlsx', 'xls', 'xlsm'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    const path = picked.filePaths[0]
    try {
      const result = taskStore.importSpreadsheet(readFileSync(path), basename(path))
      // 第一次清洗：Excel 导入后立即用 GLM 批量标准化品牌、型号和搜索词。
      // 统一走调度器入口，历史任务、导入任务和开爬前补偿使用同一套状态与日志。
      const normalization = await scheduler.runAiNormalization({ force: true, reason: 'excel-import' })
      return {
        ok: true,
        path,
        ...result,
        aiNormalization: {
          configured: normalization.configured,
          ok: normalization.ok,
          fallback: normalization.fallback,
          updated: normalization.updated || 0,
          errors: normalization.errors || []
        }
      }
    } catch (e) {
      return { ok: false, reason: '读取任务 Excel 失败：' + (e?.message || e) }
    }
  })

  // ---- 公司 WMS 型号对接 ----
  ipcMain.handle('wms:sync', async (_e, { status = '', source = null } = {}) => {
    try {
      const state = await getWmsSyncService().refresh({ reason: 'manual', status, source })
      const ok = state.status === 'synced'
      if (ok) return { ...state, ok }
      // 失败原因只躺在 state.safeError 里。不抬成 reason，页面就永远只显示
      // 「刷新失败，已保留上次有效数据」——看不出到底是没配、角色不对还是网络断了。
      const reason = state.status === 'unconfigured'
        ? '尚未配置库存 API 凭据：REST 需要 ERP 管理员（ADMIN）账号密码，MCP 需要地址和密钥'
        : state.safeError || '刷新库存 API 失败'
      return { ...state, ok, reason: '刷新 API-SPU 失败：' + reason }
    } catch (e) {
      const detail = wms.safeWmsErrorReason(e, '刷新库存 API 失败')
      return { ok: false, reason: '刷新 API-SPU 失败：' + detail }
    }
  })
  // ---------- 上下架 ----------
  ipcMain.handle('listing:pending', async () => {
    const { fetchPendingListings } = await import('./api.js')
    return fetchPendingListings()
  })
  ipcMain.handle('listing:shops', async (_e, skuCode) => {
    const { fetchSkuShops } = await import('./api.js')
    return fetchSkuShops(String(skuCode || ''))
  })
  ipcMain.handle('listing:publish', async (_e, params = {}) => {
    assertPlainObject(params, '上架')
    assertOnlyKeys(params, ['skuCode', 'shopIds'], '上架')
    const { publishSku } = await import('./api.js')
    try {
      return { ok: true, result: await publishSku(String(params.skuCode || ''), params.shopIds ?? null) }
    } catch (error) {
      return { ok: false, reason: String(error?.response?.data?.detail || error?.message || '上架失败').slice(0, 300) }
    }
  })
  ipcMain.handle('listing:delist', async (_e, params = {}) => {
    assertPlainObject(params, '下架')
    assertOnlyKeys(params, ['skuCode', 'shopIds'], '下架')
    const { delistSku } = await import('./api.js')
    try {
      return { ok: true, result: await delistSku(String(params.skuCode || ''), params.shopIds ?? null) }
    } catch (error) {
      return { ok: false, reason: String(error?.response?.data?.detail || error?.message || '下架失败').slice(0, 300) }
    }
  })

  // ---------- 密码库填进 AdsPower ----------
  // 只回状态（指纹、批没批、填了几条），密码本身从不过 IPC（见 vault-ads.js）
  ipcMain.handle('vault-ads:state', () => vaultAds.getState())
  ipcMain.handle('vault-ads:run-now', () => vaultAds.runOnce())

  // ---------- 爬虫租约 ----------
  // 端上不本地判"谁在跑"：开/关都去服务端要答复,抢不到就把服务端那句话原样端上来。
  ipcMain.handle('crawler:state', () => workbenchDevice.getState())
  // 回 {ok, data|reason} 而不是直接抛：ipcMain.handle 的抛出到渲染层会被包成
  // 「Error invoking remote method 'crawler:list': ...」，那层前缀盖掉了真正的原因。
  ipcMain.handle('crawler:list', async () => {
    const { listLeases } = await import('./api.js')
    try {
      return { ok: true, data: await listLeases() }
    } catch (error) {
      return { ok: false, reason: erpReason(error, '爬虫开关', '读不到爬虫现状') }
    }
  })
  ipcMain.handle('crawler:set', async (_e, params = {}) => {
    assertPlainObject(params, '爬虫开关')
    assertOnlyKeys(params, ['feature', 'on'], '爬虫开关')
    const feature = String(params.feature || '')
    if (!['market', 'image'].includes(feature)) throw new TypeError('未知的爬虫')
    try {
      const lease = params.on
        ? await workbenchDevice.turnOn(feature)
        : await workbenchDevice.turnOff(feature)
      return { ok: true, lease }
    } catch (error) {
      // 409 = 被别的电脑占着。服务端的 detail 里写了在哪台机器上，erpReason 原样带回去——
      // 换成"操作失败"会让人不知道该去哪台关掉它。
      return { ok: false, reason: erpReason(error, '爬虫开关', '操作失败') }
    }
  })
  ipcMain.handle('crawler:transfer', async (_e, params = {}) => {
    assertPlainObject(params, '爬虫转移')
    assertOnlyKeys(params, ['feature', 'toDeviceId'], '爬虫转移')
    const { transferLease } = await import('./api.js')
    try {
      return { ok: true, lease: await transferLease(String(params.feature || ''), String(params.toDeviceId || '')) }
    } catch (error) {
      return { ok: false, reason: erpReason(error, '爬虫开关', '转移失败') }
    }
  })
  ipcMain.handle('crawler:runs', async (_e, limit = 20) => {
    const { listCrawlRuns } = await import('./api.js')
    try {
      return await listCrawlRuns(Number(limit) || 20)
    } catch (error) {
      return { runs: [], reason: erpReason(error, '采集轮次', '读不到轮次') }
    }
  })
  ipcMain.handle('crawler:run-now', async () => {
    // 管理员点「跑一轮」：只登记，不在这里开跑。开跑由持有租约的那台电脑在
    // 下一拍心跳里看到派单、认领之后自己起——哪怕点按钮的人就坐在那台机器前。
    // 这样「谁跑」永远只有服务端一个答案。
    const { createCrawlRun } = await import('./api.js')
    try {
      return { ok: true, run: await createCrawlRun({ trigger: 'manual' }) }
    } catch (error) {
      return { ok: false, reason: erpReason(error, '发起采集', '发起失败') }
    }
  })
  ipcMain.handle('crawler:snapshot', async (_e, runId) => {
    const { requestRunSnapshot } = await import('./api.js')
    try {
      return { ok: true, req: await requestRunSnapshot(String(runId || '')) }
    } catch (error) {
      return { ok: false, reason: String(error?.response?.data?.detail || error?.message || '取回失败').slice(0, 300) }
    }
  })
  ipcMain.handle('crawler:rename-pc', (_e, params = {}) => {
    assertPlainObject(params, '改电脑名')
    assertOnlyKeys(params, ['name'], '改电脑名')
    return { ok: true, name: workbenchDevice.setDeviceName(params.name) }
  })

  ipcMain.handle('wms:state', () => ({ ...wms.getWmsState(), ...getWmsSyncService().getState() }))
  ipcMain.handle('wms:catalog', (_e, params = {}) => {
    assertPlainObject(params, 'WMS catalog')
    assertOnlyKeys(params, ['q', 'page', 'pageSize'], 'WMS catalog')
    const query = validateMarketProjectionPayload({ ...params, marketGroup: 'all', marketPage: 1, marketPageSize: 1 })
    const page = wms.getWmsCatalog({ q: query.q, page: query.page, pageSize: query.pageSize })
    return { ...page, items: page.items.map((item) => ({ ...item })) }
  })
  ipcMain.handle('wms:projection', (_e, params = {}) => {
    const query = validateMarketProjectionPayload(params)
    const projection = wms.getWmsProjection(query)
    return {
      schemaVersion: projection.schemaVersion,
      sync: { ...projection.sync, ...getWmsSyncService().getState() },
      inventory: projection.inventory,
      market: sanitizeMarketQueue(projection.market)
    }
  })
  ipcMain.handle('wms:update-sku', async (_e, params = {}) => {
    try {
      assertPlainObject(params, 'WMS API writeback')
      assertOnlyKeys(params, ['taskId', 'skuCode', 'patch', 'timeoutMs'], 'WMS API writeback')
      assertPlainObject(params.patch || {}, 'WMS API writeback patch')
      assertOnlyKeys(params.patch || {}, ['product_name', 'brand', 'model', 'search_terms'], 'WMS API writeback patch')
      if (params.timeoutMs != null && (!Number.isInteger(Number(params.timeoutMs)) || Number(params.timeoutMs) < 100 || Number(params.timeoutMs) > 60000)) throw new TypeError('timeoutMs is invalid')
      const result = await wms.updateWmsSku(params)
      return {
        ok: Boolean(result?.ok),
        skuCode: String(result?.skuCode || params.skuCode || '').slice(0, 160),
        verified: Boolean(result?.verified),
        item: result?.item ? sanitizeWmsItem(result.item) : null,
        audit: result?.audit || null,
        syncedAt: result?.syncedAt || null
      }
    } catch (error) {
      return { ok: false, reason: `API 名称回写失败：${wms.safeWmsErrorReason(error, 'API 名称回写失败')}` }
    }
  })
  ipcMain.handle('wms:correct-and-recollect', async (_e, params = {}) => {
    try {
      assertPlainObject(params, 'WMS correction')
      assertOnlyKeys(params, ['taskId', 'skuCode', 'patch', 'confirm', 'operator'], 'WMS correction')
      assertPlainObject(params.patch || {}, 'WMS correction patch')
      assertOnlyKeys(params.patch || {}, ['brand', 'model', 'keyword', 'search_terms', 'aliases'], 'WMS correction patch')
      return await wms.correctWmsSkuAndRecollect({ ...params, confirm: params?.confirm === true })
    } catch (error) {
      return { ok: false, reason: `WMS 品牌/型号修正失败：${wms.safeWmsErrorReason(error, 'WMS 品牌/型号修正失败')}` }
    }
  })

  // Price preview/selection is deliberately separate from API price apply.
  // This IPC only returns an auditable intent; Plan 03-06 owns the conditional
  // GET -> version/ETag PUT -> GET verification gate.  With no installed gate,
  // the response is visibly blocked and no network mutation is attempted.
  ipcMain.handle('market:price-preview', (_e, params = {}) => {
    const { taskId } = validatePricePreviewPayload(params)
    const preview = buildMarketPricePreview(taskId)
    if (!preview) return { ok: false, status: 'blocked', reason: '当前 API-SPU/Excel 投影中找不到该任务' }
    return { ok: true, preview }
  })
  ipcMain.handle('market:price-select', async (_e, params = {}) => {
    const selection = validatePricePreviewPayload(params, { selection: true })
    const previewResponse = buildMarketPricePreview(selection.taskId)
    if (!previewResponse) return { ok: false, status: 'blocked', reason: '当前任务不存在，未产生价格意图' }
    if (previewResponse.previewId !== selection.previewId || previewResponse.policyVersion !== selection.policyVersion) return { ok: false, status: 'blocked', reason: '价格预览已过期，请重新生成预览', putIssued: false }
    try {
      const selected = selectPriceCandidate(previewResponse, {
        choice: selection.choice,
        customPrice: selection.customPrice,
        confirmed: true,
        operatorId: selection.operatorId,
        note: selection.note
      })
      const writeback = await wms.applyWmsPrice({ taskId: selection.taskId, preview: selected })
      return {
        ok: Boolean(writeback?.ok),
        status: writeback?.status || 'blocked',
        intent: selected.selection,
        selectedPrice: selected.selectedPrice,
        writeback
      }
    } catch (error) {
      return { ok: false, status: 'blocked', putIssued: false, reason: String(error?.message || '价格候选确认失败').slice(0, 240) }
    }
  })
  ipcMain.handle('market:history', (_e, params = {}) => {
    const query = validateMarketHistoryPayload(params)
    const result = taskStore.getRunResults(query)
    return { ...result, items: result.items.map(sanitizeMarketRow), group: query.group, sync: { ...wms.getWmsState(), ...getWmsSyncService().getState() } }
  })

  // ---- 卖家主页采集（独立于关键词行情模式） ----
  ipcMain.handle('seller:import-file', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '导入卖家主页链接',
      properties: ['openFile'],
      filters: [
        { name: '链接文件', extensions: ['txt', 'csv', 'json', 'jsonl', 'ndjson', 'xlsx', 'xls'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    const path = picked.filePaths[0]
    try {
      const name = basename(path)
      const raw = readFileSync(path)
      const result = /\.xlsx?$/i.test(name)
        ? sellerStore.importSpreadsheet(raw, name)
        : sellerStore.importLinks(raw.toString('utf8'), name)
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, reason: '读取链接文件失败: ' + (e?.message || e) }
    }
  })
  ipcMain.handle('seller:legacy-summary', () => sellerStore.getLegacyQueueSummary())
  ipcMain.handle('seller:import-legacy', () => sellerStore.importLegacyQueue())
  ipcMain.handle('seller:settings:get', sellerIpcHandler('settings.get', () => sellerSettingsDto()))
  ipcMain.handle('seller:settings:set', sellerIpcHandler('settings.set', (_e, patch) => {
    const next = sellerStore.setSettings(validateSellerSettings(patch))
    sellerScheduler.rearmWeekly()
    return { ...sellerSettingsDto(), throttleMinMs: next.throttleMinMs, throttleMaxMs: next.throttleMaxMs }
  }))
  ipcMain.handle('seller:sources:query', sellerIpcHandler('sources.query', (_e, params = {}) => {
    const result = sellerStore.getSources(validateSellerListPaging(params, SELLER_QUEUE_STATUSES))
    return { total: result.total, items: result.items.map(sellerQueueRowDto) }
  }))
  ipcMain.handle('seller:items:query', sellerIpcHandler('items.query', (_e, params = {}) => {
    const result = sellerStore.queryItems(validateSellerListPaging(params, ['active', 'sold', 'unknown'], []))
    return { ...result, items: result.items.map(sellerItemRowDto) }
  }))
  ipcMain.handle('seller:snapshots:query', sellerIpcHandler('snapshots.query', (_e, params = {}) => {
    const result = sellerStore.querySellerSnapshots(validateSellerSnapshotQuery(params))
    return { ...result, items: result.items.map(sellerSnapshotDto) }
  }))
  ipcMain.handle('seller:queue:detail', sellerIpcHandler('queue.detail', (_e, payload = {}) => {
    return sellerQueueDetailDto(sellerStore.getSellerQueueDetail(validateSellerQueueDetailPayload(payload)))
  }))
  ipcMain.handle('seller:snapshot', sellerIpcHandler('snapshot.get', (_e, payload = {}) => {
    assertPlainObject(payload, 'seller snapshot')
    assertOnlyKeys(payload, ['snapshotId', 'path'], 'seller snapshot')
    const snapshotId = payload.snapshotId == null ? '' : String(payload.snapshotId).trim()
    const path = payload.path == null ? '' : String(payload.path).trim()
    if (!snapshotId && !path) throw new TypeError('seller snapshotId or path is required')
    return sellerSnapshotReadDto(sellerStore.readSellerSnapshot({ snapshotId, path }))
  }))
  ipcMain.handle('seller:events', sellerIpcHandler('events', () => sellerStore.getRecentEvents().map(sellerRunEventDto)))
  ipcMain.handle('seller:status', sellerIpcHandler('status', () => ({ running: sellerScheduler.isRunning(), currentRun: currentSellerRunDto() })))
  ipcMain.handle('seller:summary', sellerIpcHandler('summary', () => sellerSummaryDto()))
  ipcMain.handle('seller:queues:query', sellerIpcHandler('queues.query', (_e, payload) => {
    const filter = validateSellerQueueFilter(payload)
    const result = sellerStore.querySellerMembership(filter)
    return { ...filter, total: result.total, items: result.items.map(sellerQueueRowDto) }
  }))
  ipcMain.handle('seller:queues:export', sellerIpcHandler('queues.export', async (_e, payload) => {
    assertPlainObject(payload, 'seller queue export')
    const detail = payload.mode === 'detail' || payload.detail === true
    if (payload.mode != null && !['summary', 'detail'].includes(String(payload.mode))) throw new TypeError('seller export mode is invalid')
    const filterPayload = { ...payload }
    delete filterPayload.mode
    delete filterPayload.detail
    const filter = validateSellerQueueFilter(filterPayload, { paging: false })
    const picked = await dialog.showSaveDialog(win, {
      title: detail ? '导出卖家详细证据 Excel' : '导出当前卖家证据队列',
      defaultPath: join(app.getPath('downloads'), detail ? `卖家详细证据_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')}.xlsx` : sellerExportFileName(filter)),
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
    })
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true, rowCount: 0, filters: filter }
    if (detail) return sellerStore.exportSellerDetails({ filter, outputPath: picked.filePath })
    const first = sellerStore.querySellerMembership({ ...filter, page: 1, pageSize: SELLER_EXPORT_PAGE_SIZE })
    const rows = []
    for (let page = 1; rows.length < first.total; page += 1) {
      const result = page === 1 ? first : sellerStore.querySellerMembership({ ...filter, page, pageSize: SELLER_EXPORT_PAGE_SIZE })
      if (!result.items.length) break
      rows.push(...result.items.map(sellerQueueRowDto))
    }
    if (rows.length !== first.total) throw Object.assign(new Error('导出行数与当前筛选队列不一致'), { code: 'SELLER_EXPORT_COUNT_MISMATCH' })
    const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
      '卖家ID': row.sellerId,
      '卖家主页': row.url,
      '卖家名称': row.sellerName,
      '主营内容': row.mainContent,
      '主营类型': row.mainType,
      '分类': row.category,
      '榜单': row.boardName || row.board,
      '来源榜单排名': row.sourceBoardRanks,
      '榜单排名': row.sourceRank ?? row.rank,
      '来源序号': row.sourceOrdinal,
      '榜单槽位数': row.sourceSlotCount,
      '城市': row.cities,
      'Excel行': row.excelRow,
      '当前状态': row.status,
      '原因代码': row.reasonCode,
      '原因说明': row.reason,
      '正式尝试数': row.attemptCount,
      '在售已采': row.activeCount,
      '在售期望': row.expectedActive,
      '已售已采': row.soldCount,
      '已售期望': row.expectedSold,
      '最近更新时间': row.updatedAt,
      '最近持久写入': row.lastDurableWriteAt
    })))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, '卖家证据队列')
    XLSX.writeFile(workbook, picked.filePath)
    return { ok: true, canceled: false, rowCount: rows.length, filters: filter }
  }))
  ipcMain.handle('seller:queues:export-detail', sellerIpcHandler('queues.export-detail', async (_e, payload) => {
    const filter = validateSellerQueueFilter(payload, { paging: false })
    const picked = await dialog.showSaveDialog(win, {
      title: '导出卖家详细证据 Excel',
      defaultPath: join(app.getPath('downloads'), `卖家详细证据_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')}.xlsx`),
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
    })
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true, filters: filter }
    return sellerStore.exportSellerDetails({ filter, outputPath: picked.filePath })
  }))
  ipcMain.handle('seller:runs:query', sellerIpcHandler('runs.query', (_e, payload = {}) => {
    const { page, pageSize, q } = validateSellerPaging(payload)
    let rows = sellerStore.queryEventHistory({ page: 1, pageSize: 1000000 }).items.map(sellerRunEventDto).filter((event) => ['start', 'recovery_start', 'schedule', 'seller-watchdog-restart'].includes(event.type))
    if (q) rows = rows.filter((row) => Object.values(row).some((value) => String(value || '').toLowerCase().includes(q.toLowerCase())))
    const start = (page - 1) * pageSize
    return { items: rows.slice(start, start + pageSize), total: rows.length, page, pageSize }
  }))
  ipcMain.handle('seller:run:get', sellerIpcHandler('run.get', (_e, payload) => {
    assertPlainObject(payload, 'run lookup')
    assertOnlyKeys(payload, ['runId'], 'run lookup')
    const runId = String(payload.runId || '').trim()
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(runId)) throw new TypeError('runId is invalid')
    const detail = sellerStore.getSellerRunDetail(runId)
    return {
      runId,
      trigger: String(detail.trigger || ''),
      outcome: String(detail.outcome || ''),
      events: detail.events.map(sellerRunEventDto).filter((event) => event.runId === runId),
      sellers: detail.sellers.map(sellerQueueRowDto),
      total: detail.total,
      current: sellerScheduler.getStatus().job?.runId === runId ? sellerSummaryDto().currentRun : null
    }
  }))
  ipcMain.handle('seller:schedule:get', sellerIpcHandler('schedule.get', () => sellerScheduleDto()))
  ipcMain.handle('seller:schedule:set', sellerIpcHandler('schedule.set', (_e, payload) => {
    assertPlainObject(payload, 'schedule')
    assertOnlyKeys(payload, ['weeklyEnabled', 'weeklyDay', 'weeklyTime', 'timezone'], 'schedule')
    if (payload.weeklyEnabled != null && typeof payload.weeklyEnabled !== 'boolean') throw new TypeError('weeklyEnabled must be boolean')
    const next = sellerStore.setSettings({ ...payload, timezone: SELLER_TIMEZONE })
    sellerScheduler.rearmWeekly()
    return { ...sellerScheduleDto(), weeklyEnabled: Boolean(next.weeklyEnabled) }
  }))
  ipcMain.handle('seller:accounts:status', sellerIpcHandler('accounts.status', async () => Promise.all(store.getAccounts().map(async (account) => ({
    id: String(account.id || ''),
    name: String(account.name || ''),
    enabled: Boolean(account.enabled),
    loggedIn: await checkXianyuLogin(account),
    safety: sellerStore.getAccountSafetyState(account.id)
  })))))
  ipcMain.handle('seller:start', sellerIpcHandler('start', (_e, payload = {}) => {
    assertPlainObject(payload, 'seller start')
    assertOnlyKeys(payload, ['trigger', 'sample'], 'seller start')
    const trigger = String(payload.trigger || 'manual')
    const sample = String(payload.sample || 'all')
    if (!SELLER_START_TRIGGERS.includes(trigger)) throw new TypeError('seller start trigger is invalid')
    if (!Object.hasOwn(SELLER_SAMPLE_LIMITS, sample)) throw new TypeError('seller start sample is invalid')
    return sellerScheduler.start({ reset: false, maxSellers: SELLER_SAMPLE_LIMITS[sample], trigger })
  }))
  ipcMain.handle('seller:stop', sellerIpcHandler('stop', (_e, payload) => {
    if (payload != null) throw new TypeError('seller stop accepts no payload')
    return sellerScheduler.stop()
  }))

  // ---- 结果日志 ----
  ipcMain.handle('results:query', (_e, params) => store.queryResults(params))
  ipcMain.handle('results:clear', () => {
    store.clearResults()
    return { ok: true }
  })

  // ---- 预览（已禁用） ----
  // Keep explicit rejection handlers for stale renderer bundles.  They must
  // never attach a WebContentsView or navigate Electron's own Chromium.
  const previewDisabled = () => ({
    ok: false,
    reason: 'Electron 内置预览已禁用，请从账号配置打开对应的 AdsPower 窗口'
  })
  ipcMain.handle('preview:attach', previewDisabled)
  ipcMain.handle('preview:set-bounds', previewDisabled)
  ipcMain.handle('preview:detach', previewDisabled)
  ipcMain.handle('preview:goto-home', previewDisabled)
  ipcMain.handle('preview:reload', previewDisabled)

  // ---- 窗口 ----
  ipcMain.handle('win:hide', () => { win.hide(); return { ok: true } })
  ipcMain.handle('win:minimize', () => { win.minimize(); return { ok: true } })

  // 一次性清理：旧版把管理员密码存在工位上，换成设备账号窄接口后它已无用途。
  try {
    const purged = store.purgeLegacyWmsAdminCredentials()
    if (purged?.changed) console.log('[wms] 已清除盘上遗留的回写管理账号凭据（改用设备账号令牌回写）')
  } catch (error) {
    console.warn('[wms] 清理遗留回写凭据失败，忽略：', error?.message || error)
  }

  ipcMain.handle('wms:clear-writeback-credentials', () => {
    const result = store.clearWmsRestCredentials()
    if (!result.ok) return { ok: false, reason: '系统安全存储不可用，无法清除' }
    return { ok: true, ...taskSettingsDto() }
  })

  // ---- 代码热更新 ----
  ipcMain.handle('code-update:state', () => {
    if (!codeUpdateState.current) codeUpdateState.current = currentCodeVersion()
    return { ...codeUpdateDto(), disabled: !hotUpdateEnabled() }
  })
  ipcMain.handle('code-update:check', () => checkCodeUpdate({ silent: false }))
  ipcMain.handle('code-update:download', async () => {
    if (codeUpdateState.downloading) return { ok: false, reason: '正在下载中' }
    if (!codeUpdateState.latest) return { ok: false, reason: '请先检查更新' }
    if (!hotUpdateEnabled()) return { ok: false, reason: '当前构建不启用热更新（开发模式或整包分发版本）' }
    codeUpdateState.downloading = true
    codeUpdateState.error = ''
    pushCodeUpdateState()
    try {
      // 下载前现取一次清单。开着的行情台手里那份可能是几小时前取的，而发版会换掉
      // 服务器上的旧文件——照旧清单去下就是 404（2026-10-06 现场：v26 上线后点
      // 「下载更新」，请求的还是 v25 的文件名）。
      const latest = await codeUpdate.fetchManifest()
      codeUpdateState.latest = latest
      if (!codeUpdate.shouldUpdate(codeUpdateState.current || currentCodeVersion(), latest)) {
        codeUpdateState.updateAvailable = false
        return { ok: false, reason: '已经是最新版本' }
      }
      const result = await codeUpdate.downloadCodeUpdate({
        manifest: latest,
        userDataDir: app.getPath('userData'),
        onProgress: (progress) => {
          codeUpdateState.progress = progress
          pushCodeUpdateState()
        }
      })
      codeUpdateState.updateAvailable = false
      codeUpdateState.readyToApply = true
      return { ok: true, ...result }
    } catch (e) {
      codeUpdateState.error = e?.message || String(e)
      return { ok: false, reason: codeUpdateState.error }
    } finally {
      codeUpdateState.downloading = false
      pushCodeUpdateState()
    }
  })
  // 重启才换代码：loader 只在进程启动时决定加载哪一份。
  ipcMain.handle('code-update:restart', () => {
    isQuiting = true
    app.relaunch()
    app.exit(0)
    return { ok: true }
  })
  ipcMain.handle('code-update:rollback', () => {
    try {
      const result = codeUpdate.rollbackCodeUpdate({ userDataDir: app.getPath('userData') })
      if (result.ok) {
        codeUpdateState.readyToApply = true
        codeUpdateState.updateAvailable = false
        pushCodeUpdateState()
      }
      return result
    } catch (e) {
      return { ok: false, reason: e?.message || String(e) }
    }
  })
}

// GPU/工具进程崩溃也记下来（不影响运行，纯诊断）
app.on('child-process-gone', (_e, details) => {
  if (details?.reason && details.reason !== 'clean-exit') {
    logCrash('child-process-gone', `${details.type} ${details.reason} exitCode=${details.exitCode}`)
  }
})

app.whenReady().then(() => {
  // 第二个实例已经 app.quit()；这里再兜一层，绝不建第二个窗口/启动第二套调度。
  if (!isPrimaryInstance) return
  // 本体地址要在任何 AdsPower 调用之前落位，否则第一次刷新还是打默认端口。
  applyAdsPowerDirectUrl()
  registerIpc()
  createWindow()
  // 心跳一起步这台电脑就出现在管理员的「哪台机器」表里。不等人登录到某个页面——
  // 看不见的机器没法被指派爬虫。
  workbenchDevice.start()
  workbenchDevice.onChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('crawler:state', state)
    }
  })
  // 密码库填进 AdsPower：没登录的时候每一拍直接跳过，登录后自己开始
  vaultAds.start()
  vaultAds.onChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('vault-ads:state', state)
    }
  })
  createTray()
  applyLaunchAtLogin(taskStore.getSettings().launchAtLogin)

  // 开机自恢复执行端：先照「暂停，准备重启电脑」的清单恢复（那几个记的是人工停止，
  // 下面的自恢复不会碰它们），再把台账里非人工停止的拉起来（工位无人值守闭环的最后
  // 一环；两步都会先等 AdsPower 开好）。
  void (async () => {
    if (restartPlan().read()) await runRestartOp('resume', resumeAfterPauseNow)
    if (taskStore.getSettings().autoResumeExecutors) await resumeExecutorsWithRetry()
  })()

  // 启动后台静默看一眼有没有新代码；失败只记状态，不打扰用户也不拦启动。
  codeUpdateState.current = currentCodeVersion()
  void checkCodeUpdate({ silent: true })

  // 应用图标：打包时由 electron-builder 写进安装包，但**已经装好的机器只能靠热更新
  // 拿到新代码，拿不到新图标**——所以运行时再设一次。开发态也因此能看到真实图标，
  // 而不是 Electron 自带那个。
  try {
    // 找一张能用的图标。顺序有讲究：
    //   1) out/renderer/app-icon.png——它**随热更新走**，所以已经装好的机器
    //      换代码就能换图标；
    //   2) 仓库 resources/（开发态）；
    //   3) 安装包 resources/（打包态可能有）。
    //
    // 注意别拿界面里那枚 logo 来当 Dock 图标：它是**铺满整块**的，
    // 而 Dock 图标必须自带四周留白和圆角，直接用会变成一张硬边方块贴纸。
    const candidates = [join(__dirname, '../renderer/app-icon.png')]
    candidates.push(join(__dirname, '../../resources/icon-workbench.png'))
    if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'icon-workbench.png'))

    const iconPath = candidates.find((p) => existsSync(p))
    if (iconPath) {
      if (process.platform === 'darwin') app.dock?.setIcon(iconPath)
      else win?.setIcon?.(iconPath)
      console.log('[brand] 应用图标已设置：', iconPath)
    }
  } catch (error) {
    console.warn('[brand] 设置应用图标失败，忽略：', error?.message || error)
  }

  // 日志代理：启动后问一次「服务端要不要我的日志」，之后每 10 分钟再问。
  // 桌面端没有心跳，这就是它的「在线时 + 下次启动」两种情况的同一条路。
  try {
    const summary = logSummary()
    console.log(`[logs] 本地 ${summary.files} 个日志文件、${(summary.bytes / 1048576).toFixed(1)}MB，最早 ${summary.oldest || '—'}（保留 ${summary.keepDays} 天）`)
    startLogAgent({
      store: taskStore,
      gcGet: (path, params) => api.gcGet(path, params),
      gcUpload: (requestId, blob, filename) => api.gcUploadLogs(requestId, blob, filename)
    })
  } catch (error) {
    console.warn('[logs] 日志代理启动失败，忽略：', error?.message || error)
  }

  // 网页快照只在开爬时产生、却从不自动消失；启动清一次，长期不开爬的机器也不会一直占着盘。
  try {
    const pruned = taskStore.pruneSnapshots()
    if (pruned.deleted) console.log(`[snapshot] 清理 ${pruned.deleted} 份快照，释放 ${(pruned.freedBytes / 1048576).toFixed(1)}MB`)
  } catch (error) {
    logCrash('snapshot-prune', error)
  }

  // WMS is an application service, not a page feature.  It starts after the
  // Electron lifecycle is ready (safeStorage is available here), continues
  // while the window is hidden in the tray, and exposes only sanitized state.
  try {
    migrateTaskStoreWmsState(taskStore)
    migrateLegacyWmsSettings()
  } catch (error) {
    logCrash('wms-credential-migration', error)
  }
  const wmsService = getWmsSyncService()
  wmsService.setEmitter((state) => {
    if (win && !win.isDestroyed()) win.webContents.send('wms:sync-state', state)
  })
  wmsService.start()

  // 调度进度事件 → 转发渲染层
  scheduler.setEmitter((type, payload) => {
    let nextPayload = payload
    if (type === 'done' && payload?.runId && Number(payload.invalidPrice) > 0) {
      try {
        const exported = taskStore.exportInvalidPrices({
          runId: payload.runId,
          outputPath: join(app.getPath('downloads'), invalidExcelFileName())
        })
        nextPayload = { ...payload, invalidExcelPath: exported.path, invalidExcelCount: exported.count }
      } catch (e) {
        nextPayload = { ...payload, invalidExcelError: e?.message || String(e) }
      }
    }
    if (win && !win.isDestroyed()) win.webContents.send('crawl:event', { type, payload: nextPayload })
  })
  sellerScheduler.setEmitter((type, payload) => {
    if (type === 'seller-start') {
      sellerRuntime = {
        runId: String(payload?.runId || ''),
        accountName: '',
        sellerId: '',
        sellerUrl: '',
        branch: '',
        collected: null,
        expected: null,
        throttleReason: `卖家间隔 ${sellerThrottleLabel()}；连续失败会自动放慢`,
        throttleEarliestAt: null,
        lastDurableWriteAt: null,
        accountStats: payload?.accountStats || {},
        startedAt: new Date().toISOString()
      }
    } else if (type === 'seller-progress') {
      const row = sellerStore.getAllSourceRows().find((item) => item.sellerId === payload?.sellerId)
      const branch = row?.currentAttempt?.branch || 'active'
      const collected = Array.isArray(row?.itemIds?.[branch]) ? row.itemIds[branch].length : 0
      sellerRuntime = {
        ...(sellerRuntime || {}),
        accountName: String(payload?.accountName || ''),
        sellerId: String(payload?.sellerId || ''),
        sellerUrl: String(payload?.sellerUrl || ''),
        branch,
        collected,
        expected: row?.expected?.[branch] ?? null,
        throttleEarliestAt: null,
        lastDurableWriteAt: row?.lastItemBatchCommittedAt || row?.persistedAt || row?.updatedAt || null,
        accountStats: payload?.accountStats || sellerRuntime?.accountStats || {}
      }
    } else if (type === 'seller-result') {
      const settings = sellerStore.getSettings()
      sellerRuntime = sellerRuntime ? {
        ...sellerRuntime,
        collected: Number(payload?.itemCount) || sellerRuntime.collected,
        throttleEarliestAt: new Date(Date.now() + Math.max(15000, Number(settings.throttleMinMs) || 15000)).toISOString(),
        throttleReason: payload?.status === 'failed'
          ? '连续失败退避；下一次访问不会早于安全间隔'
          : `卖家间隔 ${sellerThrottleLabel(settings)}；显示的是最早可继续时间`
      } : null
    } else if (type === 'seller-account-blocked' || type === 'seller-risk-control') {
      sellerRuntime = sellerRuntime ? { ...sellerRuntime, throttleReason: type === 'seller-risk-control' ? '该账号风控冷却，已停止其新增访问；其它账号继续' : '该账号登录失效，已停止其新增访问；其它账号继续' } : null
    } else if (type === 'seller-counters' && sellerRuntime) {
      sellerRuntime = { ...sellerRuntime, accountStats: payload?.accountStats || sellerRuntime.accountStats || {} }
    } else if (type === 'seller-done' || type === 'seller-error') {
      sellerRuntime = null
    }
    if (win && !win.isDestroyed()) win.webContents.send('seller:event', { type, payload })
  })
  let canonicalSellerReady = false
  try {
    const reconciliation = sellerStore.reconcileCanonicalSellerManifest()
    canonicalSellerReady = true
    sellerStore.addEvent({
      type: 'canonical_reconciliation',
      changed: Boolean(reconciliation.changed),
      count: reconciliation.canonical?.indexed || reconciliation.manifest?.count || 0,
      manifestHash: reconciliation.manifest?.sha256 || ''
    })
  } catch (error) {
    logCrash('seller-canonical-reconciliation', error)
  }
  scheduler.rearmDaily()
  if (canonicalSellerReady) sellerScheduler.rearmWeekly()

  // 历史 Excel 不需要用户重新导入：应用启动后自动补齐旧任务字段并执行首轮型号清洗。
  // 每次启动只主动补偿一次；失败会保留 pending 状态，开爬前仍按冷却时间自动补偿；不会阻塞窗口显示。
  // Let the renderer finish its first paint and initial Task Center IPC
  // request before any historical AI normalization touches the main thread.
  // The normalizer itself yields between bounded batches, but scheduling it
  // after first paint avoids competing with BrowserWindow startup entirely.
  setTimeout(() => {
    // 历史任务只补齐字段；已有本地规则结果不再随启动全量送模型，异常项由 ai_correction 队列逐条处理。
    scheduler.runAiNormalization({ reason: 'app-start', force: false }).catch((e) => logCrash('ai-normalization', e))
  }, 1500)

  // 受控后台入口：只有显式传入 --seller-crawl 才启动卖家模式，普通打开程序不改变原有行为。
  const cli = sellerCliOptions()
  if (cli) {
    setTimeout(async () => {
      if (cli.sourcePath) {
        try {
          const imported = sellerStore.importFilePath(cli.sourcePath)
          sellerStore.addEvent({ type: 'cli-source-import', path: cli.sourcePath, ...imported })
        } catch (e) {
          logCrash('seller-source-import', e)
          return
        }
      }
      sellerScheduler.start({
        reset: cli.reset,
        maxSellers: cli.maxSellers,
        testFast: cli.testFast,
        allowedSellerIds: cli.allowedSellerIds,
        trigger: cli.testFast ? `test-fast-${cli.maxSellers}` : 'manual'
      })
    }, 1500)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win.show()
  })
})

app.on('before-quit', (event) => {
  if (quitCleanupDone) return
  event.preventDefault()
  if (quitCleanupPromise) return
  isQuiting = true
  quitCleanupPromise = (async () => {
    // Stop new claims before closing the browser targets. Existing formal
    // attempts retain their durable checkpoint/lease and can be resumed.
    sellerScheduler.stop()
    await sellerScheduler.drain()
    await getWmsSyncService().stop()
    await Promise.allSettled([
      sm.destroyAll(),
      destroySellerWorkers()
    ])
  })().finally(() => {
    quitCleanupDone = true
    app.quit()
  })
})

// 收托盘后台运行：不在所有窗口关闭时退出
app.on('window-all-closed', () => {
  // 故意留空——靠托盘退出，保证后台爬取继续
})
