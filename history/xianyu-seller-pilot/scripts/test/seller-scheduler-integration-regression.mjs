import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const businessIds = Array.from({ length: 20 }, (_, index) => `frozen-${String(index + 1).padStart(2, '0')}`)
const rows = businessIds.map((sellerId, index) => ({
  id: `internal-${index + 1}`,
  sellerId,
  sellerName: index === 0 ? '卖家甲' : '',
  url: `https://www.goofish.com/personal?userId=${sellerId}`,
  status: 'pending',
  itemIds: { active: [], sold: [] }
}))
const calls = []
const retries = new Map()
const finalized = []
const emitted = []
const branchCheckpoints = []
let reconciled = 0

const sellerStore = {
  reconcileCanonicalSellerManifest() { reconciled += 1; return { changed: false } },
  getAllSourceRows() { return rows.map((row) => ({ ...row })) },
  getAccountSafetyState() { return null },
  clearAccountSafetyState() {},
  getSettings() { return { throttleMinMs: 15000, throttleMaxMs: 30000, recycleEvery: 0 } },
  prepareRun({ cycleKey }) { return { runId: 'run-fast-20', cycleKey: cycleKey || 'cycle-fast-20' } },
  addEvent() {},
  finishRun() {},
  mergeSellerItemIds(previous = {}, incoming = {}) {
    return {
      active: [...new Set([...(previous.active || []), ...(incoming.active || [])])],
      sold: [...new Set([...(previous.sold || []), ...(incoming.sold || [])])]
    }
  },
  claimNext(_runId, accountId, _accountCount, cycleKey, options) {
    const allowed = new Set(options.allowedSellerIds)
    const row = rows.find((entry) => entry.status === 'pending' && allowed.has(entry.sellerId))
    if (!row) return null
    assert.equal(options.pendingOnly, true)
    row.status = 'running'
    row.currentAttempt = { accountId, cycleKey, immediateRetryUsed: false }
    return { ...row }
  },
  consumeImmediateRetry(id, _accountId, reasonCode) {
    assert.ok(['NAV_TRANSIENT', 'RENDER_CRASH'].includes(reasonCode))
    const count = retries.get(id) || 0
    if (count) throw new Error('immediate retry already consumed')
    retries.set(id, count + 1)
  },
  markSource(id, patch) { branchCheckpoints.push({ id, patch }) },
  appendItems() {},
  saveSellerSnapshot(_html, metadata = {}) {
    return { snapshotId: `snapshot-${metadata.sourceId || 'fixture'}`, snapshotHash: 'fixture-hash', path: '/fixture/snapshot.html', capturedAt: new Date().toISOString(), complete: true }
  },
  finalizeFormalAttempt(id, result) {
    const row = rows.find((entry) => entry.id === id)
    row.status = result.status
    finalized.push({ id, ...result })
  }
}

const attemptBySeller = new Map()
async function crawlSellerPage(_webContents, url, options) {
  const sellerId = new URL(url).searchParams.get('userId')
  const attempt = (attemptBySeller.get(sellerId) || 0) + 1
  attemptBySeller.set(sellerId, attempt)
  calls.push({ sellerId, attempt, options })
  if (sellerId === businessIds[0] && attempt === 1) return { ok: false, reasonCode: 'NAV_TIMEOUT', reason: 'localized text is irrelevant' }
  if (sellerId === businessIds[1]) return { ok: false, reasonCode: 'NAV_TRANSIENT', reason: 'localized text is irrelevant' }
  if (sellerId === businessIds[2] && attempt === 1) return { ok: false, reasonCode: 'RENDER_CRASH', reason: 'localized text is irrelevant' }
  if (sellerId === businessIds[3]) return { ok: false, needsReview: true, reasonCode: 'INVALID_SELLER_URL', reason: 'invalid boundary' }
  if (sellerId === businessIds[4]) {
    await options.onEvidence?.({
      branch: 'combined', expectedActiveCount: 1, expectedSoldCount: 1,
      itemIdsActive: ['combined-active'], itemIdsSold: ['combined-sold'], unknownItemIds: [],
      loadingKind: 'bottom', loadingBottom: true, collectedAt: '2026-08-24T00:00:00.000Z'
    })
  }
  return {
    ok: true,
    items: [],
    evidence: {
      expected: { active: 0, sold: 0 },
      expectedTrusted: { active: true, sold: true },
      itemIds: { active: [], sold: [] }
    }
  }
}

globalThis.__sellerSchedulerRegression = {
  crawlSellerPage,
  sellerStore,
  getAccounts: () => [{ id: 'account-a', name: '账号 A', enabled: true, partition: 'persist:account-a' }],
  getSellerWebContents: async () => ({}),
  recycleSellerWorker() {},
  evaluateSellerEvidence(evidence) {
    if (evidence.domAnomaly) return { status: 'needs_review', reasonCode: 'DOM_ANOMALY', counts: { active: 0, sold: 0 }, expected: evidence.expected || {} }
    if (evidence.failed || evidence.error) return { status: 'failed', reasonCode: 'CRAWL_FAILED', counts: { active: 0, sold: 0 }, expected: evidence.expected || {} }
    return { status: 'no_active', reasonCode: 'NO_ACTIVE_COMPLETE', counts: { active: 0, sold: 0 }, expected: evidence.expected || {} }
  },
  validateAccountIdentities: (accounts) => accounts,
  evaluateSchedule: () => ({ outcome: 'idle' }),
  SELLER_TIMEZONE: 'Asia/Shanghai'
}

const sourceText = readFileSync(new URL('../../src/main/seller-scheduler.js', import.meta.url), 'utf8')
assert.match(sourceText, /let starting = false/, 'scheduler must lock the async preflight before prepareRun')
assert.match(sourceText, /if \(running \|\| starting\)/, 'startup recovery and CLI/manual starts must not overlap')
const storeText = readFileSync(new URL('../../src/main/seller-store.js', import.meta.url), 'utf8')
assert.match(storeText, /if \(recoverRunning && \(previousJob\.running \|\| recoveredCount \|\| resumePreviousRun\)\)/, 'live claim refresh must not rewrite an active job to running:false')
const source = sourceText
  .replace("import { crawlSellerPage, resolveAuthoritativeSellerName } from './seller-goofish.js'", 'const { crawlSellerPage } = globalThis.__sellerSchedulerRegression; const resolveAuthoritativeSellerName = ({ sourceSellerName = "", pageSellerName = "" } = {}) => String(pageSellerName || sourceSellerName || "")')
  .replace("import * as sellerStore from './seller-store.js'", 'const { sellerStore } = globalThis.__sellerSchedulerRegression')
  .replace("import { getAccounts } from './store.js'", 'const { getAccounts } = globalThis.__sellerSchedulerRegression')
  .replace("import { getSellerWebContents, recycleSellerWorker } from './seller-worker.js'", 'const { getSellerWebContents, recycleSellerWorker } = globalThis.__sellerSchedulerRegression')
  .replace("import { evaluateSellerEvidence, validateAccountIdentities } from './seller-state-machine.js'", 'const { evaluateSellerEvidence, validateAccountIdentities } = globalThis.__sellerSchedulerRegression')
  .replace("import { evaluateSchedule, SELLER_TIMEZONE } from './seller-schedule.js'", 'const { evaluateSchedule, SELLER_TIMEZONE } = globalThis.__sellerSchedulerRegression')
  .replace('const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))', 'const sleep = async () => {}')
const scheduler = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}`)
scheduler.setEmitter((type, payload) => emitted.push({ type, payload }))

assert.equal(scheduler.immediateRetryReason({ ok: false, reasonCode: 'NAV_TIMEOUT' }), 'NAV_TRANSIENT')
assert.equal(scheduler.immediateRetryReason({ ok: false, reasonCode: 'NAV_TRANSIENT' }), 'NAV_TRANSIENT')
assert.equal(scheduler.immediateRetryReason({ ok: false, reasonCode: 'RENDER_CRASH' }), 'RENDER_CRASH')
assert.equal(scheduler.immediateRetryReason({ ok: false, reasonCode: 'NAV_TIMEOUT', loggedOut: true }), null)

const result = await scheduler.start({
  maxSellers: 20,
  trigger: 'test-fast-20',
  testFast: true,
  allowedSellerIds: businessIds
})
assert.equal(result.ok, true)
assert.equal(result.total, 20)
assert.equal(reconciled, 1)
assert.equal(finalized.length, 20, 'the fixed technical sample claims and finalizes exactly 20 sellers')
const checkpoint = branchCheckpoints.find((entry) => entry.id === 'internal-5')
assert.equal(checkpoint?.patch?.evidence?.branches?.combined?.loadingKind, 'bottom', 'combined checkpoint must persist loading kind')
assert.equal(checkpoint?.patch?.evidence?.branches?.combined?.loadingBottom, true, 'combined checkpoint must persist bottom-loading evidence')
assert.deepEqual(checkpoint?.patch?.evidence?.itemIds, { active: ['combined-active'], sold: ['combined-sold'] }, 'combined checkpoint must split active/sold IDs for restart')
assert.deepEqual(checkpoint?.patch?.evidence?.expected, { active: 1, sold: 1 }, 'combined checkpoint must split active/sold counts for restart')
const progressEvents = emitted.filter((event) => event.type === 'seller-progress')
assert.equal(progressEvents.length, 20)
assert.deepEqual(progressEvents.map((event) => event.payload.sellerId).sort(), [...businessIds].sort(), 'renderer progress exposes business seller IDs')
assert.equal(progressEvents.some((event) => /^internal-/.test(event.payload.sellerId)), false, 'internal source hashes never cross the renderer event boundary')
assert.equal(calls.every((call) => call.options.executionMode === 'test-fast'), true, 'scheduler propagates test-fast mode on initial and retry calls')
assert.equal(calls.filter((call) => call.sellerId === businessIds[0]).every((call) => call.options.sourceSellerName === '卖家甲'), true, 'scheduler carries the authoritative imported seller name into every attempt')
assert.equal(retries.get('internal-1'), 1, 'NAV_TIMEOUT consumes one immediate retry')
assert.equal(retries.get('internal-2'), 1, 'NAV_TRANSIENT consumes only one immediate retry even when the retry also fails')
assert.equal(retries.get('internal-3'), 1, 'RENDER_CRASH consumes one immediate retry')
assert.equal(attemptBySeller.get(businessIds[1]), 2, 'a second transient is finalized without a third navigation')
assert.equal(finalized.find((row) => row.id === 'internal-4')?.status, 'needs_review')
assert.equal(finalized.find((row) => row.id === 'internal-4')?.reasonCode, 'INVALID_SELLER_URL')

// A scheduler must refuse to claim work when the injected partition check
// says the account is a visitor session, even if the account is enabled.
const callsBeforeVisitorCheck = calls.length
scheduler.setAccountEligibilityChecker(async () => false)
const visitorResult = await scheduler.start({
  maxSellers: 20,
  trigger: 'test-fast-20',
  testFast: true,
  allowedSellerIds: businessIds
})
assert.equal(visitorResult.ok, false)
assert.match(visitorResult.reason, /账号|登录/)
assert.equal(calls.length, callsBeforeVisitorCheck, 'visitor account must not claim or navigate seller work')
scheduler.setAccountEligibilityChecker(async () => true)

delete globalThis.__sellerSchedulerRegression

// A second fixture measures the account-level integration contract rather
// than inferring it from source text: account A holds an incomplete seller
// while account B crawls a different seller, then B re-enters on the next
// bounded round and completes A's durable incomplete row.
const parallelRows = [
  { id: 'handoff-source', sellerId: 'handoff-seller', url: 'https://www.goofish.com/personal?userId=handoff-seller', status: 'pending', itemIds: { active: [], sold: [] }, attempts: [], attemptedAccountIds: [] },
  { id: 'parallel-source', sellerId: 'parallel-seller', url: 'https://www.goofish.com/personal?userId=parallel-seller', status: 'pending', itemIds: { active: [], sold: [] }, attempts: [], attemptedAccountIds: [] },
  { id: 'risk-source', sellerId: 'risk-seller', url: 'https://www.goofish.com/personal?userId=risk-seller', status: 'pending', itemIds: { active: [], sold: [] }, attempts: [], attemptedAccountIds: [] }
]
const parallelCalls = []
const parallelEvents = []
const parallelEmitted = []
const parallelSafetyClears = []
const parallelActive = new Map()
const parallelSafety = new Map()
const parallelState = { overlap: false, handoffRelease: null, finishRuns: 0, rejectAccount: null, leaveClaimedRunning: false }
const parallelAccounts = [
  { id: 'account-a', name: '账号 A', enabled: true, partition: 'persist:account-a' },
  { id: 'account-b', name: '账号 B', enabled: true, partition: 'persist:account-b' },
  { id: 'account-c', name: '账号 C', enabled: true, partition: 'persist:account-c' }
]

const cloneRow = (row) => JSON.parse(JSON.stringify(row))
const parallelStore = {
  reconcileCanonicalSellerManifest() { return { changed: false } },
  getAllSourceRows() { return parallelRows.map(cloneRow) },
  getAccountSafetyState(accountId) { return parallelSafety.get(accountId) || null },
  clearAccountSafetyState(accountId) {
    parallelSafetyClears.push(accountId)
    parallelSafety.delete(accountId)
  },
  setAccountCooling(accountId, { reasonCode = 'RISK_CONTROL' } = {}) {
    const next = { accountId, status: 'cooling', reasonCode, coolingUntil: new Date(Date.now() + 60_000).toISOString() }
    parallelSafety.set(accountId, next)
    return next
  },
  scheduleRiskRecovery() { return { reasonCode: 'RISK_CONTROL', retryAt: new Date(Date.now() + 60_000).toISOString(), scheduledAt: new Date().toISOString() } },
  getSettings() { return { throttleMinMs: 15000, throttleMaxMs: 30000, recycleEvery: 0 } },
  prepareRun({ cycleKey }) { return { runId: `parallel-run-${Date.now()}`, cycleKey: cycleKey || 'parallel-cycle' } },
  addEvent(event) { parallelEvents.push(event) },
  finishRun() { parallelState.finishRuns += 1 },
  mergeSellerItemIds(previous = {}, incoming = {}) {
    return {
      active: [...new Set([...(previous.active || []), ...(incoming.active || [])])],
      sold: [...new Set([...(previous.sold || []), ...(incoming.sold || [])])]
    }
  },
  claimNext(_runId, accountId, accountCount, cycleKey, options = {}) {
    assert.ok([2, 3].includes(accountCount), 'the fixture keeps three identities and excludes only the cooled account on later runs')
    if (parallelState.rejectAccount === accountId) throw new Error(`fixture rejection for ${accountId}`)
    const allowed = new Set(options.allowedSellerIds || parallelRows.map((row) => row.sellerId))
    const roundIncomplete = new Set(options.incompleteSellerIds || parallelRows.filter((row) => row.status === 'incomplete').map((row) => row.sellerId))
    const row = parallelRows.find((entry) => {
      if (!allowed.has(entry.sellerId) || entry.currentAttempt) return false
      const eligible = options.pendingOnly
        ? entry.status === 'pending'
        : entry.status === 'pending' || (entry.status === 'incomplete' && roundIncomplete.has(entry.sellerId))
      if (!eligible) return false
      return !(entry.attemptedAccountIds || []).includes(accountId)
    })
    if (!row) return null
    const attempt = { accountId, cycleKey, attemptKey: `${cycleKey}:${row.id}:${accountId}`, immediateRetryUsed: false }
    row.status = 'running'
    row.currentAttempt = attempt
    row.attempts.push(attempt)
    row.attemptedAccountIds = [...new Set([...(row.attemptedAccountIds || []), accountId])]
    return cloneRow(row)
  },
  consumeImmediateRetry() {},
  markSource(id, patch) {
    const row = parallelRows.find((entry) => entry.id === id)
    Object.assign(row, cloneRow(patch))
    return cloneRow(row)
  },
  appendItems() {},
  saveSellerSnapshot(_html, metadata = {}) {
    return { snapshotId: `snapshot-${metadata.sourceId || 'fixture'}`, snapshotHash: 'fixture-hash', path: '/fixture/snapshot.html', capturedAt: new Date().toISOString(), complete: true }
  },
  finalizeFormalAttempt(id, result) {
    const row = parallelRows.find((entry) => entry.id === id)
    if (parallelState.leaveClaimedRunning) throw new Error('fixture leaves current attempt recoverable')
    const current = row.currentAttempt
    assert.ok(current, 'finalization must have a matching current attempt')
    Object.assign(current, { endedAt: new Date().toISOString(), outcome: result.status, reasonCode: result.reasonCode })
    row.status = result.status
    row.currentAttempt = null
  }
}

async function parallelCrawl(webContents, url) {
  const sellerId = new URL(url).searchParams.get('userId')
  const accountId = webContents.accountId
  const active = (parallelActive.get(accountId) || 0) + 1
  parallelActive.set(accountId, active)
  assert.equal(active, 1, `account ${accountId} keeps one serial crawl chain`)
  parallelCalls.push({ sellerId, accountId })
  try {
    if (sellerId === 'handoff-seller' && accountId === 'account-a') {
      await new Promise((resolve) => { parallelState.handoffRelease = resolve })
      return { ok: true, items: [], evidence: { forceStatus: 'incomplete', expected: { active: 1, sold: 0 }, expectedTrusted: { active: true, sold: true }, itemIds: { active: [], sold: [] } } }
    }
    if (sellerId === 'parallel-seller' && accountId === 'account-b') {
      parallelState.overlap = true
      parallelState.handoffRelease?.()
    }
    if (sellerId === 'risk-seller' && accountId === 'account-c') {
      return {
        ok: false,
        riskControl: true,
        reasonCode: 'RISK_CONTROL',
        reason: 'fixture account C confirmed risk control',
        riskEvidence: {
          signal: '请求频繁',
          source: 'visible-challenge-component',
          url: 'https://www.goofish.com/personal?userId=risk-seller',
          confirmationCount: 2
        }
      }
    }
    return { ok: true, items: [], evidence: { expected: { active: 0, sold: 0 }, expectedTrusted: { active: true, sold: true }, itemIds: { active: [], sold: [] } } }
  } finally {
    parallelActive.set(accountId, active - 1)
  }
}

globalThis.__sellerSchedulerRegression = {
  crawlSellerPage: parallelCrawl,
  sellerStore: parallelStore,
  getAccounts: () => parallelAccounts,
  getSellerWebContents: async (account) => ({ accountId: account.id }),
  recycleSellerWorker() {},
  evaluateSellerEvidence(evidence) {
    if (evidence.forceStatus === 'incomplete') return { status: 'incomplete', reasonCode: 'TRUSTED_COUNT_SHORT', counts: { active: 0, sold: 0 }, expected: evidence.expected || {} }
    return { status: 'completed', reasonCode: 'COMPLETE_EVIDENCE', counts: { active: 0, sold: 0 }, expected: evidence.expected || {} }
  },
  validateAccountIdentities: (accounts) => accounts,
  evaluateSchedule: () => ({ outcome: 'idle' }),
  SELLER_TIMEZONE: 'Asia/Shanghai'
}
const parallelScheduler = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#parallel-${Date.now()}`)
parallelScheduler.setEmitter((type, payload) => parallelEmitted.push({ type, payload }))
parallelSafety.set('account-c', {
  accountId: 'account-c',
  status: 'cooling',
  reasonCode: 'RISK_CONTROL',
  coolingUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
})
const parallelResult = await parallelScheduler.start({ trigger: 'manual', cycleKey: 'parallel-cycle' })
assert.equal(parallelResult.ok, true)
assert.deepEqual(parallelSafetyClears, ['account-c'], 'manual start revalidates a stale page-level RISK_CONTROL marker')
assert.equal(parallelState.overlap, true, 'different accounts have measured in-flight overlap')
assert.equal(parallelActive.size, 3)
assert.equal(new Set(parallelCalls.map((call) => call.accountId)).size, 3, 'all three eligible accounts receive real crawl calls')
assert.equal(parallelCalls.filter((call) => call.accountId === 'account-c').length, 1, 'risk-controlled account does not claim a second seller')
assert.equal(parallelResult.formalAttempts, 4, 'A incomplete plus B completion is two formal attempts, plus the parallel seller and C risk attempt')
assert.equal(parallelResult.sellersDone, 2, 'unique final seller outcomes do not double-count the incomplete handoff')
assert.equal(parallelResult.sellersFail, 1, 'risk-controlled seller remains a non-success terminal outcome')
assert.equal(parallelResult.byStatus.completed, 2)
assert.equal(parallelResult.byStatus.risk_cooldown, 1)
assert.equal(parallelResult.accountStats['account-a'].claimed, 1)
assert.equal(parallelResult.accountStats['account-b'].claimed, 2)
assert.equal(parallelResult.accountStats['account-c'].claimed, 1)
assert.equal(parallelResult.accountStats['account-c'].finished, 1)
assert.equal(parallelResult.accountStats['account-c'].completed, 0)
assert.equal(parallelResult.accountStats['account-c'].byStatus.risk_cooldown, 1)
const persistedRiskEvent = parallelEvents.find((event) => event.type === 'seller-risk-control' && event.accountId === 'account-c')
assert.equal(persistedRiskEvent?.riskSignal, '请求频繁', 'durable risk event keeps the confirmed signal')
assert.equal(persistedRiskEvent?.riskSource, 'visible-challenge-component', 'durable risk event keeps the evidence source')
assert.equal(persistedRiskEvent?.confirmationCount, 2, 'durable risk event keeps the confirmation count')
const emittedRiskEvent = parallelEmitted.find((event) => event.type === 'seller-risk-control' && event.payload.accountId === 'account-c')
assert.equal(emittedRiskEvent?.payload?.riskSignal, '请求频繁', 'renderer risk event keeps the confirmed signal')
assert.equal(emittedRiskEvent?.payload?.confirmationCount, 2, 'renderer risk event keeps the confirmation count')
assert.deepEqual(parallelRows.find((row) => row.id === 'handoff-source').attemptedAccountIds.sort(), ['account-a', 'account-b'])
assert.deepEqual(parallelRows.find((row) => row.id === 'handoff-source').attempts.map((attempt) => attempt.accountId), ['account-a', 'account-b'])
assert.deepEqual(parallelResult.formalAttemptHistory.filter((attempt) => attempt.sellerId === 'handoff-seller').map((attempt) => attempt.status), ['incomplete', 'completed'])
assert.equal(parallelState.finishRuns, 1, 'a successful fan-out settles through one finishRun')

// A worker rejection must stop new claims, settle the sibling worker, and
// preserve the claimed row as running so normal startup recovery can resume it.
const rejectionRow = { id: 'rejection-source', sellerId: 'rejection-seller', url: 'https://www.goofish.com/personal?userId=rejection-seller', status: 'pending', itemIds: { active: [], sold: [] }, attempts: [], attemptedAccountIds: [] }
const postRejectionRows = Array.from({ length: 3 }, (_, index) => ({
  id: `post-rejection-${index + 1}`,
  sellerId: `post-rejection-${index + 1}`,
  url: `https://www.goofish.com/personal?userId=post-rejection-${index + 1}`,
  status: 'pending',
  itemIds: { active: [], sold: [] },
  attempts: [],
  attemptedAccountIds: []
}))
parallelRows.push(rejectionRow)
parallelRows.push(...postRejectionRows)
const claimCountBeforeRejection = parallelCalls.length
parallelState.rejectAccount = 'account-b'
parallelState.leaveClaimedRunning = true
const rejected = await parallelScheduler.start({ trigger: 'scheduled', cycleKey: 'rejection-cycle' })
assert.equal(rejected.ok, false, 'unexpected account worker rejection fails the run')
assert.equal(parallelState.finishRuns, 2, 'rejection settlement calls finishRun exactly once')
assert.equal(rejectionRow.status, 'running', 'claimed but unfinalized work stays recoverable')
assert.ok(rejectionRow.currentAttempt)
assert.equal(parallelCalls.length, claimCountBeforeRejection + 1, 'a worker rejection stops sibling claims immediately')
assert.equal(postRejectionRows.every((row) => row.status === 'pending'), true, 'sibling workers do not drain new rows after rejection')

delete globalThis.__sellerSchedulerRegression
console.log('seller scheduler integration regression: passed (fixed 20, account overlap, bounded incomplete handoff, unique counters, rejection recovery)')
