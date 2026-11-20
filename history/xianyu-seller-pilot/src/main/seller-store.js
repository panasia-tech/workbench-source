// 卖家主页采集的本地持久化。
//
// 关键词行情模式使用现有 store 和后端行情表；卖家主页模式的数据量更大，
// 因此把链接清单、进度和商品观测分开保存：
//   seller-sources.json       主页清单（可重复导入）
//   seller-progress.jsonl     追加式断点记录，崩溃后可恢复
//   seller-items.jsonl        商品外层卡片观测（图片/标题/价格/状态）
// 这样长任务不会把几百万条商品记录反复写入 electron-store，也不依赖大语言模型。
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { hostname } from 'os'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { pathToFileURL } from 'url'
import { gunzipSync, gzipSync } from 'zlib'
import Store from 'electron-store'
import * as XLSX from 'xlsx'
import { verifyCanonicalSellerManifest } from '../../scripts/data/generate-canonical-seller-manifest.mjs'
import { normalizeSellerHomeUrl } from './seller-worker.js'

const configuredDataDir = String(process.env.XIANYU_SELLER_DATA_DIR || '').trim()
// 0 means adaptive: the crawler stops on page evidence, not a hard item count.
// A positive value is retained only as an explicit operator safety cap.
const ADAPTIVE_MAX_ITEMS = 0
const SELLER_SETTINGS_VERSION = 6
// Version 2 contains the purpose-owned AdsPower target fix.  Before that
// fix, a seller target could inherit the profile's public-home page during
// startup and persist a false PUBLIC_HOME_FALLBACK circuit.  Keep real 429 /
// verification circuits intact, but make those known stale navigation marks
// re-eligible once, so an otherwise authenticated account is not stranded
// for six hours after an application upgrade.
const SELLER_SAFETY_POLICY_VERSION = 2
const meta = new Store({
  name: 'xianyu-seller-crawl',
  ...(configuredDataDir ? { cwd: configuredDataDir } : {}),
  defaults: {
    settings: {
      // 主页数量由页面证据决定；只有运维显式设置正数时才启用数量上限。
      maxItemsPerSeller: ADAPTIVE_MAX_ITEMS,
      // 仍保留有界滚动步数，避免页面结构异常时无限运行。
      maxScrollSteps: 500,
      pageWaitMs: 1800,
      throttleMinMs: 15000,
      throttleMaxMs: 30000,
      rateSafetyVersion: SELLER_SETTINGS_VERSION,
      recycleEvery: 50,
      weeklyEnabled: true,
      weeklyDay: 1,
      weeklyTime: '02:00',
      timezone: 'Asia/Shanghai'
    },
    job: {
      running: false,
      runId: null,
      startedAt: null,
      finishedAt: null,
      resetMode: false
    },
    lastImport: null,
    recentEvents: [],
    accountSafetyStates: {}
  }
})

const dataDir = configuredDataDir || dirname(meta.path)

function migrateSellerSafetyPolicy() {
  const currentVersion = Number(meta.get('safetyPolicyVersion') || 0)
  if (currentVersion >= SELLER_SAFETY_POLICY_VERSION) return
  const states = meta.get('accountSafetyStates') || {}
  const nextStates = { ...states }
  for (const [accountId, state] of Object.entries(nextStates)) {
    if (state?.status === 'cooling' && state.reasonCode === 'PUBLIC_HOME_FALLBACK') delete nextStates[accountId]
  }
  meta.set({
    accountSafetyStates: nextStates,
    safetyPolicyVersion: SELLER_SAFETY_POLICY_VERSION,
    safetyPolicyMigratedAt: new Date().toISOString()
  })
}

migrateSellerSafetyPolicy()

const storedSellerSettings = meta.get('settings') || {}
if (Number(storedSellerSettings.rateSafetyVersion) < SELLER_SETTINGS_VERSION || Number(storedSellerSettings.throttleMinMs) < 15000 || Number(storedSellerSettings.throttleMaxMs) < 15000 || Number(storedSellerSettings.pageWaitMs) < 1200 || !Number.isFinite(Number(storedSellerSettings.maxItemsPerSeller)) || Number(storedSellerSettings.maxItemsPerSeller) < 0) {
  meta.set('settings', {
    ...storedSellerSettings,
    // Version 5 stored 1,000 as the implicit platform boundary. That value
    // is no longer a default; migrate it to adaptive mode while preserving a
    // positive value only when it was written under the new settings version.
    maxItemsPerSeller: Number(storedSellerSettings.rateSafetyVersion) < SELLER_SETTINGS_VERSION
      ? ADAPTIVE_MAX_ITEMS
      : Math.max(0, Math.floor(Number(storedSellerSettings.maxItemsPerSeller) || ADAPTIVE_MAX_ITEMS)),
    maxScrollSteps: Number(storedSellerSettings.maxScrollSteps) === 80 ? 500 : (Number(storedSellerSettings.maxScrollSteps) || 500),
    pageWaitMs: 1800,
    throttleMinMs: 15000,
    throttleMaxMs: 30000,
    rateSafetyVersion: SELLER_SETTINGS_VERSION
  })
}

const legacyStorePath = join(dataDir, 'xianyu-electron.json')
const sourcePath = join(dataDir, 'seller-sources.json')
const progressPath = join(dataDir, 'seller-progress.jsonl')
const checkpointPath = join(dataDir, 'seller-checkpoint-v3.json')
const itemsPath = join(dataDir, 'seller-items.jsonl')
const snapshotDir = join(dataDir, 'seller-snapshots')
const reconciliationPath = join(dataDir, 'seller-canonical-reconciliation-v1.json')
const eventsDir = join(dataDir, 'seller-events')
const eventArchiveDir = join(dataDir, 'seller-events-archive')
const leaseRoot = join(dataDir, 'seller-leases')
const claimMutexPath = join(dataDir, 'seller-claim.mutex')
const SELLER_LEASE_TTL_MS = Math.max(30_000, Number(process.env.XIANYU_SELLER_LEASE_TTL_MS) || 120_000)
const CLAIM_MUTEX_TIMEOUT_MS = 2_000
const LOCK_OWNER_HOST = hostname()
const developmentManifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../resources/seller-index/canonical-sellers.manifest.json')
const canonicalManifestPath = String(process.env.XIANYU_SELLER_CANONICAL_MANIFEST || '').trim() || developmentManifestPath

let loaded = false
let sources = []
let sourceIds = new Set()
let progress = new Map()
let canonicalSellerIds = new Set()
let canonicalManifestHash = null

const syncPause = (ms) => {
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

function fsyncDirectory(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function safeLeaseKey(sourceIdValue, cycleKey) {
  return createHash('sha256').update(`${String(cycleKey)}\0${String(sourceIdValue)}`).digest('hex')
}

function leasePath(sourceIdValue, cycleKey) {
  return join(leaseRoot, `${safeLeaseKey(sourceIdValue, cycleKey)}.lock`)
}

function readLeaseOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))
  } catch {
    return null
  }
}

function writeLeaseOwner(lockPath, owner) {
  const tmp = join(lockPath, `owner.json.tmp-${process.pid}-${randomUUID()}`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(owner, null, 2), 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, join(lockPath, 'owner.json'))
  fsyncDirectory(lockPath)
  fsyncDirectory(dirname(lockPath))
}

function quarantineExpiredLease(lockPath, reason = 'expired') {
  const quarantine = `${lockPath}.quarantine-${Date.now()}-${process.pid}-${randomUUID()}`
  renameSync(lockPath, quarantine)
  try { fsyncDirectory(dirname(lockPath)) } catch { /* best effort */ }
  appendEventRecord({ type: 'seller-lease-quarantined', reasonCode: reason, lock: basename(lockPath), quarantine: basename(quarantine), at: new Date().toISOString() })
  return quarantine
}

function acquireDirectoryMutex(lockPath, timeoutMs = CLAIM_MUTEX_TIMEOUT_MS) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const started = Date.now()
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      const owner = { token: randomUUID(), pid: process.pid, host: LOCK_OWNER_HOST, createdAt: new Date().toISOString() }
      writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      fsyncDirectory(lockPath)
      fsyncDirectory(dirname(lockPath))
      return owner
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const current = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))
        const age = Date.now() - (Date.parse(current?.createdAt || '') || Date.now())
        if (age > CLAIM_MUTEX_TIMEOUT_MS) {
          renameSync(lockPath, `${lockPath}.quarantine-${Date.now()}-${randomUUID()}`)
          continue
        }
      } catch (staleError) {
        if (staleError?.code === 'ENOENT') continue
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`seller claim mutex timeout: ${lockPath}`)
      syncPause(10)
    }
  }
}

function releaseDirectoryMutex(lockPath, owner) {
  try {
    const current = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))
    if (current?.token !== owner?.token) return false
    unlinkSync(join(lockPath, 'owner.json'))
    // Compare-delete: never remove a lock owned by another process.
    readdirSync(lockPath)
    rmdirSync(lockPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    try { rmdirSync(lockPath) } catch { /* leave evidence for the next owner */ }
  }
  try { fsyncDirectory(dirname(lockPath)) } catch { /* best effort */ }
  return true
}

function withClaimMutex(callback) {
  const owner = acquireDirectoryMutex(claimMutexPath)
  try { return callback() } finally { releaseDirectoryMutex(claimMutexPath, owner) }
}

function createSellerLease({ sourceId: sourceIdValue, accountId, runId, cycleKey, now = Date.now() } = {}) {
  const lockPath = leasePath(sourceIdValue, cycleKey)
  mkdirSync(leaseRoot, { recursive: true, mode: 0o700 })
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    host: LOCK_OWNER_HOST,
    sourceId: String(sourceIdValue),
    accountId: String(accountId),
    runId: String(runId),
    cycleKey: String(cycleKey),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SELLER_LEASE_TTL_MS).toISOString()
  }
  try {
    mkdirSync(lockPath, { mode: 0o700 })
    writeLeaseOwner(lockPath, owner)
    return { ...owner, lockPath }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const current = readLeaseOwner(lockPath)
    const expiresAt = Date.parse(current?.expiresAt || '')
    if (!Number.isFinite(expiresAt) || expiresAt > now) return null
    quarantineExpiredLease(lockPath, current ? 'expired' : 'malformed')
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      writeLeaseOwner(lockPath, owner)
      return { ...owner, recoveredFrom: current?.token || null, lockPath }
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') return null
      throw retryError
    }
  }
}

function compareLeaseIdentity(current, expected = {}) {
  return Boolean(
    current?.token && expected?.token && current.token === expected.token &&
    String(current.sourceId) === String(expected.sourceId) &&
    String(current.accountId) === String(expected.accountId) &&
    String(current.runId) === String(expected.runId) &&
    String(current.cycleKey) === String(expected.cycleKey)
  )
}

function releaseSellerLease(identity = {}) {
  const lockPath = identity.lockPath || leasePath(identity.sourceId, identity.cycleKey)
  const current = readLeaseOwner(lockPath)
  if (!compareLeaseIdentity(current, identity)) return { released: false, reason: 'owner_mismatch', lockPath }
  try {
    unlinkSync(join(lockPath, 'owner.json'))
    rmdirSync(lockPath)
    fsyncDirectory(dirname(lockPath))
    return { released: true, lockPath }
  } catch (error) {
    return { released: false, reason: error?.code || 'release_failed', lockPath }
  }
}

function renewSellerLease(identity = {}, now = Date.now()) {
  const lockPath = identity.lockPath || leasePath(identity.sourceId, identity.cycleKey)
  const current = readLeaseOwner(lockPath)
  if (!compareLeaseIdentity(current, identity)) return { renewed: false, reason: 'owner_mismatch', lockPath }
  const next = { ...current, expiresAt: new Date(now + SELLER_LEASE_TTL_MS).toISOString(), renewedAt: new Date(now).toISOString() }
  writeLeaseOwner(lockPath, next)
  return { renewed: true, ...next, lockPath }
}

function rebindSellerLease(current, { sourceId, accountId, runId, cycleKey, now = Date.now() } = {}) {
  if (!current?.token || !current?.lockPath) return null
  const next = {
    ...current,
    sourceId: String(sourceId),
    accountId: String(accountId),
    runId: String(runId),
    cycleKey: String(cycleKey),
    expiresAt: new Date(now + SELLER_LEASE_TTL_MS).toISOString(),
    reboundAt: new Date(now).toISOString()
  }
  writeLeaseOwner(current.lockPath, next)
  return { ...next, lockPath: current.lockPath }
}

function getSourceMode() {
  const mode = String(meta.get('sourceMode') || '').trim()
  return mode === 'canonical' ? 'canonical' : 'imported'
}

const STATUS_MIGRATION = Object.freeze({
  done: 'needs_review',
  error: 'failed',
  blocked: 'needs_review',
  paused: 'pending'
})
const LOCKED_STATUSES = new Set(['pending', 'running', 'completed', 'no_active', 'incomplete', 'needs_review', 'failed', 'login_expired', 'risk_cooldown'])
// The nine locked states remain the durable evidence vocabulary. The four
// groups below are only a queue/read-model projection; never write a group
// name into a progress row or use it in the state machine.
export const SELLER_STATUS_GROUPS = Object.freeze({
  all: Object.freeze([...LOCKED_STATUSES]),
  pending: Object.freeze(['pending', 'running', 'incomplete', 'needs_review', 'login_expired', 'risk_cooldown']),
  completed: Object.freeze(['completed', 'no_active']),
  failed: Object.freeze(['failed'])
})
export const SELLER_STATUS_GROUP_NAMES = Object.freeze(['all', 'pending', 'completed', 'failed'])
const CRAWLED_RESULTS = new Set(['completed', 'no_active', 'incomplete', 'needs_review', 'failed', 'login_expired', 'risk_cooldown'])
const TRANSIENT_FAILURE_CODES = new Set(['NAV_TIMEOUT', 'NAV_TRANSIENT', 'RENDER_CRASH'])
const RETRYABLE_INCOMPLETE_CODES = new Set(['SAFETY_LIMIT_REACHED', 'TRUSTED_COUNT_SHORT', 'INTERRUPTED_PARTIAL'])

function normalizeSellerStatusGroup(value) {
  const group = String(value || '').trim()
  return SELLER_STATUS_GROUP_NAMES.includes(group) ? group : ''
}

function rowsForSellerStatusGroup(rows, group) {
  const normalized = normalizeSellerStatusGroup(group)
  if (!normalized || normalized === 'all') return rows
  const statuses = new Set(SELLER_STATUS_GROUPS[normalized])
  return rows.filter((row) => statuses.has(String(row.status || '')))
}

function isTransientFailureRow(row = {}) {
  if (String(row.status || '') !== 'failed') return false
  if (Number(row.retryCount || 0) > 0) return false
  const evidenceCode = String(row.evidence?.failureReasonCode || '').trim()
  const reasonCode = String(row.reasonCode || '').trim()
  const reason = String(row.reason || '').trim()
  return TRANSIENT_FAILURE_CODES.has(evidenceCode) || TRANSIENT_FAILURE_CODES.has(reasonCode) || /导航超时|导航失败|页面无响应|渲染进程/i.test(reason)
}

function isRetryableIncompleteRow(row = {}) {
  return String(row.status || '') === 'incomplete' &&
    row.retryable !== true &&
    Number(row.retryCount || 0) === 0 &&
    RETRYABLE_INCOMPLETE_CODES.has(String(row.reasonCode || '').trim())
}

function normalizeItemIdList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((itemId) => String(itemId || '').trim())
    .filter(Boolean))]
}

export function migrateLegacySellerRecord(row = {}) {
  const { cookie: _cookie, cookies: _cookies, token: _token, ...safeRow } = row
  const oldStatus = String(row.status || 'pending')
  const migratedStatus = STATUS_MIGRATION[oldStatus] || oldStatus
  const status = LOCKED_STATUSES.has(migratedStatus) ? migratedStatus : 'needs_review'
  const attemptedAccountIds = [...new Set([
    ...(Array.isArray(row.attemptedAccountIds) ? row.attemptedAccountIds : []),
    row.lastAccountId
  ].map((value) => String(value || '').trim()).filter(Boolean))]
  const migratedLegacyTerminal = oldStatus === 'done' || oldStatus === 'blocked' || (Number(row.schemaVersion) < 3 && ['completed', 'no_active'].includes(oldStatus))
  const attempts = (Array.isArray(row.attempts) ? row.attempts : [])
    .filter((attempt) => attempt?.cycleKey && attempt?.accountId)
    .map((attempt) => ({
      attemptKey: attempt.attemptKey || `${attempt.cycleKey}:${row.id}:${attempt.accountId}`,
      runId: attempt.runId || null,
      cycleKey: String(attempt.cycleKey),
      sellerId: String(row.id || attempt.sellerId || ''),
      accountId: String(attempt.accountId),
      branch: attempt.branch === 'sold' ? 'sold' : 'active',
      startedAt: attempt.startedAt || null,
      endedAt: attempt.endedAt || null,
      outcome: attempt.outcome || null,
      reasonCode: attempt.reasonCode || null,
      immediateRetryUsed: Boolean(attempt.immediateRetryUsed),
      transientReason: attempt.transientReason || null,
      crawlStartedAt: attempt.crawlStartedAt || attempt.startedAt || null,
      crawlFinishedAt: attempt.crawlFinishedAt || attempt.endedAt || null,
      crawlResult: attempt.crawlResult || attempt.outcome || null,
      snapshotId: attempt.snapshotId || null,
      snapshotHash: attempt.snapshotHash || null,
      snapshotPath: attempt.snapshotPath || null,
      snapshotCapturedAt: attempt.snapshotCapturedAt || null,
      snapshotBytes: attempt.snapshotBytes || null,
      snapshotViewport: attempt.snapshotViewport || null
    }))
  const legacyUnclassifiedItemIds = normalizeItemIdList(
    Array.isArray(row.legacyUnclassifiedItemIds) ? row.legacyUnclassifiedItemIds : row.skipItemIds
  )
  return {
    ...safeRow,
    schemaVersion: 3,
    status: migratedLegacyTerminal ? 'needs_review' : status,
    attemptedAccountIds,
    attempts,
    itemIds: mergeSellerItemIds(row.itemIds || {}, {}),
    legacyUnclassifiedItemIds,
    reasonCode: migratedLegacyTerminal || status !== migratedStatus ? 'LEGACY_UNVERIFIED_STATUS' : (row.reasonCode || null)
  }
}

const normalizeProgressRow = migrateLegacySellerRecord

function writeAtomic(path, value, encoding) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFileSync(fd, value, encoding)
    fsyncSync(fd)
    closeSync(fd)
    renameSync(tmp, path)
    // Persist the directory entry as well as file contents. This prevents an
    // acknowledged checkpoint from disappearing after a sudden power loss.
    const dirFd = openSync(dirname(path), 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } catch (error) {
    try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw error
  }
}

function writeJsonAtomic(path, value) {
  writeAtomic(path, JSON.stringify(value, null, 2), 'utf8')
}

function writeBufferAtomic(path, value) {
  writeAtomic(path, value, undefined)
}

function redactEventValue(value, key = '') {
  if (/token|cookie|authorization|password|secret|session/i.test(key)) return '[REDACTED]'
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) return value.map((entry) => redactEventValue(entry))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactEventValue(childValue, childKey)]))
  }
  return value
}

function appendEventRecord(event) {
  const requestedAt = new Date(event?.at || Date.now())
  const at = Number.isFinite(requestedAt.getTime()) ? requestedAt.toISOString() : new Date().toISOString()
  const partition = at.slice(0, 10)
  mkdirSync(eventsDir, { recursive: true, mode: 0o700 })
  const safeEvent = redactEventValue({ ...event, at })
  const fd = openSync(join(eventsDir, `seller-events-${partition}.jsonl`), 'a', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(safeEvent) + '\n', 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return safeEvent
}

function persistCheckpoint(nextProgress = progress) {
  const records = [...nextProgress.values()].map(normalizeProgressRow)
  writeJsonAtomic(checkpointPath, { schemaVersion: 3, persistedAt: new Date().toISOString(), records })
}

function sourceId(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 24)
}

function canonicalUrl(sellerId) {
  return `https://www.goofish.com/personal?userId=${encodeURIComponent(sellerId)}`
}

function sellerIdFromSource(row) {
  const direct = String(row?.sellerId || '').trim()
  if (direct) return /^[A-Za-z0-9_-]{1,128}$/.test(direct) ? direct : null
  try {
    const url = new URL(String(row?.url || row?.sourceUrl || row?.canonicalUrl || ''))
    const sellerId = String(url.searchParams.get('userId') || url.searchParams.get('userid') || '').trim()
    return /^[A-Za-z0-9_-]{1,128}$/.test(sellerId) ? sellerId : null
  } catch {
    return null
  }
}

function canonicalSourceIdentity(row) {
  const direct = String(row?.sellerId || '').trim()
  const directSellerId = /^[A-Za-z0-9_-]{1,128}$/.test(direct) ? direct : null
  let normalizedUrl = null
  let urlSellerId = null
  try {
    normalizedUrl = normalizeSellerHomeUrl(String(row?.url || row?.sourceUrl || row?.canonicalUrl || ''))
    urlSellerId = new URL(normalizedUrl).searchParams.get('userId')
  } catch {
    // Invalid legacy URLs are retained in reconciliation evidence below.
  }
  const sellerId = directSellerId || urlSellerId
  const consistent = Boolean(
    sellerId &&
    urlSellerId &&
    (!directSellerId || directSellerId === urlSellerId) &&
    normalizedUrl === canonicalUrl(sellerId)
  )
  return { sellerId, directSellerId, urlSellerId, normalizedUrl, consistent }
}

function safeReconciliationRow(row, outcome, reasonCode, sellerId = null) {
  return {
    legacyId: String(row?.id || ''),
    sellerId,
    source: String(row?.source || 'legacy-seller-sources'),
    status: outcome === 'matched' ? 'pending' : 'needs_review',
    outcome,
    reasonCode,
    preservedSource: {
      id: String(row?.id || ''),
      url: String(row?.url || row?.sourceUrl || row?.canonicalUrl || ''),
      sellerId: sellerId || null,
      sellerName: String(row?.sellerName || ''),
      source: String(row?.source || ''),
      importedAt: row?.importedAt || null
    }
  }
}

function stripSourceCredentials(row = {}) {
  const {
    cookie: _cookie,
    cookies: _cookies,
    token: _token,
    authorization: _authorization,
    headers: _headers,
    ...safeRow
  } = row
  return safeRow
}

function readVerifiedCanonicalManifest(manifestPath, expectedCount) {
  if (!existsSync(manifestPath)) throw new Error(`canonical seller manifest is absent: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const verified = verifyCanonicalSellerManifest(manifest, { expectedCount })
  canonicalSellerIds = new Set(verified.sellerIds)
  canonicalManifestHash = verified.sha256
  return { manifest, verified }
}

function ensureLoaded() {
  if (loaded) return
  try {
    const raw = JSON.parse(readFileSync(sourcePath, 'utf8'))
    sources = Array.isArray(raw) ? raw.filter((r) => r && r.id && r.url) : []
  } catch {
    sources = []
  }
  sourceIds = new Set(sources.map((row) => row.id))

  progress = new Map()
  let checkpointPersistedMs = 0
  let checkpointLoaded = false
  if (existsSync(checkpointPath)) {
    try {
      const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'))
      for (const row of Array.isArray(checkpoint?.records) ? checkpoint.records : []) {
        if (row?.id) progress.set(row.id, normalizeProgressRow(row))
      }
      checkpointPersistedMs = Date.parse(checkpoint?.persistedAt || '') || 0
      checkpointLoaded = true
    } catch {
      // 保留 JSONL 兼容恢复路径；损坏 checkpoint 不会把队列伪装成完成。
    }
  }
  if (existsSync(progressPath)) {
    const lines = readFileSync(progressPath, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        const rowTime = Date.parse(row.updatedAt || row.at || row.startedAt || '') || 0
        if (checkpointLoaded && (!rowTime || rowTime <= checkpointPersistedMs)) continue
        if (row.kind === 'reset') {
          progress = new Map()
        } else if (row.id) {
          progress.set(row.id, normalizeProgressRow(row))
        }
      } catch {
        // Diagnostics must remain read-only.  Preserve the malformed line for
        // the explicit recovery/run-start path instead of appending an event
        // merely because a status request inspected it.
      }
    }
  }

  loaded = true
  // A fresh process reconciles orphaned running rows and bounded transient
  // failures before exposing queue rows. Calls after this module has loaded
  // remain read-only; the recursive guard sees loaded=true.
  recoverInterruptedState({ recoverRunning: false })
}

// Recovery is only entered for a fresh process with a durable running flag or
// by the explicit run-start path.  It never runs repeatedly in one process.
function recoverInterruptedState({ recoverRunning = true } = {}) {
  ensureLoaded()
  let recoveredCount = 0
  let migratedRetryableRows = 0
  for (const [id, row] of progress) {
    if (!isTransientFailureRow(row) && !isRetryableIncompleteRow(row)) continue
    progress.set(id, {
      ...row,
      status: 'incomplete',
      reasonCode: isTransientFailureRow(row) ? 'TRANSIENT_RETRY_PENDING' : 'INCOMPLETE_RETRY_PENDING',
      retryable: true,
      retryCount: 0,
      retryableAccountId: String(row.lastAccountId || row.currentAttempt?.accountId || '') || null,
      currentAttempt: null,
      recoveryPending: false,
      migratedTransientFailureAt: new Date().toISOString()
    })
    migratedRetryableRows++
  }
  for (const [id, row] of progress) {
    if (!recoverRunning || row.status !== 'running') continue
    const recoveredAt = new Date().toISOString()
    progress.set(id, {
      ...row,
      status: 'pending',
      reasonCode: 'RECOVERED_INTERRUPTED',
      recoveredAt,
      recoveryPending: true,
      currentAttempt: row.currentAttempt ? { ...row.currentAttempt, recoveredAt } : null
    })
    recoveredCount++
  }
  const previousJob = meta.get('job') || {}
  const hasResumableWork = sources.some((source) => {
    const row = progress.get(source.id)
    return !row || ['pending', 'incomplete', 'running'].includes(row.status)
  })
  const resumePreviousRun = previousJob.running === true && hasResumableWork
  if (progress.size && (recoveredCount > 0 || migratedRetryableRows > 0)) persistCheckpoint(progress)
  // `ensureLoaded({ recoverRunning: false })` is also used by the live claim
  // mutex to refresh another worker's durable rows. That read/refresh path
  // must stay read-only: writing `running:false` there made the watchdog and
  // renderer think an active multi-account run had stopped after every claim.
  // Only the explicit startup/run-boundary recovery path may transition the
  // durable job into recovery state.
  if (recoverRunning && (previousJob.running || recoveredCount || resumePreviousRun)) {
    meta.set('job', {
      ...previousJob,
      running: false,
      recoveryPending: recoveredCount > 0 || resumePreviousRun,
      recoveredAt: new Date().toISOString(),
      recoveredSellers: recoveredCount,
      resumePendingWork: resumePreviousRun
    })
  }
  return { recoveredCount, resumePreviousRun }
}

function persistSources() {
  writeJsonAtomic(sourcePath, sources)
}

/**
 * Replace the mutable local source list with the verified canonical universe.
 * Every legacy row receives one reconciliation outcome before the canonical set
 * is committed, so malformed and conflicting inputs cannot disappear silently.
 */
export function importCanonicalSellerManifest(manifestPath = canonicalManifestPath, { expectedCount = 9977 } = {}) {
  ensureLoaded()
  const { manifest, verified } = readVerifiedCanonicalManifest(resolve(manifestPath), expectedCount)
  const legacyRows = [...sources]
  const bySellerId = new Map()
  const reviewRows = []

  for (const row of legacyRows) {
    const identity = canonicalSourceIdentity(row)
    const sellerId = identity.sellerId
    if (!sellerId || !identity.consistent) {
      const reasonCode = identity.directSellerId && identity.urlSellerId && identity.directSellerId !== identity.urlSellerId
        ? 'LEGACY_SELLER_ID_URL_MISMATCH'
        : 'LEGACY_SELLER_ID_INVALID'
      reviewRows.push(safeReconciliationRow(row, 'needs_review', reasonCode, sellerId))
      continue
    }
    if (!canonicalSellerIds.has(sellerId)) {
      reviewRows.push(safeReconciliationRow(row, 'needs_review', 'LEGACY_NOT_IN_CANONICAL_SET', sellerId))
      continue
    }
    const group = bySellerId.get(sellerId) || []
    group.push(row)
    bySellerId.set(sellerId, group)
  }

  const nextSources = []
  const nextProgress = new Map()
  let matched = 0
  let added = 0
  const now = new Date().toISOString()

  for (const sellerId of verified.sellerIds) {
    const legacyMatches = (bySellerId.get(sellerId) || []).sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''), 'en'))
    const url = canonicalUrl(sellerId)
    let source
    if (!legacyMatches.length) {
      source = {
        id: sourceId(url),
        sellerId,
        url,
        source: 'canonical-manifest',
        importedAt: now,
        canonicalManifestHash: verified.sha256
      }
      added += 1
      nextProgress.set(source.id, normalizeProgressRow({
        id: source.id,
        status: 'pending',
        reasonCode: 'CANONICAL_SOURCE_ONLY',
        schemaVersion: 3
      }))
    } else {
      const selected = stripSourceCredentials(legacyMatches[0])
      source = {
        ...selected,
        sellerId,
        url,
        // Preserve pre-canonical keys as aliases so legacy evidence can be
        // resolved without broad sellerId matching when sources collide.
        legacySourceIds: [...new Set(legacyMatches.map((legacy) => String(legacy.id || '').trim()).filter(Boolean))],
        canonicalManifestHash: verified.sha256
      }
      const prior = normalizeProgressRow(progress.get(selected.id) || { id: selected.id, status: 'pending' })
      if (legacyMatches.length === 1) {
        matched += 1
        nextProgress.set(source.id, prior)
      } else {
        for (const conflict of legacyMatches) {
          reviewRows.push(safeReconciliationRow(conflict, 'needs_review', 'LEGACY_CONFLICTING_MAPPING', sellerId))
        }
        nextProgress.set(source.id, normalizeProgressRow({
          ...prior,
          id: source.id,
          status: 'needs_review',
          reasonCode: 'LEGACY_CONFLICTING_MAPPING'
        }))
      }
    }
    nextSources.push(source)
  }

  const report = {
    schemaVersion: 1,
    generatedAt: now,
    manifest: {
      path: resolve(manifestPath),
      count: verified.count,
      sha256: verified.sha256,
      provenance: manifest.provenance
    },
    legacy: {
      total: legacyRows.length,
      matched,
      needsReview: reviewRows.length,
      accounted: matched + reviewRows.length
    },
    canonical: {
      total: verified.count,
      indexed: nextSources.length,
      added
    },
    reviewRows
  }
  if (report.legacy.accounted !== report.legacy.total) throw new Error('legacy seller reconciliation accounting mismatch')
  if (nextSources.length !== verified.count || new Set(nextSources.map((row) => row.sellerId)).size !== verified.count) {
    throw new Error('canonical seller import membership mismatch')
  }

  sources = nextSources
  sourceIds = new Set(nextSources.map((row) => row.id))
  progress = nextProgress
  persistSources()
  persistCheckpoint(progress)
  writeJsonAtomic(reconciliationPath, report)
  meta.set('lastCanonicalImport', {
    at: now,
    count: verified.count,
    sha256: verified.sha256,
    legacy: report.legacy,
    added
  })
  meta.set('sourceMode', 'canonical')
  return report
}

/**
 * Reconcile the packaged canonical universe exactly once per verified manifest
 * hash. A matching hash is accepted only when the on-disk membership is still
 * exact; partial or externally edited state is repaired on the next startup.
 */
export function reconcileCanonicalSellerManifest(manifestPath = canonicalManifestPath, { expectedCount = 9977 } = {}) {
  ensureLoaded()
  const absolutePath = resolve(manifestPath)
  const { verified } = readVerifiedCanonicalManifest(absolutePath, expectedCount)
  const mode = String(meta.get('sourceMode') || '').trim()
  const explicitManifestRows = sources.length > 0 && sources.every((row) => String(row.canonicalManifestHash || '').trim() === verified.sha256)
  // A historical lastCanonicalImport hash is not, by itself, permission to
  // hide ordinary imported sellers. Only an explicit source mode or rows
  // carrying the verified manifest marker may enter the canonical universe.
  if (mode !== 'canonical' && !explicitManifestRows && sources.length > 0) {
    if (mode !== 'imported') meta.set('sourceMode', 'imported')
    return {
      changed: false,
      skipped: true,
      sourceMode: 'imported',
      manifest: { path: absolutePath, count: verified.count, sha256: verified.sha256 },
      canonical: { total: verified.count, indexed: sources.length, added: 0 }
    }
  }
  const previous = meta.get('lastCanonicalImport') || {}
  const currentIdentities = sources.map(canonicalSourceIdentity)
  const currentSellerIds = currentIdentities.map((identity) => identity.sellerId)
  const membershipExact = sources.length === verified.count &&
    currentIdentities.every((identity) => identity.consistent) &&
    currentSellerIds.every(Boolean) &&
    new Set(currentSellerIds).size === verified.count &&
    currentSellerIds.every((sellerId) => canonicalSellerIds.has(sellerId))
  if (previous.sha256 === verified.sha256 && Number(previous.count) === verified.count && membershipExact) {
    return {
      changed: false,
      manifest: { path: absolutePath, count: verified.count, sha256: verified.sha256 },
      canonical: { total: verified.count, indexed: sources.length, added: 0 }
    }
  }
  const report = importCanonicalSellerManifest(absolutePath, { expectedCount })
  return { ...report, changed: true }
}

function appendProgress(row) {
  mkdirSync(dirname(progressPath), { recursive: true, mode: 0o700 })
  const fd = openSync(progressPath, 'a', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(row) + '\n', 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function classifyImportedUrl(value) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '')
  if (/^[A-Za-z0-9_-]{1,128}$/.test(raw)) {
    return { url: canonicalUrl(raw), sellerId: raw, needsReview: false, reasonCode: null }
  }
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    const url = new URL(raw)
    const canonicalUrl = normalizeSellerHomeUrl(url.href)
    return {
      url: canonicalUrl,
      sellerId: new URL(canonicalUrl).searchParams.get('userId'),
      needsReview: false,
      reasonCode: null
    }
  } catch {
    try {
      const url = new URL(raw)
      if (!/(^|\.)goofish\.com$|(^|\.)taobao\.com$/i.test(url.hostname)) return null
      // Preserve a non-secret, non-navigable reference so an invalid homepage
      // remains visible in the review queue without persisting query tokens.
      const reference = `invalid-seller-input://${url.hostname.toLowerCase()}${url.pathname}/${sourceId(raw)}`.slice(0, 500)
      return { url: reference, sellerId: null, needsReview: true, reasonCode: 'INVALID_SELLER_URL' }
    } catch {
      return null
    }
  }
}

const SELLER_DISPLAY_FIELDS = Object.freeze([
  'sellerName', 'mainContent', 'mainType', 'category', 'board', 'boardName',
  'sourceBoardRanks', 'rank', 'sourceRank', 'sourceOrdinal', 'sourceSlotCount', 'cities', 'excelRow',
  'sourceSheet', 'sourceWorkbook'
])

function cleanSellerDisplayMetadata(value = {}) {
  const metadata = {}
  for (const field of SELLER_DISPLAY_FIELDS) {
    const raw = value?.[field]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    if (/token|cookie|authorization|password|secret|session/i.test(field)) continue
    const cleaned = typeof raw === 'string' ? raw.trim() : raw
    metadata[field] = ['rank', 'sourceRank', 'sourceOrdinal', 'sourceSlotCount', 'excelRow'].includes(field) && /^\d+(?:\.\d+)?$/.test(String(cleaned))
      ? Number(cleaned)
      : cleaned
  }
  return metadata
}

function mergeSellerDisplayMetadata(base = {}, incoming = {}) {
  const next = { ...base }
  let changed = false
  for (const [field, value] of Object.entries(cleanSellerDisplayMetadata(incoming))) {
    if (String(next[field] ?? '').trim() === '' && String(value).trim() !== '') {
      next[field] = value
      changed = true
    }
  }
  return { row: next, changed }
}

function normalizeSheetHeader(value) {
  return String(value || '').trim().replace(/[\s_\-（）()【】\[\]]/g, '').toLowerCase()
}

function spreadsheetField(headers, aliases) {
  const wanted = new Set(aliases.map(normalizeSheetHeader))
  const index = headers.findIndex((header) => wanted.has(normalizeSheetHeader(header)))
  return index >= 0 ? index : -1
}

function spreadsheetEntry(row, headers, rowNumber, sheetName) {
  const homepageIndex = spreadsheetField(headers, [
    '卖家主页', '主页链接', '主页', '卖家链接', '店铺链接', 'sourceUrl', 'canonicalUrl', 'url', 'link', 'homepage'
  ])
  const sellerIdIndex = spreadsheetField(headers, ['sellerId', '卖家ID', '用户ID', 'userid', 'userId'])
  const value = homepageIndex >= 0 ? row[homepageIndex] : (sellerIdIndex >= 0 ? row[sellerIdIndex] : '')
  if (!String(value || '').trim()) return null

  const valueAt = (aliases) => {
    const index = spreadsheetField(headers, aliases)
    return index >= 0 ? row[index] : ''
  }
  const metadata = cleanSellerDisplayMetadata({
    sellerName: valueAt(['卖家名称', '卖家昵称', '昵称', 'sellerName', 'seller_name', 'name']),
    mainContent: valueAt(['主营', '主营内容', '卖家简介', 'mainContent', 'description']),
    mainType: valueAt(['主营类型', '类型', '品类', '类目', '分类', 'mainType', 'category']),
    category: valueAt(['分类', '品类', '类目', 'category']),
    board: valueAt(['榜单', '榜单名称', '榜单类型', 'board', 'boardName']),
    boardName: valueAt(['榜单名称', '榜单类型', 'boardName', 'board']),
    sourceBoardRanks: valueAt(['来源榜单', '来源榜单（最多10条）', '来源榜单（最多8条）', 'sourceBoardRanks', 'source_board_ranks']),
    rank: valueAt(['排名', '榜单排名', '名次', 'rank', 'sourceRank']),
    sourceRank: valueAt(['榜单排名', '排名', '名次', 'sourceRank', 'rank']),
    sourceOrdinal: valueAt(['来源序号', 'sourceOrdinal']),
    sourceSlotCount: valueAt(['榜单槽位数', '来源槽位数', '槽位数', 'sourceSlotCount']),
    cities: valueAt(['城市', '城市榜', '覆盖城市', 'cities']),
    excelRow: rowNumber,
    sourceSheet: sheetName
  })
  return { value: String(value).trim(), metadata }
}

function parseLinks(raw, fileName = '') {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  const found = []
  const add = (v, metadata = {}) => {
    const value = typeof v === 'string'
      ? v
      : v?.url || v?.link || v?.homepage || v?.homepageUrl || v?.sourceUrl || v?.canonicalUrl || v?.主页链接 || v?.sellerId || v?.userId
    if (String(value || '').trim()) found.push({ value: String(value).trim(), metadata: cleanSellerDisplayMetadata({ ...(typeof v === 'object' ? v : {}), ...metadata }) })
  }

  if (/\.(?:jsonl?|ndjson)$/i.test(fileName) || /^[\s]*[\[{]/.test(text)) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) parsed.forEach(add)
      else add(parsed)
    } catch {
      // JSONL：逐行解析，不能把整份多对象文本当成一个 JSON 文档。
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try { add(JSON.parse(line)) } catch { /* fall through to URL scan */ }
      }
    }
  }
  if (!found.length && /\.csv$/i.test(fileName)) {
    const rows = text.split(/\r?\n/).filter((line) => line.trim())
    const parseCsvLine = (line) => {
      const cells = []
      let cell = '', quoted = false
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index]
        if (char === '"' && line[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue }
        if (char === '"') { quoted = !quoted; continue }
        if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; continue }
        cell += char
      }
      cells.push(cell.trim())
      return cells
    }
    const headers = parseCsvLine(rows.shift() || '')
    for (const line of rows) {
      const cells = parseCsvLine(line)
      const entry = Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']))
      add(entry)
    }
  }
  if (!found.length) {
    const matches = text.match(/https?:\/\/[^\s,，;；"'<>]+/gi) || []
    matches.forEach(add)
  }
  const unique = new Map()
  for (const entry of found) {
    const key = String(entry.value || '').trim()
    if (!unique.has(key)) unique.set(key, entry)
    else unique.set(key, { ...unique.get(key), metadata: { ...unique.get(key).metadata, ...entry.metadata } })
  }
  return [...unique.values()]
}

export function importLinks(raw, fileName = '') {
  ensureLoaded()
  const links = parseLinks(raw, fileName)
  return importUrlList(links, fileName, 'file')
}

function importUrlList(links, fileName, source) {
  ensureLoaded()
  const existing = new Map(sources.map((s) => [s.url, s]))
  let added = 0
  let needsReview = 0
  let rejected = 0
  let enriched = 0
  for (const input of links) {
    const value = typeof input === 'string' ? input : input?.value || input?.url || input?.link || ''
    const classified = classifyImportedUrl(value)
    if (!classified) {
      rejected += 1
      continue
    }
    const { url, sellerId, needsReview: review, reasonCode } = classified
    const metadata = cleanSellerDisplayMetadata(typeof input === 'object' ? input.metadata : {})
    if (existing.has(url)) {
      const current = existing.get(url)
      const merged = mergeSellerDisplayMetadata(current, metadata)
      if (merged.changed) {
        const index = sources.findIndex((row) => row.url === url)
        if (index >= 0) sources[index] = merged.row
        existing.set(url, merged.row)
        enriched += 1
      }
      continue
    }
    const row = { id: sourceId(url), sellerId, url, source, importedAt: new Date().toISOString(), ...metadata }
    sources.push(row)
    sourceIds.add(row.id)
    existing.set(url, row)
    if (review) {
      progress.set(row.id, normalizeProgressRow({ id: row.id, status: 'needs_review', reasonCode }))
      needsReview += 1
    }
    added++
  }
  persistSources()
  if (needsReview) persistCheckpoint(progress)
  const duplicates = links.length - added - rejected
  meta.set('sourceMode', 'imported')
  meta.set('lastImport', { fileName, at: new Date().toISOString(), total: links.length, added, enriched, duplicates, needsReview, rejected })
  return { total: links.length, added, enriched, duplicates, needsReview, rejected, sources: sources.length }
}

/**
 * 读取 XLSX 中的卖家主页链接。
 *
 * 交付表若有“唯一卖家主页”工作表，只读取该表，避免把榜单槽位、缺失槽位
 * 或源榜单链接误当成新的卖家主页；旧格式没有该工作表时才回退到全表扫描。
 */
export function importSpreadsheet(buffer, fileName = '') {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const preferred = ['唯一卖家主页', '卖家主页', '主页链接']
  const selected = preferred.find((name) => workbook.SheetNames.includes(name))
  const sheetNames = selected ? [selected] : workbook.SheetNames
  const entries = []
  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
    const headerIndex = rows.findIndex((row) => Array.isArray(row) && row.some((cell) => /卖家主页|主页链接|sellerid|userid|sourceurl|canonicalurl/i.test(String(cell || ''))))
    const headers = headerIndex >= 0 ? rows[headerIndex] : []
    if (headerIndex >= 0) {
      for (let index = headerIndex + 1; index < rows.length; index += 1) {
        const entry = spreadsheetEntry(rows[index], headers, index + 1, sheetName)
        if (entry) entries.push(entry)
      }
    } else {
      for (let index = 0; index < rows.length; index += 1) {
        const row = Array.isArray(rows[index]) ? rows[index].join('\t') : String(rows[index] || '')
        const matches = row.match(/https?:\/\/[^\s,，;；"'<>]+/gi) || []
        for (const value of matches) entries.push({ value, metadata: { excelRow: index + 1, sourceSheet: sheetName } })
      }
    }
  }
  const source = selected ? `spreadsheet:${selected}` : 'spreadsheet:all-sheets-fallback'
  return importUrlList(entries, selected ? `${fileName}#sheet=${selected}` : fileName, source)
}

/** 供独立后台入口使用：按文件扩展名导入，不打开文件选择器。 */
export function importFilePath(filePath) {
  const name = basename(filePath)
  const raw = readFileSync(filePath)
  return /\.xlsx?$/i.test(name)
    ? importSpreadsheet(raw, name)
    : importLinks(raw.toString('utf8'), name)
}

function readLegacyQueue() {
  try {
    const raw = JSON.parse(readFileSync(legacyStorePath, 'utf8'))
    return Array.isArray(raw?.merchantQueue) ? raw.merchantQueue : []
  } catch {
    return []
  }
}

/** 旧版“固定商家/商家主页”队列的只读兼容导入，不修改旧版数据。 */
export function getLegacyQueueSummary() {
  const queue = readLegacyQueue()
  const counts = { total: queue.length, pending: 0, paused: 0, running: 0, failed: 0, needsReview: 0, completed: 0 }
  for (const row of queue) {
    const key = row.status === 'needs_review' ? 'needsReview' : row.status
    if (key in counts) counts[key]++
  }
  return { ...counts, available: queue.filter((row) => row?.sourceUrl && row.status !== 'completed').length }
}

export function importLegacyQueue() {
  const queue = readLegacyQueue()
  const links = queue
    .filter((row) => row?.sourceUrl && row.status !== 'completed')
    .map((row) => row.sourceUrl)
  return { ...importUrlList(links, 'xianyu-electron.json / merchantQueue', 'legacy-merchant-queue'), legacy: true }
}

export function getSettings() {
  const settings = { ...meta.get('settings') }
  if (Number(settings.rateSafetyVersion) < SELLER_SETTINGS_VERSION || Number(settings.throttleMinMs) < 15000 || Number(settings.throttleMaxMs) < 15000 || Number(settings.pageWaitMs) < 1200 || !Number.isFinite(Number(settings.maxItemsPerSeller)) || Number(settings.maxItemsPerSeller) < 0) {
    settings.maxItemsPerSeller = Number(settings.rateSafetyVersion) < SELLER_SETTINGS_VERSION
      ? ADAPTIVE_MAX_ITEMS
      : Math.max(0, Math.floor(Number(settings.maxItemsPerSeller) || ADAPTIVE_MAX_ITEMS))
    if (Number(settings.maxScrollSteps) === 80 || !Number(settings.maxScrollSteps)) settings.maxScrollSteps = 500
    settings.pageWaitMs = 1800
    settings.throttleMinMs = 15000
    settings.throttleMaxMs = 30000
    settings.rateSafetyVersion = SELLER_SETTINGS_VERSION
    meta.set('settings', settings)
  }
  if (!settings.weeklyTime || settings.weeklyTime === '03:00') settings.weeklyTime = '02:00'
  settings.timezone = 'Asia/Shanghai'
  meta.set('settings', settings)
  return settings
}

export function setSettings(patch) {
  if (patch && Object.hasOwn(patch, 'weeklyDay') && (!Number.isInteger(Number(patch.weeklyDay)) || Number(patch.weeklyDay) < 0 || Number(patch.weeklyDay) > 6)) {
    throw new TypeError('weeklyDay must be an integer from 0 to 6')
  }
  if (patch && Object.hasOwn(patch, 'weeklyTime') && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(patch.weeklyTime || ''))) {
    throw new TypeError('weeklyTime must use HH:mm')
  }
  if (patch && Object.hasOwn(patch, 'timezone') && patch.timezone !== 'Asia/Shanghai') {
    throw new TypeError('timezone must be Asia/Shanghai')
  }
  const next = { ...meta.get('settings'), ...(patch || {}) }
  next.maxItemsPerSeller = Math.max(0, Math.floor(Number(next.maxItemsPerSeller) || ADAPTIVE_MAX_ITEMS))
  next.maxScrollSteps = Math.min(500, Math.max(5, Number(next.maxScrollSteps) || 500))
  next.pageWaitMs = Math.max(1200, Number(next.pageWaitMs) || 1800)
  next.throttleMinMs = Math.max(15000, Number(next.throttleMinMs) || 15000)
  next.throttleMaxMs = Math.max(next.throttleMinMs, Number(next.throttleMaxMs) || 30000)
  next.rateSafetyVersion = SELLER_SETTINGS_VERSION
  next.recycleEvery = Math.max(0, Number(next.recycleEvery) || 0)
  next.weeklyDay = Math.min(6, Math.max(0, Number(next.weeklyDay) || 0))
  next.weeklyTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(next.weeklyTime || '')) ? next.weeklyTime : '02:00'
  next.timezone = 'Asia/Shanghai'
  meta.set('settings', next)
  return next
}

function accountSafetyDto(accountId, state) {
  if (!state) return null
  return {
    accountId: String(accountId),
    status: state.status === 'login_required' ? 'login_required' : 'cooling',
    reasonCode: String(state.reasonCode || 'ACCOUNT_SAFETY_STOP'),
    lastEvidenceAt: String(state.lastEvidenceAt || ''),
    coolingUntil: state.status === 'cooling' ? String(state.coolingUntil || '') : null
  }
}

function validAccountId(accountId) {
  const id = String(accountId || '').trim()
  if (!id || id.length > 128) throw new TypeError('account id must be non-empty')
  return id
}

export function getAccountSafetyState(accountId) {
  const id = validAccountId(accountId)
  const states = meta.get('accountSafetyStates') || {}
  return accountSafetyDto(id, states[id])
}

export function listAccountSafetyStates() {
  const states = meta.get('accountSafetyStates') || {}
  return Object.keys(states).sort().map((accountId) => accountSafetyDto(accountId, states[accountId]))
}

export function setAccountLoginRequired(accountId, { reasonCode = 'LOGIN_EXPIRED', lastEvidenceAt = new Date().toISOString() } = {}) {
  const id = validAccountId(accountId)
  const evidenceAt = new Date(lastEvidenceAt)
  if (!Number.isFinite(evidenceAt.getTime())) throw new TypeError('lastEvidenceAt must be a valid time')
  const states = meta.get('accountSafetyStates') || {}
  states[id] = {
    status: 'login_required',
    reasonCode: String(reasonCode || 'LOGIN_EXPIRED').slice(0, 80),
    lastEvidenceAt: evidenceAt.toISOString(),
    coolingUntil: null
  }
  meta.set('accountSafetyStates', states)
  return accountSafetyDto(id, states[id])
}

export function setAccountCooling(accountId, { coolingUntil = null, reasonCode = 'RISK_CONTROL', lastEvidenceAt = new Date().toISOString() } = {}) {
  const id = validAccountId(accountId)
  const evidenceAt = new Date(lastEvidenceAt)
  if (!Number.isFinite(evidenceAt.getTime())) throw new TypeError('lastEvidenceAt must be a valid time')
  const minimumUntil = Date.now() + 6 * 60 * 60 * 1000
  const requestedUntil = Date.parse(coolingUntil || '')
  const states = meta.get('accountSafetyStates') || {}
  const existingUntil = states[id]?.status === 'cooling' ? Date.parse(states[id].coolingUntil || '') : 0
  const effectiveUntil = new Date(Math.max(
    minimumUntil,
    Number.isFinite(requestedUntil) ? requestedUntil : 0,
    Number.isFinite(existingUntil) ? existingUntil : 0
  )).toISOString()
  states[id] = {
    status: 'cooling',
    reasonCode: String(reasonCode || 'RISK_CONTROL').slice(0, 80),
    lastEvidenceAt: evidenceAt.toISOString(),
    coolingUntil: effectiveUntil
  }
  meta.set('accountSafetyStates', states)
  return accountSafetyDto(id, states[id])
}

export function clearAccountSafetyState(accountId) {
  const id = validAccountId(accountId)
  const states = { ...(meta.get('accountSafetyStates') || {}) }
  delete states[id]
  meta.set('accountSafetyStates', states)
  return { ok: true, accountId: id }
}

// 风控不是把队列永久停死的理由：保留一个可审计的恢复标记，等冷却窗口
// 到期后由调度器重新开一个 cycle。这个标记不绕过登录检查，也不会缩短
// setAccountCooling() 的最小冷却时间。
export function scheduleRiskRecovery({ accountId, coolingUntil, reasonCode = 'RISK_CONTROL', sellerId = '', runId = '', cycleKey = '' } = {}) {
  ensureLoaded()
  const id = validAccountId(accountId)
  const retryAt = new Date(coolingUntil || '').toISOString()
  const job = meta.get('job') || {}
  const recovery = {
    accountId: id,
    sellerId: String(sellerId || '').slice(0, 128),
    runId: String(runId || '').slice(0, 128),
    cycleKey: String(cycleKey || '').slice(0, 256),
    reasonCode: String(reasonCode || 'RISK_CONTROL').slice(0, 80),
    retryAt,
    scheduledAt: new Date().toISOString()
  }
  meta.set('job', { ...job, riskRecoveryPending: true, riskRecovery: recovery })
  return recovery
}

export function getRiskRecovery() {
  ensureLoaded()
  const recovery = meta.get('job')?.riskRecovery
  return recovery?.accountId && recovery?.retryAt ? { ...recovery } : null
}

export function claimRiskRecovery() {
  ensureLoaded()
  const job = meta.get('job') || {}
  const recovery = job.riskRecovery
  if (!recovery?.accountId || !recovery?.retryAt || recovery.claimedAt) return null
  const claimed = { ...recovery, claimedAt: new Date().toISOString() }
  const nextJob = { ...job, riskRecoveryPending: false, riskRecoveryClaimedAt: claimed.claimedAt }
  delete nextJob.riskRecovery
  meta.set('job', nextJob)
  return claimed
}

export function restoreRiskRecovery(recovery, { retryAt = null, reason = '' } = {}) {
  if (!recovery?.accountId) return null
  const nextRetryAt = retryAt || recovery.retryAt
  const restored = scheduleRiskRecovery({ ...recovery, coolingUntil: nextRetryAt })
  const job = meta.get('job') || {}
  meta.set('job', { ...job, riskRecoveryLastFailure: String(reason || '').slice(0, 240) || null })
  return restored
}

// 风控前已经落盘的行保留历史尝试与证据，只把可重试状态放回队列。
// 新一轮由调度器使用新的 cycleKey，避免同一账号在旧 cycle 内被去重掉。
export function releaseRiskCooldown(accountId) {
  ensureLoaded()
  const id = validAccountId(accountId)
  let released = 0
  for (const row of sources) {
    const current = progress.get(row.id)
    if (current?.status !== 'risk_cooldown') continue
    const lastAttempt = [...(current.attempts || [])].reverse().find((attempt) => attempt.accountId === id)
    if (current.lastAccountId !== id && !lastAttempt) continue
    markSource(row.id, {
      status: 'pending',
      reasonCode: 'RISK_COOLDOWN_EXPIRED',
      retryable: true,
      recoveryPending: false,
      currentAttempt: null,
      lastRiskRecoveryAt: new Date().toISOString()
    })
    released += 1
  }
  return { accountId: id, released }
}

export function getSources({ page = 1, pageSize = 100, status = null, statusGroup = null, group = null, q = '' } = {}) {
  ensureLoaded()
  const query = String(q || '').trim().toLowerCase()
  // 续采用的商品 ID 只供主进程内部去重，不能把数千个 ID 发送给渲染层。
  let rows = sources.map((s) => {
    const { skipItemIds: _skipItemIds, itemIds: _itemIds, evidence: _evidence, legacyUnclassifiedItemIds: _legacyIds, ...publicProgress } = progress.get(s.id) || { status: 'pending' }
    return { ...s, ...publicProgress }
  })
  if (status) rows = rows.filter((r) => r.status === status)
  const normalizedGroup = normalizeSellerStatusGroup(statusGroup || group)
  if (status && normalizedGroup) throw new TypeError('status and statusGroup cannot be combined')
  if (normalizedGroup) rows = rowsForSellerStatusGroup(rows, normalizedGroup)
  if (query) rows = rows.filter((r) => [r.url, r.sellerId, r.sellerName, r.mainContent, r.mainType, r.category, r.board, r.boardName, r.sourceBoardRanks, r.rank, r.sourceRank, r.sourceOrdinal, r.cities].some((value) => String(value || '').toLowerCase().includes(query)))
  const total = rows.length
  const start = Math.max(0, (Number(page) - 1) * Number(pageSize))
  return { items: rows.slice(start, start + Number(pageSize)), total }
}

export function isIndexed(row) {
  if (getSourceMode() === 'imported') return Boolean(sellerIdFromSource(row))
  if (!canonicalSellerIds.size && existsSync(canonicalManifestPath)) {
    readVerifiedCanonicalManifest(canonicalManifestPath, null)
  }
  const sellerId = sellerIdFromSource(row)
  return Boolean(sellerId && canonicalSellerIds.has(sellerId))
}

function hasNonEmptyCommittedItems(row) {
  const itemIds = row?.itemIds || row?.checkpoint?.itemIds || {}
  return ['active', 'sold'].some((branch) => Array.isArray(itemIds?.[branch]) && itemIds[branch].some((itemId) => String(itemId || '').trim()))
}

export function isLoaded(row) {
  const snapshotHash = row?.snapshotHash || row?.snapshot?.snapshotHash
  const committedAt = row?.committedAt || row?.snapshot?.committedAt
  if (String(snapshotHash || '').trim() && Number.isFinite(Date.parse(committedAt || ''))) return true
  const checkpointHash = row?.checkpointHash || row?.checkpoint?.checkpointHash
  const persistedAt = row?.persistedAt || row?.checkpoint?.persistedAt
  return Boolean(String(checkpointHash || '').trim() && Number.isFinite(Date.parse(persistedAt || '')) && hasNonEmptyCommittedItems(row))
}

export function isCrawled(row) {
  return (Array.isArray(row?.attempts) ? row.attempts : []).some((attempt) => (
    Number.isFinite(Date.parse(attempt?.crawlStartedAt || '')) &&
    Number.isFinite(Date.parse(attempt?.crawlFinishedAt || '')) &&
    CRAWLED_RESULTS.has(String(attempt?.crawlResult || ''))
  ))
}

function publicSellerRow(row) {
  const {
    skipItemIds: _skipItemIds,
    itemIds: _itemIds,
    evidence: _evidence,
    legacyUnclassifiedItemIds: _legacyIds,
    currentAttempt: _currentAttempt,
    ...publicRow
  } = row
  return publicRow
}

export function querySellerMembership({ dimension = 'indexed', status = null, statusGroup = null, group = null, page = 1, pageSize = 100, q = '' } = {}) {
  ensureLoaded()
  if (!['indexed', 'loaded', 'crawled', 'status', 'group'].includes(dimension)) throw new TypeError(`invalid seller membership dimension: ${dimension}`)
  const normalizedGroup = normalizeSellerStatusGroup(statusGroup || group)
  if (['status', 'group'].includes(dimension) && !normalizedGroup && !LOCKED_STATUSES.has(String(status || ''))) throw new TypeError(`invalid seller status: ${status}`)
  if (status && (statusGroup || group)) throw new TypeError('status and statusGroup cannot be combined')
  if ((statusGroup || group) && !normalizedGroup) throw new TypeError(`invalid seller status group: ${statusGroup || group}`)
  if (normalizedGroup && !['status', 'group'].includes(dimension)) throw new TypeError('statusGroup is only valid for status/group dimensions')
  const query = String(q || '').trim().toLowerCase()
  let rows = getAllSourceRows().filter(isIndexed)
  if (dimension === 'loaded') rows = rows.filter(isLoaded)
  if (dimension === 'crawled') rows = rows.filter(isCrawled)
  if (['status', 'group'].includes(dimension) && !normalizedGroup) rows = rows.filter((row) => row.status === status)
  if (normalizedGroup) rows = rowsForSellerStatusGroup(rows, normalizedGroup)
  if (query) rows = rows.filter((row) => [row.sellerId, row.url, row.sellerName, row.mainContent, row.mainType, row.category, row.board, row.boardName, row.sourceBoardRanks, row.rank, row.sourceRank, row.sourceOrdinal, row.cities].some((value) => String(value || '').toLowerCase().includes(query)))
  const rankValue = (row) => {
    const value = Number(row.sourceRank ?? row.rank ?? row.sourceOrdinal ?? row.excelRow)
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }
  rows.sort((left, right) => String(left.category || left.mainType || '').localeCompare(String(right.category || right.mainType || ''), 'zh-Hans')
    || String(left.boardName || left.board || '').localeCompare(String(right.boardName || right.board || ''), 'zh-Hans')
    || rankValue(left) - rankValue(right)
    || String(left.sellerName || '').localeCompare(String(right.sellerName || ''), 'zh-Hans')
    || String(left.sellerId || '').localeCompare(String(right.sellerId || ''), 'en')
    || String(left.id || '').localeCompare(String(right.id || ''), 'en'))
  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.min(1000, Math.max(1, Number(pageSize) || 100))
  const start = (safePage - 1) * safePageSize
  return {
    dimension,
    status: ['status', 'group'].includes(dimension) ? status : null,
    statusGroup: normalizedGroup || null,
    items: rows.slice(start, start + safePageSize).map(publicSellerRow),
    total: rows.length,
    page: safePage,
    pageSize: safePageSize
  }
}

/** Return one seller with its complete item, attempt, and snapshot evidence. */
export function getSellerQueueDetail({ sellerId = '', sourceId = '', runId = '' } = {}) {
  ensureLoaded()
  const wantedSellerId = String(sellerId || '').trim()
  const wantedSourceId = String(sourceId || '').trim()
  const wantedRunId = String(runId || '').trim()
  const candidates = sources.filter((row) => (
    (wantedSourceId && String(row.id) === wantedSourceId) ||
    (!wantedSourceId && wantedSellerId && String(row.sellerId || sellerIdFromSource(row) || '') === wantedSellerId)
  ))
  if (!candidates.length) return { ok: false, reason: '找不到对应卖家队列记录' }
  if (candidates.length > 1) return { ok: false, reason: '卖家ID对应多个来源，请改用sourceId查询' }
  const source = candidates[0]
  if (wantedSellerId && String(source.sellerId || sellerIdFromSource(source) || '') !== wantedSellerId) {
    return { ok: false, reason: 'sellerId与sourceId不匹配' }
  }
  const row = publicSellerRow({ ...source, ...(progress.get(source.id) || { status: 'pending' }) })
  const seller = {
    ...row,
    snapshotPath: row.snapshotPath || '',
    latestSnapshotPath: row.snapshotPath || '',
    snapshotAt: row.snapshotCapturedAt || null
  }
  const resolvedSellerId = String(source.sellerId || sellerIdFromSource(source) || '')
  // Keep the selected queue source in the evidence query. Legacy aliases are
  // resolved by the store, but a sellerId-only scan would mix two distinct
  // source rows that happen to point at the same seller.
  const items = queryItems({ sellerId: resolvedSellerId, sourceId: source.id, runId: wantedRunId, page: 1, pageSize: 1000000 }).items
  const attempts = (Array.isArray(row.attempts) ? row.attempts : []).map(({ lease: _lease, ...attempt }) => attempt)
  const snapshots = querySellerSnapshots({ sellerId: resolvedSellerId, sourceId: source.id, runId: wantedRunId, page: 1, pageSize: 1000 }).items
  return { ok: true, seller, items, attempts, snapshots }
}

export function getSellerEvidenceSummary() {
  ensureLoaded()
  const rows = getAllSourceRows().filter(isIndexed)
  const statuses = Object.fromEntries([...LOCKED_STATUSES].map((status) => [status, 0]))
  let loadedCount = 0
  let crawledCount = 0
  for (const row of rows) {
    if (!LOCKED_STATUSES.has(row.status)) throw new Error(`indexed seller has invalid status: ${row.status}`)
    statuses[row.status] += 1
    if (isLoaded(row)) loadedCount += 1
    if (isCrawled(row)) crawledCount += 1
  }
  const partitionTotal = Object.values(statuses).reduce((sum, count) => sum + count, 0)
  if (partitionTotal !== rows.length) throw new Error('seller status partition does not equal indexed universe')
  const groupCounts = {
    all: rows.length,
    pending: SELLER_STATUS_GROUPS.pending.reduce((sum, status) => sum + statuses[status], 0),
    completed: SELLER_STATUS_GROUPS.completed.reduce((sum, status) => sum + statuses[status], 0),
    failed: SELLER_STATUS_GROUPS.failed.reduce((sum, status) => sum + statuses[status], 0)
  }
  // `all` is intentionally the universe count, while the three operational
  // groups form the disjoint partition used by filters. Keeping both checks
  // explicit prevents a UI count from silently drifting from the index.
  const groupPartitionTotal = groupCounts.pending + groupCounts.completed + groupCounts.failed
  if (groupCounts.all !== rows.length || groupPartitionTotal !== rows.length) {
    throw new Error('seller status group partition does not equal indexed universe')
  }
  return { indexed: rows.length, loaded: loadedCount, crawled: crawledCount, statuses, groupCounts }
}

export function getAllSourceRows() {
  ensureLoaded()
  return sources.map((s) => ({ ...s, ...(progress.get(s.id) || { status: 'pending' }) }))
}

export function prepareRun({ reset = false, cycleKey = null, trigger = 'manual' } = {}) {
  ensureLoaded()
  recoverInterruptedState()
  const runId = randomUUID()
  if (reset) {
    progress = new Map()
    appendProgress({ kind: 'reset', runId, at: new Date().toISOString() })
  }
  let recoveredCount = 0
  for (const row of sources) {
    const p = progress.get(row.id)
    if (p?.status !== 'running') continue
    const recoveredAt = new Date().toISOString()
    progress.set(row.id, {
      ...p,
      status: 'pending',
      reasonCode: 'RECOVERED_INTERRUPTED',
      recoveredAt,
      recoveryPending: Boolean(p.currentAttempt),
      currentAttempt: p.currentAttempt ? { ...p.currentAttempt, recoveredAt } : null
    })
    recoveredCount++
  }
  persistCheckpoint(progress)
  // The checkpoint now contains every durable progress record, so retaining
  // the replay log only adds startup I/O. A crash before this atomic truncate
  // still leaves the already-fsynced checkpoint intact.
  writeBufferAtomic(progressPath, Buffer.alloc(0))
  // Preserve an account's pending risk-recovery marker while another eligible
  // account continues the queue. Replacing the whole job object here used to
  // silently drop that marker, leaving the cooled account stuck forever after
  // the run started.
  const previousJob = meta.get('job') || {}
  const job = {
    ...previousJob,
    running: true,
    runId,
    cycleKey: String(cycleKey || `manual:${runId}`),
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    resetMode: reset,
    recoveryPending: recoveredCount > 0,
    recoveredSellers: recoveredCount
  }
  meta.set('job', job)
  return job
}

export function claimNext(runId, accountId = '', accountCount = 1, cycleKey = `run:${runId}`, options = {}) {
  return withClaimMutex(() => {
  // Refresh under the cross-process mutex.  A process may have loaded the
  // queue before another process finalized a claim; selecting from stale
  // memory would re-claim a completed seller after lease release.
  loaded = false
  ensureLoaded()
  const persistentAccountId = String(accountId || '').trim()
  if (!persistentAccountId) throw new TypeError('account id must be non-empty before claiming seller work')
  const stableCycleKey = String(cycleKey || '').trim()
  if (!stableCycleKey) throw new TypeError('cycleKey must be non-empty')
  const allowedSellerIds = Array.isArray(options.allowedSellerIds) ? new Set(options.allowedSellerIds.map(String)) : null
  const incompleteSellerIds = Array.isArray(options.incompleteSellerIds) ? new Set(options.incompleteSellerIds.map(String)) : null
  const retryableSellerIds = Array.isArray(options.retryableSellerIds) ? new Set(options.retryableSellerIds.map(String)) : null
  const reviewSellerIds = Array.isArray(options.reviewSellerIds) ? new Set(options.reviewSellerIds.map(String)) : null
  const maxTransientRetries = Math.max(0, Number(options.maxTransientRetries) || 0)
  const allowed = (row) => !allowedSellerIds || allowedSellerIds.has(String(row.sellerId || sellerIdFromSource(row) || ''))
  const recoveredRow = sources.find((s) => {
    const p = progress.get(s.id)
    return allowed(s) && p?.status === 'pending' && p?.recoveryPending === true && p?.currentAttempt?.accountId === persistentAccountId
  })
  const row = recoveredRow || sources.find((s) => {
    const p = progress.get(s.id)
    const sellerId = String(s.sellerId || sellerIdFromSource(s) || '')
    const retryAllowed = Boolean(
      !options.pendingOnly &&
      p?.status === 'incomplete' &&
      p?.retryable === true &&
      retryableSellerIds?.has(sellerId) &&
      String(p.retryableAccountId || '') === persistentAccountId &&
      Number(p.retryCount || 0) < maxTransientRetries
    )
    const reviewAllowed = Boolean(
      !options.pendingOnly &&
      p?.status === 'needs_review' &&
      reviewSellerIds?.has(sellerId)
    )
    const eligible = options.pendingOnly
      ? (!p || p.status === 'pending')
      : (!p || p.status === 'pending' || retryAllowed || reviewAllowed || (p.status === 'incomplete' && (!incompleteSellerIds || incompleteSellerIds.has(sellerId))))
    const alreadyAttempted = (p?.attempts || []).some((attempt) => attempt.cycleKey === stableCycleKey && attempt.accountId === persistentAccountId)
    const reviewAttemptedInRun = reviewAllowed && (p?.attempts || []).some((attempt) => String(attempt.runId || '') === String(runId))
    return allowed(s) && eligible && !p?.currentAttempt && (!alreadyAttempted || retryAllowed || (reviewAllowed && !reviewAttemptedInRun))
  })
  if (!row) return null
  const recoveredProgress = recoveredRow ? progress.get(recoveredRow.id) : null
  const existingLease = recoveredProgress?.currentAttempt?.lease
  const existingOwner = existingLease?.lockPath ? readLeaseOwner(existingLease.lockPath) : null
  const reusableLease = Boolean(
    existingLease?.token && existingOwner?.token === existingLease.token &&
    String(existingOwner.sourceId) === String(row.id) &&
    String(existingOwner.accountId) === persistentAccountId &&
    String(existingOwner.runId) === String(recoveredProgress?.currentAttempt?.runId || '') &&
    String(existingOwner.cycleKey) === String(recoveredProgress?.currentAttempt?.cycleKey || '') &&
    Date.parse(existingOwner.expiresAt || '') > Date.now()
  )
  const lease = reusableLease
    ? rebindSellerLease({ ...existingOwner, lockPath: existingLease.lockPath }, { sourceId: row.id, accountId: persistentAccountId, runId, cycleKey: stableCycleKey })
    : createSellerLease({ sourceId: row.id, accountId: persistentAccountId, runId, cycleKey: stableCycleKey })
  if (!lease) return null
  const previous = normalizeProgressRow(progress.get(row.id) || { id: row.id })
  const startedAt = new Date().toISOString()
  if (previous.recoveryPending && previous.currentAttempt?.accountId === persistentAccountId) {
    // The formal attempt key remains stable across recovery, while its live
    // lease owner must carry the new run/cycle identity so release/renew calls
    // from this process can prove ownership of the reclaimed lease.
    const resumedAttempt = {
      ...previous.currentAttempt,
      runId,
      cycleKey: stableCycleKey,
      resumedAt: startedAt,
      recoveredAt: previous.recoveredAt || previous.currentAttempt.recoveredAt
    }
    const attempts = (previous.attempts || []).map((attempt) => attempt.attemptKey === resumedAttempt.attemptKey ? resumedAttempt : attempt)
    const next = markSource(row.id, {
      status: 'running',
      runId,
      cycleKey: resumedAttempt.cycleKey,
      reasonCode: 'RESUMED_INTERRUPTED',
      recoveryPending: false,
      currentAttempt: { ...resumedAttempt, lease: { token: lease.token, lockPath: lease.lockPath, expiresAt: lease.expiresAt } },
      attempts
    })
    return { ...row, ...next }
  }
  const activeExpected = previous.expected?.active
  const activeCount = previous.itemIds?.active?.length || 0
  const branch = activeExpected == null || activeCount < Number(activeExpected) ? 'active' : 'sold'
  const currentAttempt = {
    // Include the run ID so an explicitly authorized needs_review retry can
    // coexist with an older attempt from the same weekly cycle without
    // causing finalize/consume to update both ledger entries.
    attemptKey: `${stableCycleKey}:${row.id}:${persistentAccountId}:${runId}`,
    runId,
    cycleKey: stableCycleKey,
    sellerId: row.id,
    accountId: persistentAccountId,
    branch,
    startedAt,
    endedAt: null,
    outcome: null,
    reasonCode: null,
    immediateRetryUsed: false,
    transientReason: null
    ,lease: { token: lease.token, lockPath: lease.lockPath, expiresAt: lease.expiresAt }
  }
  const attemptedAccountIds = [...new Set((previous.attempts || [])
    .filter((attempt) => attempt.cycleKey === stableCycleKey)
    .map((attempt) => attempt.accountId)
    .concat(persistentAccountId))]
  let next
  try {
    next = markSource(row.id, {
    status: 'running',
    runId,
    cycleKey: stableCycleKey,
    startedAt,
    currentAttempt,
    attempts: [...(previous.attempts || []), currentAttempt],
    attemptedAccountIds
    })
  } catch (error) {
    releaseSellerLease({ ...lease, sourceId: row.id, accountId: persistentAccountId, runId, cycleKey: stableCycleKey })
    throw error
  }
  return { ...row, ...next }
  })
}

export function consumeImmediateRetry(id, accountId, transientReason) {
  ensureLoaded()
  const previous = progress.get(id)
  const current = previous?.currentAttempt
  if (!current || current.accountId !== String(accountId)) throw new Error('no matching current formal attempt')
  if (!['RENDER_CRASH', 'NAV_TRANSIENT'].includes(String(transientReason))) throw new Error('transient reason is not retryable')
  if (current.immediateRetryUsed) throw new Error('immediate retry already consumed')
  const updatedAttempt = { ...current, immediateRetryUsed: true, transientReason: String(transientReason) }
  const attempts = (previous.attempts || []).map((attempt) => attempt.attemptKey === current.attemptKey ? updatedAttempt : attempt)
  return markSource(id, { currentAttempt: updatedAttempt, attempts })
}

export function renewLease(id, { accountId, runId, cycleKey, token } = {}) {
  ensureLoaded()
  const current = progress.get(id)?.currentAttempt
  const lease = current?.lease
  if (!lease || lease.token !== token) return { renewed: false, reason: 'lease_not_owned' }
  const renewed = renewSellerLease({ ...lease, sourceId: id, accountId, runId, cycleKey, token })
  if (!renewed.renewed) return renewed
  const nextAttempt = { ...current, lease: { ...lease, expiresAt: renewed.expiresAt } }
  const attempts = (progress.get(id)?.attempts || []).map((attempt) => attempt.attemptKey === current.attemptKey ? { ...attempt, lease: nextAttempt.lease } : attempt)
  markSource(id, { currentAttempt: nextAttempt, attempts })
  return renewed
}

export function releaseLease(id, { accountId, runId, cycleKey, token } = {}) {
  ensureLoaded()
  const current = progress.get(id)?.currentAttempt
  const lease = current?.lease
  if (!lease || lease.token !== token) return { released: false, reason: 'lease_not_owned' }
  return releaseSellerLease({ ...lease, sourceId: id, accountId, runId, cycleKey, token })
}

export function releaseRunLeases(runId) {
  const released = []
  if (!existsSync(leaseRoot)) return released
  for (const name of readdirSync(leaseRoot)) {
    if (!name.endsWith('.lock')) continue
    const lockPath = join(leaseRoot, name)
    const owner = readLeaseOwner(lockPath)
    if (String(owner?.runId || '') !== String(runId || '')) continue
    const result = releaseSellerLease({ ...owner, lockPath })
    if (result.released) released.push(name)
  }
  return released
}

export function finalizeFormalAttempt(id, { accountId, cycleKey, status, reasonCode, ...patch } = {}) {
  ensureLoaded()
  if (!LOCKED_STATUSES.has(String(status || '')) || ['pending', 'running'].includes(status)) {
    throw new TypeError(`formal attempt cannot finalize with status: ${status || 'unknown'}`)
  }
  const previous = progress.get(id)
  const current = previous?.currentAttempt
  if (!current || current.accountId !== String(accountId) || current.cycleKey !== String(cycleKey)) {
    throw new Error('no matching current formal attempt to finalize')
  }
  const endedAt = new Date().toISOString()
  const snapshotFields = {
    snapshotId: patch.snapshotId || null,
    snapshotHash: patch.snapshotHash || null,
    snapshotPath: patch.snapshotPath || null,
    snapshotCapturedAt: patch.snapshotCapturedAt || null,
    snapshotBytes: patch.snapshotBytes || null,
    snapshotViewport: patch.snapshotViewport || null,
    snapshotComplete: patch.snapshotComplete == null ? null : Boolean(patch.snapshotComplete),
    snapshotExpectedCount: patch.snapshotExpectedCount == null ? null : Number(patch.snapshotExpectedCount),
    snapshotObservedCount: patch.snapshotObservedCount == null ? null : Number(patch.snapshotObservedCount),
    snapshotInlineImageCount: patch.snapshotInlineImageCount == null ? null : Number(patch.snapshotInlineImageCount),
    snapshotRemoteImageCount: patch.snapshotRemoteImageCount == null ? null : Number(patch.snapshotRemoteImageCount)
  }
  const finalizedAttempt = {
    ...current,
    ...snapshotFields,
    endedAt,
    outcome: status,
    reasonCode: reasonCode || null,
    crawlStartedAt: current.crawlStartedAt || current.startedAt,
    crawlFinishedAt: endedAt,
    crawlResult: status
  }
  const attempts = (previous.attempts || []).map((attempt) => attempt.attemptKey === current.attemptKey ? finalizedAttempt : attempt)
  const attemptedAccountIds = [...new Set(attempts.filter((attempt) => attempt.cycleKey === current.cycleKey).map((attempt) => attempt.accountId))]
  const next = markSource(id, {
    ...patch,
    status,
    reasonCode,
    finalizedAt: endedAt,
    currentAttempt: null,
    attempts,
    attemptedAccountIds
  })
  if (current.lease) releaseSellerLease({ ...current.lease, sourceId: id, accountId, runId: current.runId, cycleKey: current.cycleKey })
  return next
}

export function markSource(id, patch) {
  ensureLoaded()
  if (!sourceIds.has(id)) throw new Error(`unknown seller source: ${id}`)
  if (patch && Object.hasOwn(patch, 'status') && !LOCKED_STATUSES.has(String(patch.status || ''))) {
    throw new TypeError(`invalid seller status: ${patch.status || 'empty'}`)
  }
  const previous = progress.get(id) || { id }
  const next = normalizeProgressRow({ ...previous, ...patch, id, updatedAt: new Date().toISOString() })
  // The fsynced replay row is the per-seller commit. Rewriting a checkpoint
  // containing every seller on every branch would turn a 10k crawl into
  // quadratic I/O; checkpoints are compacted only at run boundaries.
  appendProgress(next)
  progress.set(id, next)
  return next
}

export function finishRun(patch = {}) {
  ensureLoaded()
  persistCheckpoint(progress)
  writeBufferAtomic(progressPath, Buffer.alloc(0))
  const job = { ...meta.get('job'), running: false, finishedAt: new Date().toISOString(), ...patch }
  releaseRunLeases(job.runId)
  meta.set('job', job)
  return job
}

export function getStatus() {
  ensureLoaded()
  const rows = getAllSourceRows()
  const counts = { total: rows.length, pending: 0, running: 0, completed: 0, no_active: 0, incomplete: 0, needs_review: 0, failed: 0, login_expired: 0, risk_cooldown: 0 }
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1
  let itemBytes = 0
  try { itemBytes = statSync(itemsPath).size } catch { /* not created yet */ }
  const evidence = canonicalSellerIds.size || existsSync(canonicalManifestPath) ? getSellerEvidenceSummary() : null
  return { ...counts, evidence, sourceMode: getSourceMode(), job: meta.get('job'), lastImport: meta.get('lastImport'), itemBytes, paths: getDataPaths() }
}

function sanitizePersistedItemUrl(value, kind) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') return ''
    if (kind === 'item') {
      const host = url.hostname.toLowerCase()
      if (host !== 'goofish.com' && !host.endsWith('.goofish.com')) return ''
      const allowed = new Set(['id', 'itemId'])
      for (const key of [...url.searchParams.keys()]) if (!allowed.has(key)) url.searchParams.delete(key)
    } else {
      for (const key of [...url.searchParams.keys()]) {
        if (/token|signature|sig|session|auth|credential|secret|password|cookie|access[_-]?key/i.test(key)) url.searchParams.delete(key)
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

export function appendItems(items, { runId, source, snapshotId = null } = {}) {
  if (items == null) return 0
  if (!Array.isArray(items)) throw new TypeError('seller items must be an array')
  if (!items.length) return 0
  const now = new Date().toISOString()
  const observationCycle = source?.currentAttempt?.attemptKey || source?.cycleKey || runId || ''
  const lines = items.map((item) => JSON.stringify({
    ...item,
    itemUrl: sanitizePersistedItemUrl(item?.itemUrl, 'item'),
    imageUrl: sanitizePersistedItemUrl(item?.imageUrl, 'image'),
    observationId: createHash('sha256').update([
      String(observationCycle),
      String(source?.id || ''),
      String(item?.itemId || ''),
      String(item?.status || '')
    ].join('\0')).digest('hex'),
    observedAt: now,
    runId,
    sourceId: String(source?.id || ''),
    attemptKey: String(source?.currentAttempt?.attemptKey || ''),
    snapshotId: String(snapshotId || ''),
    sellerUrl: source?.url,
    sellerId: source?.sellerId || sellerIdFromSource(source) || ''
  })).join('\n') + '\n'
  const fd = openSync(itemsPath, 'a', 0o600)
  try {
    writeFileSync(fd, lines, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // The append-only observation file and the current checkpoint advance as one
  // durable commit boundary. Item IDs were checkpointed by the branch evidence
  // callback; this second checkpoint proves the corresponding batch reached disk.
  if (source?.id && progress.has(source.id)) {
    const next = {
      ...progress.get(source.id),
      lastItemBatchCommittedAt: now,
      lastItemBatchCount: items.length
    }
    appendProgress(next)
    progress.set(source.id, next)
  }
  return items.length
}

const SELLER_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024

const SNAPSHOT_SECRET_PARAM = /^(?:token|signature|sig|session|auth|credential|secret|password|passwd|cookie|access[_-]?key|authorization)$/i

function sanitizeSnapshotAttribute(value) {
  const raw = String(value || '')
  // Snapshot capture may inline validated raster assets so a later offline
  // preview does not depend on an expiring CDN URL. Only strict base64 raster
  // data is allowed; SVG/HTML/script-bearing data URLs remain forbidden.
  if (/^data:image\/(?:jpeg|png|gif|webp|avif|bmp);base64,[a-z0-9+/]+=*$/i.test(raw)) return raw
  if (/^javascript:/i.test(raw)) return ''
  try {
    const isRelative = /^(?:[/?#]|\.\.?\/)/.test(raw)
    const parsed = new URL(raw, isRelative ? 'https://www.goofish.com' : undefined)
    if (!isRelative && !['http:', 'https:'].includes(parsed.protocol)) return ''
    for (const key of [...parsed.searchParams.keys()]) if (SNAPSHOT_SECRET_PARAM.test(key)) parsed.searchParams.delete(key)
    parsed.username = ''
    parsed.password = ''
    parsed.hash = ''
    if (isRelative) return `${parsed.pathname}${parsed.search}` || '/'
    return parsed.href
  } catch {
    return raw
  }
}

function sanitizeSnapshotSrcset(value) {
  return String(value || '').split(',').map((candidate) => {
    const match = candidate.trim().match(/^(\S+)(\s+.*)?$/)
    if (!match) return ''
    const url = sanitizeSnapshotAttribute(match[1])
    return url ? `${url}${match[2] || ''}` : ''
  }).filter(Boolean).join(', ')
}

function sanitizeSnapshotCss(value) {
  return String(value || '').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_full, quote, target) => {
    const sanitized = sanitizeSnapshotAttribute(target)
    return sanitized ? `url(${quote}${sanitized}${quote})` : 'none'
  })
}

function sanitizeSellerSnapshotHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*\/?>/gi, '')
    .replace(/<base\b[^>]*\/?>/gi, '')
    .replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*(['"]?)refresh\1[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\b(href|src|action|poster|data|cite|background)\s*=\s*("[^"]*"|'[^']*')/gi, (_full, name, quoted) => {
      const quote = quoted[0]
      return `${name}=${quote}${sanitizeSnapshotAttribute(quoted.slice(1, -1))}${quote}`
    })
    .replace(/\bsrcset\s*=\s*("[^"]*"|'[^']*')/gi, (_full, quoted) => {
      const quote = quoted[0]
      return `srcset=${quote}${sanitizeSnapshotSrcset(quoted.slice(1, -1))}${quote}`
    })
    .replace(/\bstyle\s*=\s*("[^"]*"|'[^']*')/gi, (_full, quoted) => {
      const quote = quoted[0]
      return `style=${quote}${sanitizeSnapshotCss(quoted.slice(1, -1))}${quote}`
    })
}

function secureSnapshotPath(candidate) {
  const root = resolve(snapshotDir)
  try {
    const realRoot = realpathSync(root)
    const realTarget = realpathSync(candidate)
    if (!realTarget.startsWith(realRoot + sep)) return null
    return realTarget
  } catch {
    return null
  }
}

function validSnapshotId(value) {
  const id = String(value || '').trim()
  if (!/^[a-f0-9]{16,64}$/i.test(id)) throw new TypeError('seller snapshot id is invalid')
  return id
}

function snapshotPathForId(snapshotId) {
  const id = validSnapshotId(snapshotId)
  return join(snapshotDir, `${id}.html`)
}

function snapshotMetadataPathForId(snapshotId) {
  const id = validSnapshotId(snapshotId)
  return join(snapshotDir, `${id}.json`)
}

function cleanSnapshotMetadata(value = {}) {
  const allowed = [
    'runId', 'sourceId', 'sellerId', 'sellerName', 'sourceUrl', 'attemptKey', 'cycleKey',
    'accountId', 'status', 'reasonCode', 'evidenceKind', 'itemCount', 'activeCount', 'soldCount',
    'capturedAt', 'pageUrl', 'viewport', 'stopReason', 'loadingKind', 'complete', 'expectedCount',
    'observedCount', 'inlineImageCount', 'remoteImageCount'
  ]
  const result = {}
  for (const key of allowed) {
    const raw = value?.[key]
    if (raw === undefined || raw === null || raw === '') continue
    if (/token|cookie|authorization|password|secret|session/i.test(key)) continue
    if (key === 'viewport' && raw && typeof raw === 'object') {
      result.viewport = {
        width: Number.isFinite(Number(raw.width)) ? Number(raw.width) : null,
        height: Number.isFinite(Number(raw.height)) ? Number(raw.height) : null
      }
      continue
    }
    result[key] = typeof raw === 'string' ? raw.slice(0, 2000) : raw
  }
  return result
}

/**
 * Persist one seller-page DOM snapshot separately from the item log. Snapshot
 * files are immutable and keyed by a formal attempt, so a later crawl never
 * overwrites the evidence used to explain an earlier queue result.
 */
export function saveSellerSnapshot(html, metadata = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new TypeError('seller snapshot content is empty')
  const sanitizedHtml = sanitizeSellerSnapshotHtml(html)
  const buffer = Buffer.from(sanitizedHtml, 'utf8')
  if (buffer.byteLength > SELLER_SNAPSHOT_MAX_BYTES) throw new Error('seller snapshot exceeds 32MB safety limit')
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 })
  const capturedAt = new Date(metadata.capturedAt || Date.now())
  const at = Number.isFinite(capturedAt.getTime()) ? capturedAt.toISOString() : new Date().toISOString()
  const snapshotId = createHash('sha256').update([
    String(metadata.runId || ''), String(metadata.sourceId || ''), String(metadata.attemptKey || ''), at, sanitizedHtml
  ].join('\0')).digest('hex').slice(0, 32)
  const htmlPath = snapshotPathForId(snapshotId)
  const metadataPath = snapshotMetadataPathForId(snapshotId)
  const snapshotHash = createHash('sha256').update(buffer).digest('hex')
  const record = {
    schemaVersion: 1,
    snapshotId,
    snapshotHash,
    bytes: buffer.byteLength,
    path: htmlPath,
    ...cleanSnapshotMetadata(metadata),
    capturedAt: at
  }
  // Never replace an existing immutable snapshot. A same-ID write can only
  // happen when a retry replays the exact same attempt and HTML.
  if (!existsSync(htmlPath)) writeBufferAtomic(htmlPath, buffer)
  if (!existsSync(metadataPath)) writeJsonAtomic(metadataPath, record)
  const securePath = secureSnapshotPath(htmlPath) || htmlPath
  return { ...record, path: securePath, url: pathToFileURL(securePath).href }
}

function safeSnapshotRecord(record = {}) {
  const snapshotId = String(record.snapshotId || '').trim()
  if (!/^[a-f0-9]{16,64}$/i.test(snapshotId)) return null
  const path = snapshotPathForId(snapshotId)
  if (!existsSync(path)) return null
  const securePath = secureSnapshotPath(path)
  if (!securePath) return null
  let stats
  try { stats = statSync(securePath) } catch { return null }
  if (record.bytes != null && Number(record.bytes) !== stats.size) return null
  if (!record.snapshotHash) return null
  try {
    const actualHash = createHash('sha256').update(readFileSync(securePath)).digest('hex')
    if (String(record.snapshotHash) !== actualHash) return null
  } catch {
    return null
  }
  // Metadata files from early builds were not allowlisted. Re-sanitize on
  // every read so legacy cookie/customToken fields never cross the store or
  // IPC boundary, even if the old JSON is still present on disk.
  const safeMetadata = cleanSnapshotMetadata(record)
  const safe = {
    schemaVersion: Number(record.schemaVersion) || 1,
    snapshotId,
    snapshotHash: String(record.snapshotHash),
    bytes: stats.size,
    ...safeMetadata
  }
  return { ...safe, path: securePath, url: pathToFileURL(securePath).href }
}

function readSellerSnapshotRecords() {
  const rows = []
  if (!existsSync(snapshotDir)) return rows
  for (const file of readdirSync(snapshotDir).filter((name) => name.endsWith('.json'))) {
    try {
      const safe = safeSnapshotRecord(JSON.parse(readFileSync(join(snapshotDir, file), 'utf8')))
      if (safe) rows.push(safe)
    } catch { /* ignore a partially written metadata file */ }
  }
  rows.sort((left, right) => String(right.capturedAt || '').localeCompare(String(left.capturedAt || '')) || String(right.snapshotId).localeCompare(String(left.snapshotId)))
  return rows
}

/** Read snapshot metadata through an ID/path constrained to seller-snapshots. */
export function readSellerSnapshot({ snapshotId = '', path = '' } = {}) {
  const requestedTarget = snapshotId
    ? snapshotPathForId(snapshotId)
    : resolve(String(path || ''))
  if (extname(requestedTarget).toLowerCase() !== '.html' || !existsSync(requestedTarget)) {
    throw new Error('卖家网页快照不存在或路径无效')
  }
  const target = secureSnapshotPath(requestedTarget)
  if (!target) throw new Error('卖家网页快照路径无效')
  const inferredId = basename(target, '.html')
  const metadataPath = snapshotMetadataPathForId(inferredId)
  let metadata = { snapshotId: inferredId }
  try { metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) } catch { /* metadata is best effort */ }
  const safe = safeSnapshotRecord({ ...metadata, snapshotId: inferredId })
  if (!safe) throw new Error('卖家网页快照元数据无效')
  const rawHtml = readFileSync(target, 'utf8')
  const actualHash = createHash('sha256').update(rawHtml).digest('hex')
  if (String(metadata.snapshotHash || '') !== actualHash) throw new Error('卖家网页快照校验失败')
  // Old snapshots predate the sanitizer. When their bytes change after
  // cleaning, return srcdoc so Chromium never receives the unsafe file URL.
  const safeHtml = sanitizeSellerSnapshotHtml(rawHtml)
  if (safeHtml !== rawHtml) return { ok: true, kind: 'html-srcdoc', html: safeHtml, ...safe, url: '' }
  return { ok: true, kind: 'html', ...safe }
}

export function querySellerSnapshots({ sellerId = '', sourceId = '', runId = '', snapshotId = '', page = 1, pageSize = 50 } = {}) {
  ensureLoaded()
  const selectors = { sellerId, sourceId, runId, snapshotId }
  const normalized = Object.fromEntries(Object.entries(selectors).map(([key, value]) => [key, String(value || '').trim()]))
  const sourceSellerId = normalized.sourceId
    ? String(sellerIdFromSource(sources.find((row) => String(row.id) === normalized.sourceId)) || '')
    : ''
  const selectedSource = normalized.sourceId ? sources.find((row) => String(row.id) === normalized.sourceId) : null
  const aliases = new Set(Array.isArray(selectedSource?.legacySourceIds) ? selectedSource.legacySourceIds.map((value) => String(value)) : [])
  const uniqueSellerSource = sourceSellerId && sources.filter((row) => String(sellerIdFromSource(row) || '') === sourceSellerId).length === 1
  const rows = readSellerSnapshotRecords().filter((safe) => {
    if (normalized.snapshotId && safe.snapshotId !== normalized.snapshotId) return false
    if (normalized.sellerId && String(safe.sellerId || '') !== normalized.sellerId) return false
    if (normalized.sourceId && String(safe.sourceId || '') !== normalized.sourceId && !aliases.has(String(safe.sourceId || '')) && !(uniqueSellerSource && String(safe.sellerId || '') === (normalized.sellerId || sourceSellerId))) return false
    if (normalized.runId && String(safe.runId || '') !== normalized.runId) return false
    return true
  })
  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.min(1000000, Math.max(1, Number(pageSize) || 50))
  const start = (safePage - 1) * safePageSize
  return { items: rows.slice(start, start + safePageSize), total: rows.length, page: safePage, pageSize: safePageSize }
}

function readTailLines(path, maxBytes = 8 * 1024 * 1024) {
  if (!existsSync(path)) return []
  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  // 不把多年累积的商品日志一次性读进内存；只读取文件尾部用于 UI 最近记录。
  const fd = openSync(path, 'r')
  const length = size - start
  const buf = Buffer.alloc(length)
  readSync(fd, buf, 0, length, start)
  closeSync(fd)
  const text = start ? buf.toString('utf8').replace(/^[^\n]*\n/, '') : buf.toString('utf8')
  return text.split('\n').filter(Boolean)
}

function readAllLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

function stableSourceIdForItem(row = {}) {
  try {
    const url = normalizeSellerHomeUrl(String(row.sellerUrl || ''))
    return sourceId(url)
  } catch {
    const explicit = String(row.sourceId || '').trim()
    if (explicit) return explicit
    const sellerId = String(row.sellerId || '').trim()
    return sellerId ? sourceId(canonicalUrl(sellerId)) : ''
  }
}

export function queryItems({ page = 1, pageSize = 50, q = '', status = null, sellerId = '', sourceId = '', runId = '', snapshotId = '' } = {}) {
  ensureLoaded()
  const query = String(q || '').trim().toLowerCase()
  const selectors = {
    sellerId: String(sellerId || '').trim(),
    sourceId: String(sourceId || '').trim(),
    runId: String(runId || '').trim(),
    snapshotId: String(snapshotId || '').trim()
  }
  const sourceSellerId = selectors.sourceId
    ? String(sellerIdFromSource(sources.find((row) => String(row.id) === selectors.sourceId)) || '')
    : ''
  const selectedSource = selectors.sourceId ? sources.find((row) => String(row.id) === selectors.sourceId) : null
  const aliases = new Set(Array.isArray(selectedSource?.legacySourceIds) ? selectedSource.legacySourceIds.map((value) => String(value)) : [])
  const uniqueSellerSource = sourceSellerId && sources.filter((row) => String(sellerIdFromSource(row) || '') === sourceSellerId).length === 1
  const selectedSellerId = selectors.sellerId || sourceSellerId
  const fullScan = Object.values(selectors).some(Boolean)
  let rows = []
  for (const line of fullScan ? readAllLines(itemsPath) : readTailLines(itemsPath)) {
    try {
      const row = JSON.parse(line)
      if (status && row.status !== status) continue
      if (selectors.sellerId && String(row.sellerId || '') !== selectors.sellerId) continue
      const rowSellerId = String(row.sellerId || sellerIdFromSource(row) || '')
      if (selectors.sourceId && stableSourceIdForItem(row) !== selectors.sourceId && !aliases.has(String(row.sourceId || '')) && !(uniqueSellerSource && rowSellerId === selectedSellerId)) continue
      if (selectors.runId && String(row.runId || '') !== selectors.runId) continue
      if (selectors.snapshotId && String(row.snapshotId || '') !== selectors.snapshotId) continue
      if (query && ![row.title, row.price, row.sellerUrl, row.itemUrl, row.sellerName].some((v) => String(v || '').toLowerCase().includes(query))) continue
      rows.push(row)
    } catch { /* ignore a partially written final line */ }
  }
  rows.reverse()
  const total = rows.length
  const start = Math.max(0, (Number(page) - 1) * Number(pageSize))
  return { items: rows.slice(start, start + Number(pageSize)), total, tailLimited: !fullScan }
}

export function addEvent(event) {
  const safeEvent = appendEventRecord(event)
  const list = meta.get('recentEvents') || []
  list.unshift(safeEvent)
  if (list.length > 100) list.length = 100
  meta.set('recentEvents', list)
}

export function getRecentEvents() {
  return meta.get('recentEvents') || []
}

/**
 * Read the durable event stream (including archived .jsonl.gz partitions).
 * The renderer's recent-events ring is intentionally small; run history is a
 * separate query so an old run remains inspectable after many later runs.
 */
export function queryEventHistory({ runId = '', sellerId = '', type = '', page = 1, pageSize = 50 } = {}) {
  const normalizedRunId = String(runId || '').trim()
  const normalizedSellerId = String(sellerId || '').trim()
  const normalizedType = String(type || '').trim()
  const rows = []
  const files = []
  if (existsSync(eventsDir)) files.push(...readdirSync(eventsDir).filter((name) => name.endsWith('.jsonl')).map((name) => ({ path: join(eventsDir, name), archived: false })))
  if (existsSync(eventArchiveDir)) files.push(...readdirSync(eventArchiveDir).filter((name) => name.endsWith('.jsonl.gz')).map((name) => ({ path: join(eventArchiveDir, name), archived: true })))
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    try {
      const text = file.archived ? gunzipSync(readFileSync(file.path)).toString('utf8') : readFileSync(file.path, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (normalizedRunId && String(event.runId || event.priorRunId || '') !== normalizedRunId) continue
          if (normalizedSellerId && String(event.sellerId || '') !== normalizedSellerId) continue
          if (normalizedType && String(event.type || '') !== normalizedType) continue
          rows.push(event)
        } catch { /* ignore one malformed event line */ }
      }
    } catch { /* ignore an unavailable archive partition */ }
  }
  rows.sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))
  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.min(1000000, Math.max(1, Number(pageSize) || 50))
  const start = (safePage - 1) * safePageSize
  return { items: rows.slice(start, start + safePageSize), total: rows.length, page: safePage, pageSize: safePageSize }
}

export function getSellerRunDetail(runId) {
  ensureLoaded()
  const normalizedRunId = String(runId || '').trim()
  if (!normalizedRunId) throw new TypeError('runId is required')
  const sellers = []
  for (const source of sources) {
    const row = publicSellerRow({ ...source, ...(progress.get(source.id) || { status: 'pending' }) })
    const attempts = (Array.isArray(row.attempts) ? row.attempts : [])
      .filter((attempt) => String(attempt.runId || '') === normalizedRunId)
      .sort((left, right) => String(right.endedAt || right.startedAt || '').localeCompare(String(left.endedAt || left.startedAt || '')) || String(right.attemptKey || '').localeCompare(String(left.attemptKey || '')))
    if (!attempts.length) continue
    const latest = attempts[0]
    sellers.push({
      ...row,
      status: latest.outcome || row.status,
      reasonCode: latest.reasonCode || row.reasonCode || '',
      snapshotId: latest.snapshotId || row.snapshotId || '',
      snapshotHash: latest.snapshotHash || row.snapshotHash || '',
      snapshotPath: latest.snapshotPath || row.snapshotPath || '',
      activeCount: row.activeCount ?? null,
      soldCount: row.soldCount ?? null,
      attemptCount: attempts.length
    })
  }
  sellers.sort((left, right) => String(left.sellerId || '').localeCompare(String(right.sellerId || '')))
  const events = queryEventHistory({ runId: normalizedRunId, page: 1, pageSize: 1000000 }).items
  const startEvent = events.find((event) => ['start', 'recovery_start', 'seller-watchdog-restart'].includes(String(event.type || '')))
  const terminalEvent = events.find((event) => ['seller-done', 'seller-error', 'done', 'error'].includes(String(event.type || '')))
  return {
    runId: normalizedRunId,
    trigger: startEvent?.trigger || startEvent?.outcome || null,
    outcome: terminalEvent?.outcome || terminalEvent?.status || null,
    events,
    sellers,
    total: sellers.length
  }
}

function queryAllSellerRows(filter = {}) {
  const first = querySellerMembership({ ...filter, page: 1, pageSize: 1000 })
  const rows = [...first.items]
  for (let page = 2; rows.length < first.total; page += 1) {
    const next = querySellerMembership({ ...filter, page, pageSize: 1000 })
    if (!next.items.length) break
    rows.push(...next.items)
  }
  if (rows.length !== first.total) throw new Error('卖家详细导出行数与筛选结果不一致')
  return rows
}

function readSellerItemIndex() {
  const index = new Map()
  for (const line of readAllLines(itemsPath)) {
    try {
      const item = JSON.parse(line)
      const sellerId = String(item.sellerId || sellerIdFromSource(item) || '')
      const key = `${stableSourceIdForItem(item)}\0${sellerId}`
      const rows = index.get(key) || []
      rows.push(item)
      index.set(key, rows)
      const sellerKey = `\0${sellerId}`
      if (sellerKey !== key) {
        const sellerRows = index.get(sellerKey) || []
        sellerRows.push(item)
        index.set(sellerKey, sellerRows)
      }
    } catch { /* ignore a partially written final line */ }
  }
  return index
}

function mergeSellerIndexRows(index, exactKey, fallbackKey, identity) {
  const rows = []
  const seen = new Set()
  for (const key of [exactKey, fallbackKey]) {
    for (const row of index.get(key) || []) {
      const token = identity(row)
      if (seen.has(token)) continue
      seen.add(token)
      rows.push(row)
    }
  }
  return rows
}

function sanitizeExportUrl(value, kind = 'general') {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') return ''
    if (kind === 'seller' && url.hostname !== 'goofish.com' && !url.hostname.endsWith('.goofish.com')) return ''
    if (kind === 'item') {
      const host = url.hostname.toLowerCase()
      if (host !== 'goofish.com' && !host.endsWith('.goofish.com')) return ''
      for (const key of [...url.searchParams.keys()]) if (!['id', 'itemId'].includes(key)) url.searchParams.delete(key)
    } else {
      for (const key of [...url.searchParams.keys()]) if (SNAPSHOT_SECRET_PARAM.test(key)) url.searchParams.delete(key)
    }
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

function relativeSnapshotReference(snapshot) {
  const id = String(snapshot?.snapshotId || '').trim()
  return /^[a-f0-9]{16,64}$/i.test(id) ? `seller-snapshots/${id}.html` : ''
}

function copySellerSnapshotBundle(snapshotRows, outputPath) {
  const bundleDir = join(dirname(resolve(outputPath)), 'seller-snapshots')
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 })
  let copied = 0
  for (const snapshot of snapshotRows) {
    const id = String(snapshot?.snapshotId || '').trim()
    if (!/^[a-f0-9]{16,64}$/i.test(id)) continue
    const source = secureSnapshotPath(snapshot.path || snapshotPathForId(id))
    if (!source) continue
    const target = join(bundleDir, `${id}.html`)
    if (resolve(source) !== resolve(target)) {
      copyFileSync(source, target)
      copied += 1
    }
  }
  return { directory: bundleDir, copied }
}

function sellerExportSummaryRow(row, itemIndex, snapshotIndex) {
  const itemKey = `${String(row.id || '')}\0${String(row.sellerId || '')}`
  const sellerKey = `\0${String(row.sellerId || '')}`
  const items = mergeSellerIndexRows(itemIndex, itemKey, sellerKey, (item) => String(item.observationId || `${item.itemId || ''}\0${item.runId || ''}\0${item.attemptKey || ''}\0${item.capturedAt || ''}\0${item.itemUrl || ''}`))
  const snapshots = mergeSellerIndexRows(snapshotIndex, itemKey, sellerKey, (snapshot) => String(snapshot.snapshotId || `${snapshot.sourceId || ''}\0${snapshot.capturedAt || ''}`))
  const latest = snapshots[0] || null
  return {
    卖家ID: row.sellerId,
    卖家主页: sanitizeExportUrl(row.url, 'seller'),
    卖家名称: row.sellerName,
    主营内容: row.mainContent,
    主营类型: row.mainType,
    分类: row.category,
    榜单: row.boardName || row.board,
    来源榜单排名: row.sourceBoardRanks,
    榜单排名: row.sourceRank ?? row.rank,
    来源序号: row.sourceOrdinal,
    榜单槽位数: row.sourceSlotCount,
    城市: row.cities,
    Excel行: row.excelRow,
    当前状态: row.status,
    原因代码: row.reasonCode,
    原因说明: row.reason,
    正式尝试数: Array.isArray(row.attempts) ? row.attempts.length : Number(row.attemptCount) || 0,
    在售已采: row.activeCount,
    在售期望: row.expected?.active ?? null,
    已售已采: row.soldCount,
    已售期望: row.expected?.sold ?? null,
    商品观测数: items.length,
    快照数: snapshots.length,
    最近快照ID: latest?.snapshotId || '',
    最近快照哈希: latest?.snapshotHash || '',
    最近快照时间: latest?.capturedAt || '',
    最近更新时间: row.updatedAt || row.finalizedAt || row.importedAt || '',
    最近持久写入: row.lastItemBatchCommittedAt || row.persistedAt || row.committedAt || ''
  }
}

// Keep one header row plus data below Excel's practical 1,000,000-row handoff
// limit. Chunking every sheet also keeps the exported workbook usable in older
// spreadsheet clients that fail well before Excel's absolute worksheet cap.
export const SELLER_EXPORT_DATA_ROW_LIMIT = 999_999

export function chunkSellerExportRows(rows = [], limit = SELLER_EXPORT_DATA_ROW_LIMIT) {
  const safeLimit = Math.max(1, Math.min(SELLER_EXPORT_DATA_ROW_LIMIT, Math.floor(Number(limit) || SELLER_EXPORT_DATA_ROW_LIMIT)))
  const input = Array.isArray(rows) ? rows : []
  if (!input.length) return [[]]
  const chunks = []
  for (let start = 0; start < input.length; start += safeLimit) chunks.push(input.slice(start, start + safeLimit))
  return chunks
}

function appendChunkedSellerSheet(workbook, rows, baseName) {
  const manifest = []
  const chunks = chunkSellerExportRows(rows)
  chunks.forEach((chunk, index) => {
    const suffix = chunks.length > 1 ? String(index + 1) : ''
    const sheetName = `${baseName}${suffix}`.slice(0, 31)
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(chunk), sheetName)
    manifest.push({ sheet: sheetName, rowCount: chunk.length, hasHeader: true })
  })
  return manifest
}

/**
 * Export seller evidence as a workbook rather than the queue's one-row view.
 * The three core sheets deliberately keep seller summary, item observations,
 * and formal attempts separate so a later crawl never destroys history.
 */
export function exportSellerDetails({ filter = {}, outputPath } = {}) {
  if (!outputPath) throw new Error('未指定卖家详细 Excel 保存路径')
  const rows = queryAllSellerRows(filter)
  // Build the two append-only indexes once. A 10k-seller export must not
  // rescan a multi-gigabyte item log once per seller.
  const itemIndex = readSellerItemIndex()
  const snapshotIndex = new Map()
  for (const snapshot of readSellerSnapshotRecords()) {
    const key = `${String(snapshot.sourceId || '')}\0${String(snapshot.sellerId || '')}`
    const entries = snapshotIndex.get(key) || []
    entries.push(snapshot)
    snapshotIndex.set(key, entries)
    const sellerKey = `\0${String(snapshot.sellerId || '')}`
    if (sellerKey !== key) {
      const sellerEntries = snapshotIndex.get(sellerKey) || []
      sellerEntries.push(snapshot)
      snapshotIndex.set(sellerKey, sellerEntries)
    }
  }
  const summary = rows.map((row) => sellerExportSummaryRow(row, itemIndex, snapshotIndex))
  const itemDetails = []
  const history = []
  const snapshots = []
  const snapshotFiles = []
  for (const row of rows) {
    const itemKey = `${String(row.id || '')}\0${String(row.sellerId || '')}`
    const sellerKey = `\0${String(row.sellerId || '')}`
    const sellerItems = mergeSellerIndexRows(itemIndex, itemKey, sellerKey, (item) => String(item.observationId || `${item.itemId || ''}\0${item.runId || ''}\0${item.attemptKey || ''}\0${item.capturedAt || ''}\0${item.itemUrl || ''}`))
    for (const item of sellerItems) {
      itemDetails.push({
        卖家ID: row.sellerId,
        卖家名称: row.sellerName,
        卖家主页: sanitizeExportUrl(row.url, 'seller'),
        来源ID: row.id,
        运行ID: item.runId || '',
        快照ID: item.snapshotId || '',
        观测ID: item.observationId || '',
        商品ID: item.itemId || '',
        商品链接: sanitizeExportUrl(item.itemUrl, 'item'),
        商品标题: item.title || '',
        价格: item.price ?? '',
        商品状态: item.status || 'unknown',
        想要数: item.wants ?? '',
        商品分类: item.category || '',
        采集时间: item.capturedAt || '',
        观测写入时间: item.observedAt || ''
      })
    }
    for (const attempt of Array.isArray(row.attempts) ? row.attempts : []) {
      history.push({
        卖家ID: row.sellerId,
        卖家名称: row.sellerName,
        来源ID: row.id,
        运行ID: attempt.runId || row.runId || '',
        周期键: attempt.cycleKey || '',
        尝试键: attempt.attemptKey || '',
        账号ID: attempt.accountId || '',
        分支: attempt.branch || '',
        尝试结果: attempt.outcome || '',
        原因代码: attempt.reasonCode || '',
        开始时间: attempt.startedAt || '',
        结束时间: attempt.endedAt || '',
        爬取开始: attempt.crawlStartedAt || '',
        爬取结束: attempt.crawlFinishedAt || '',
        快照ID: attempt.snapshotId || row.snapshotId || '',
        快照哈希: attempt.snapshotHash || row.snapshotHash || ''
      })
    }
    const sellerSnapshots = mergeSellerIndexRows(snapshotIndex, itemKey, sellerKey, (snapshot) => String(snapshot.snapshotId || `${snapshot.sourceId || ''}\0${snapshot.capturedAt || ''}`))
    snapshotFiles.push(...sellerSnapshots)
    snapshots.push(...sellerSnapshots.map((snapshot) => ({
      卖家ID: row.sellerId,
      卖家名称: row.sellerName,
      来源ID: row.id,
      快照ID: snapshot.snapshotId,
      快照哈希: snapshot.snapshotHash,
      快照字节数: snapshot.bytes,
      运行ID: snapshot.runId || '',
      尝试键: snapshot.attemptKey || '',
      账号ID: snapshot.accountId || '',
      页面地址: sanitizeExportUrl(snapshot.pageUrl || snapshot.sourceUrl || '', 'seller'),
      快照时间: snapshot.capturedAt || '',
      快照文件: relativeSnapshotReference(snapshot)
    })))
  }
  const workbook = XLSX.utils.book_new()
  const manifest = [
    ...appendChunkedSellerSheet(workbook, summary, '卖家汇总'),
    ...appendChunkedSellerSheet(workbook, itemDetails, '商品明细'),
    ...appendChunkedSellerSheet(workbook, history, '采集历史'),
    ...appendChunkedSellerSheet(workbook, snapshots, '网页快照')
  ]
  XLSX.writeFile(workbook, outputPath)
  const snapshotBundle = copySellerSnapshotBundle(snapshotFiles, outputPath)
  return { ok: true, outputPath, snapshotBundle, sellerCount: rows.length, itemCount: itemDetails.length, attemptCount: history.length, snapshotCount: snapshots.length, manifest }
}

export function getDataPaths() {
  return { sourcePath, progressPath, checkpointPath, itemsPath, snapshotDir, reconciliationPath, canonicalManifestPath, eventsDir, eventArchiveDir, leaseRoot, claimMutexPath }
}

function partitionAgeDays(fileName, nowMs) {
  const match = String(fileName).match(/seller-events-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.gz)?$/)
  if (!match) return null
  const partitionMs = Date.parse(`${match[1]}T00:00:00.000Z`)
  return Number.isFinite(partitionMs) ? Math.floor((nowMs - partitionMs) / (24 * 60 * 60 * 1000)) : null
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function loadVerifiedExportManifest(path) {
  if (!path || !existsSync(path)) return new Map()
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    const verified = new Map()
    for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
      if (!file?.sourceName || !file?.exportPath || !existsSync(file.exportPath)) continue
      if (fileSha256(file.exportPath) !== file.sha256) continue
      verified.set(file.sourceName, file.sha256)
    }
    return verified
  } catch {
    return new Map()
  }
}

export function exportEventHistory({ destinationDir, now = new Date() } = {}) {
  const destination = resolve(String(destinationDir || '').trim())
  if (!destinationDir) throw new TypeError('destinationDir is required for recoverable history export')
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  mkdirSync(eventArchiveDir, { recursive: true, mode: 0o700 })
  const files = []
  for (const sourceName of readdirSync(eventArchiveDir).filter((name) => name.endsWith('.jsonl.gz')).sort()) {
    const sourcePath = join(eventArchiveDir, sourceName)
    const exportPath = join(destination, sourceName)
    copyFileSync(sourcePath, exportPath)
    const sha256 = fileSha256(exportPath)
    files.push({ sourceName, exportPath, bytes: statSync(exportPath).size, sha256 })
  }
  const manifestPath = join(destination, 'seller-event-export-manifest.json')
  writeJsonAtomic(manifestPath, { schemaVersion: 1, generatedAt: new Date(now).toISOString(), files })
  return manifestPath
}

export function maintainEventHistory({
  now = new Date(),
  dryRun = true,
  archiveAfterDays = 7,
  retentionDays = 180,
  exportManifestPath = null
} = {}) {
  const nowMs = new Date(now).getTime()
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid date')
  if (Number(retentionDays) < 180) throw new TypeError('seller event retention must be at least 180 days')
  mkdirSync(eventsDir, { recursive: true, mode: 0o700 })
  mkdirSync(eventArchiveDir, { recursive: true, mode: 0o700 })
  const report = {
    dryRun: Boolean(dryRun),
    archive: [],
    archived: [],
    delete: [],
    deleted: [],
    blockedDelete: [],
    protected: [checkpointPath, itemsPath, canonicalManifestPath]
  }
  for (const fileName of readdirSync(eventsDir).filter((name) => name.endsWith('.jsonl')).sort()) {
    const ageDays = partitionAgeDays(fileName, nowMs)
    if (ageDays == null || ageDays < Number(archiveAfterDays)) continue
    const source = join(eventsDir, fileName)
    const target = join(eventArchiveDir, `${fileName}.gz`)
    report.archive.push({ source, target, ageDays })
    if (!dryRun) {
      writeBufferAtomic(target, gzipSync(readFileSync(source)))
      unlinkSync(source)
      report.archived.push(target)
    }
  }
  const verifiedExports = loadVerifiedExportManifest(exportManifestPath)
  for (const fileName of readdirSync(eventArchiveDir).filter((name) => name.endsWith('.jsonl.gz')).sort()) {
    const ageDays = partitionAgeDays(fileName, nowMs)
    if (ageDays == null || ageDays < Number(retentionDays)) continue
    const path = join(eventArchiveDir, fileName)
    const sha256 = fileSha256(path)
    if (verifiedExports.get(fileName) !== sha256) {
      report.blockedDelete.push({ path, ageDays, reason: 'RECOVERABLE_EXPORT_REQUIRED', sha256 })
      continue
    }
    report.delete.push({ path, ageDays, sha256 })
    if (!dryRun) {
      unlinkSync(path)
      report.deleted.push(path)
    }
  }
  return report
}

export function getRecoveryRun() {
  ensureLoaded()
  let job = meta.get('job') || {}
  // The scheduler calls this only during startup.  If the previous process
  // left the durable job flag running, reconcile that interrupted run before
  // exposing recovery state; ordinary queue reads remain read-only.
  if (job.running === true) {
    recoverInterruptedState()
    job = meta.get('job') || {}
  }
  // 风控结束时会留下专门的冷却恢复标记，但这不应阻塞其它仍可用账号
  // 恢复同一队列。startInternal() 仍会按 accountSafetyStates 排除冷却账号；
  // riskRecovery 只由 rearmWeekly() 在冷却到期后单独领取，绝不在这里绕过
  // 六小时安全窗口或重复导航被暂停的账号。
  return job.recoveryPending ? { ...job } : null
}

export function claimRecoveryRun() {
  const job = getRecoveryRun()
  // `recoveryClaimedAt` is only an in-process startup handoff marker. If the
  // previous process died after claiming it but before `start()` persisted a
  // live run, the durable job is already `running:false`; leave an old marker
  // recoverable so the next app launch cannot strand the entire queue. A short
  // grace window prevents the three startup rearm hooks from claiming the same
  // handoff concurrently and launching duplicate three-account runs.
  const claimedAt = Date.parse(job?.recoveryClaimedAt || '')
  const claimIsFresh = Number.isFinite(claimedAt) && Date.now() - claimedAt < 30_000
  if (!job || (job.recoveryClaimedAt && (job.running === true || claimIsFresh))) return null
  const claimed = { ...job, recoveryClaimedAt: new Date().toISOString() }
  meta.set('job', claimed)
  return claimed
}

/** Merge durable branch IDs globally, with active evidence winning overlaps. */
export function mergeSellerItemIds(previous = {}, incoming = {}) {
  const active = normalizeItemIdList([
    ...normalizeItemIdList(previous.active),
    ...normalizeItemIdList(incoming.active)
  ])
  const activeSet = new Set(active)
  const sold = normalizeItemIdList([
    ...normalizeItemIdList(previous.sold),
    ...normalizeItemIdList(incoming.sold)
  ])
    .filter((id) => !activeSet.has(id))
  return { active, sold }
}

export function getScheduleState() {
  return meta.get('scheduleState') || { cycleKey: null, lastCycleKey: null, outcome: null, lastOutcome: null, updatedAt: null }
}

export function recordScheduleOutcome(decision) {
  const next = {
    cycleKey: decision?.cycleKey || null,
    lastCycleKey: decision?.cycleKey || null,
    outcome: decision?.outcome || null,
    lastOutcome: decision?.outcome || null,
    scheduledAt: decision?.scheduledAt || null,
    ageMs: Number.isFinite(decision?.ageMs) ? decision.ageMs : null,
    shouldStart: Boolean(decision?.shouldStart),
    updatedAt: new Date().toISOString()
  }
  meta.set('scheduleState', next)
  return next
}

/**
 * Persist a schedule outcome before any browser work begins.  The claim is the
 * restart-safe idempotency boundary. An overlap does not consume the cycle:
 * after the active run finishes, the same cycle may still catch up within 24h.
 */
export function claimScheduleCycle(decision) {
  const cycleKey = String(decision?.cycleKey || '').trim()
  if (!cycleKey) throw new TypeError('schedule decision cycleKey must be non-empty')
  if (!['scheduled', 'catch_up', 'missed'].includes(String(decision?.outcome || ''))) {
    throw new TypeError(`schedule outcome cannot be claimed: ${decision?.outcome || 'unknown'}`)
  }
  const current = getScheduleState()
  if (current.cycleKey === cycleKey || current.lastCycleKey === cycleKey) {
    return { claimed: false, reason: 'duplicate', state: current }
  }
  return { claimed: true, state: recordScheduleOutcome(decision) }
}
