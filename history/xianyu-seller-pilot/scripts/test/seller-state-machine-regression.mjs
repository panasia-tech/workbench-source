import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SELLER_STATUSES,
  decideNextAttempt,
  evaluateSellerEvidence,
  validateAccountIdentities
} from '../../src/main/seller-state-machine.js'

const completeEvidence = {
  expected: { active: 2, sold: 1 },
  expectedTrusted: { active: true, sold: true },
  itemIds: { active: ['a-1', 'a-2'], sold: ['s-1'] }
}

const cases = [
  ['RPA-05 completes only from two trusted disjoint branches', completeEvidence, 'completed', 'COMPLETE_EVIDENCE'],
  ['RPA-06 zero active is a truthful availability class', {
    expected: { active: 0, sold: 1 },
    expectedTrusted: { active: true, sold: true },
    itemIds: { active: [], sold: ['s-1'] }
  }, 'no_active', 'NO_ACTIVE_COMPLETE'],
  ['RPA-06 unknown expectation needs review', {
    ...completeEvidence,
    expected: { active: null, sold: 1 },
    expectedTrusted: { active: false, sold: true }
  }, 'needs_review', 'EXPECTED_COUNT_UNKNOWN'],
  ['RPA-05 trusted short count is explicitly incomplete', {
    ...completeEvidence,
    expected: { active: 3, sold: 1 }
  }, 'incomplete', 'TRUSTED_COUNT_SHORT'],
  ['trusted count overflow is contradictory evidence', {
    ...completeEvidence,
    expected: { active: 1, sold: 1 }
  }, 'needs_review', 'TRUSTED_COUNT_EXCEEDED'],
  ['large seller policy accepts platform-inaccurate counts', {
    expected: { active: 2000, sold: 8000 },
    expectedTrusted: { active: true, sold: true },
    itemIds: { active: ['same'], sold: ['same'] },
    unknownItemIds: ['unknown-card'],
    platformBoundaryReached: true,
    capped: true
  }, 'completed', 'LARGE_SELLER_POLICY_ACCEPTED'],
  ['first page totals decide the threshold, not later noisy totals', {
    firstPageExpected: { active: 200, sold: 800 },
    expected: { active: 2000, sold: 8000 },
    expectedTrusted: { active: true, sold: true },
    itemIds: { active: ['active-1'], sold: ['sold-1'] }
  }, 'incomplete', 'TRUSTED_COUNT_SHORT'],
  ['partial first page totals cannot be inflated by a later branch', {
    firstPageExpected: { active: 593, sold: null },
    expected: { active: 593, sold: 8000 },
    expectedTrusted: { active: true, sold: true },
    itemIds: { active: ['active-1'], sold: ['sold-1'] }
  }, 'incomplete', 'TRUSTED_COUNT_SHORT'],
  ['exactly 1500 remains strict', {
    expected: { active: 1000, sold: 500 },
    expectedTrusted: { active: true, sold: true },
    itemIds: { active: ['active-1'], sold: ['sold-1'] }
  }, 'incomplete', 'TRUSTED_COUNT_SHORT'],
  ['RPA-05 explicit cap is incomplete', { ...completeEvidence, capped: true }, 'incomplete', 'EXPLICIT_CAP'],
  ['platform item cap is partial evidence, not a generic short-count retry', {
    ...completeEvidence,
    platformCapReached: true,
    expected: { active: 130, sold: 9360 },
    itemIds: { active: Array.from({ length: 130 }, (_, index) => `active-${index}`), sold: Array.from({ length: 945 }, (_, index) => `sold-${index}`) }
  }, 'completed', 'LARGE_SELLER_POLICY_ACCEPTED'],
  ['code-detected page boundary is partial without a fixed count', {
    ...completeEvidence,
    platformBoundaryReached: true,
    expected: { active: 13, sold: 9 },
    itemIds: { active: Array.from({ length: 8 }, (_, index) => `active-boundary-${index}`), sold: ['sold-boundary'] }
  }, 'incomplete', 'PLATFORM_BOUNDARY_REACHED'],
  ['RPA-05 explicit cap remains incomplete when an unvisited branch is unknown', {
    ...completeEvidence,
    capped: true,
    expected: { active: 1000, sold: null },
    expectedTrusted: { active: true, sold: false }
  }, 'incomplete', 'EXPLICIT_CAP'],
  ['RPA-05 safety limit is incomplete', { ...completeEvidence, safetyLimitReached: true }, 'incomplete', 'SAFETY_LIMIT_REACHED'],
  ['RPA-05 interrupted partial evidence is incomplete', { ...completeEvidence, interruptedPartial: true }, 'incomplete', 'INTERRUPTED_PARTIAL'],
  ['RPA-05 prior partial snapshot is incomplete', { ...completeEvidence, priorExpectedPartial: true }, 'incomplete', 'PRIOR_EXPECTED_PARTIAL'],
  ['RPA-06 DOM anomaly needs review', { ...completeEvidence, domAnomaly: true }, 'needs_review', 'DOM_ANOMALY'],
  ['unknown combined-list card status needs review', { ...completeEvidence, unknownItemIds: ['u-1'] }, 'needs_review', 'UNKNOWN_ITEM_STATUS'],
  ['RPA-06 overlap needs review', {
    ...completeEvidence,
    itemIds: { active: ['same'], sold: ['same'] }
  }, 'needs_review', 'BRANCH_ITEM_OVERLAP'],
  ['RPA-06 login evidence outranks complete-looking counts', { ...completeEvidence, loggedOut: true }, 'login_expired', 'LOGIN_EXPIRED'],
  ['RPA-06 risk evidence outranks complete-looking counts', { ...completeEvidence, riskControl: true }, 'risk_cooldown', 'RISK_CONTROL'],
  ['RPA-06 persistence failure cannot complete', { ...completeEvidence, persistenceFailed: true }, 'failed', 'PERSISTENCE_FAILED'],
  ['large seller policy cannot hide a crawl failure', {
    expected: { active: 2000, sold: 8000 },
    expectedTrusted: { active: true, sold: true },
    itemIds: { active: [], sold: [] },
    failed: true
  }, 'failed', 'CRAWL_FAILED'],
  ['security evidence outranks a requested running label', {
    ...completeEvidence,
    requestedStatus: 'running',
    loggedOut: true
  }, 'login_expired', 'LOGIN_EXPIRED']
]

assert.deepEqual([...SELLER_STATUSES], [
  'pending',
  'running',
  'completed',
  'no_active',
  'incomplete',
  'needs_review',
  'failed',
  'login_expired',
  'risk_cooldown'
])

assert.throws(() => validateAccountIdentities([
  { id: 'account-a', partition: 'persist:a', browserProvider: 'adspower', adsPowerId: 'profile-1' },
  { id: 'account-b', partition: 'persist:b', browserProvider: 'adspower', adsPowerId: 'profile-1' }
]), /duplicate AdsPower profile/)
assert.throws(() => validateAccountIdentities([
  { id: 'account-a', partition: 'persist:a', browserProvider: 'adspower' }
]), /requires an AdsPower profile/)

for (const [name, evidence, status, reasonCode] of cases) {
  const result = evaluateSellerEvidence(evidence)
  assert.equal(result.status, status, name)
  assert.equal(result.reasonCode, reasonCode, name)
  assert.equal(SELLER_STATUSES.includes(result.status), true, `${name}: result must be one locked state`)
}

assert.deepEqual(validateAccountIdentities([
  { id: 'account-a', partition: 'persist:xianyu-account-a', name: '同名账号' },
  { id: 'account-b', partition: 'persist:xianyu-account-b', name: '同名账号' }
]).map((account) => account.id), ['account-a', 'account-b'], 'display names are not identity')
assert.throws(() => validateAccountIdentities([{ id: '', partition: 'persist:x' }]), /account id/i)
assert.throws(() => validateAccountIdentities([
  { id: 'duplicate', partition: 'persist:xianyu-a' },
  { id: 'duplicate', partition: 'persist:xianyu-b' }
]), /duplicate account id/i)
assert.throws(() => validateAccountIdentities([
  { id: 'account-a', partition: 'persist:shared' },
  { id: 'account-b', partition: 'persist:shared' }
]), /duplicate partition/i)

assert.deepEqual(decideNextAttempt({
  status: 'failed',
  currentAttempt: { accountId: 'account-a', immediateRetryUsed: false, transientReason: 'RENDER_CRASH' }
}, []), { action: 'retry_same_account', accountId: 'account-a', immediateRetryUsed: true })
assert.equal(decideNextAttempt({
  status: 'failed',
  currentAttempt: { accountId: 'account-a', immediateRetryUsed: true, transientReason: 'RENDER_CRASH' }
}, [{ id: 'account-b' }]).action, 'stop', 'a transient gets only one immediate retry')
assert.equal(decideNextAttempt({ status: 'incomplete', attemptedAccountIds: ['account-a'] }, [
  { id: 'account-a' },
  { id: 'account-b' }
]).accountId, 'account-b', 'only an unused distinct account continues incomplete evidence')
for (const status of ['needs_review', 'login_expired', 'risk_cooldown']) {
  assert.equal(decideNextAttempt({ status, attemptedAccountIds: ['account-a'] }, [{ id: 'account-b' }]).action, 'stop')
}

const tempDataDir = mkdtempSync(join(tmpdir(), 'seller-state-spine-'))
try {
  process.env.XIANYU_SELLER_DATA_DIR = tempDataDir
  const sellerStore = await import(`../../src/main/seller-store.js?state-spine=${Date.now()}`)
  sellerStore.importLinks('https://www.goofish.com/personal?userId=test-seller', 'one-seller.txt')
  const run = sellerStore.prepareRun()
  const source = sellerStore.claimNext(run.runId, 'account-a', 1)
  assert.ok(source, 'one indexed seller can be claimed')
  assert.throws(() => sellerStore.markSource('not-indexed', { status: 'pending' }), /unknown seller source/)
  assert.throws(() => sellerStore.markSource(source.id, { status: 'done' }), /invalid seller status/)
  sellerStore.markSource(source.id, {
    status: 'completed',
    reasonCode: 'COMPLETE_EVIDENCE',
    expected: { active: 1, sold: 0 },
    itemIds: { active: ['item-a'], sold: [] },
    evidence: completeEvidence
  })
  const queried = sellerStore.getSources({ status: 'completed' })
  assert.equal(queried.total, 1, 'persisted seller can be queried without renderer state')
  const checkpointText = readFileSync(sellerStore.getDataPaths().checkpointPath, 'utf8')
  assert.match(checkpointText, /"schemaVersion": 3/)
  assert.doesNotMatch(checkpointText, /cookie|token/i, 'checkpoint never contains browser credentials')
  appendFileSync(sellerStore.getDataPaths().progressPath, JSON.stringify({
    id: source.id,
    schemaVersion: 3,
    status: 'pending',
    updatedAt: '2000-01-01T00:00:00.000Z'
  }) + '\n')
  const reloadedStore = await import(`../../src/main/seller-store.js?state-reload=${Date.now()}`)
  assert.equal(reloadedStore.getSources({ status: 'completed' }).total, 1, 'atomic checkpoint outranks stale append-only history after restart')

  const merged = sellerStore.mergeSellerItemIds(
    { active: ['same'], sold: ['sold-old'] },
    { active: ['active-new'], sold: ['same', 'sold-new'] }
  )
  assert.deepEqual(merged, { active: ['same', 'active-new'], sold: ['sold-old', 'sold-new'] }, 'active evidence wins global ID collisions')

  const legacy = sellerStore.migrateLegacySellerRecord({
    id: 'legacy-row',
    status: 'done',
    lastAccountId: 'legacy-account',
    skipItemIds: ['ambiguous-item']
  })
  assert.equal(legacy.status, 'needs_review')
  assert.deepEqual(legacy.attemptedAccountIds, ['legacy-account'])
  assert.deepEqual(legacy.legacyUnclassifiedItemIds, ['ambiguous-item'])

  sellerStore.importLinks('https://www.goofish.com/personal?userId=attempt-ledger', 'ledger-seller.txt')
  const ledgerRun = sellerStore.prepareRun()
  const firstAttempt = sellerStore.claimNext(ledgerRun.runId, 'account-a', 2, 'cycle-ledger')
  assert.equal(firstAttempt.currentAttempt.accountId, 'account-a')
  assert.equal(firstAttempt.currentAttempt.immediateRetryUsed, false)
  sellerStore.consumeImmediateRetry(firstAttempt.id, 'account-a', 'NAV_TRANSIENT')
  assert.throws(() => sellerStore.consumeImmediateRetry(firstAttempt.id, 'account-a', 'NAV_TRANSIENT'), /already consumed/i)
  sellerStore.finalizeFormalAttempt(firstAttempt.id, {
    accountId: 'account-a',
    cycleKey: 'cycle-ledger',
    status: 'incomplete',
    reasonCode: 'TRUSTED_COUNT_SHORT'
  })
  assert.equal(sellerStore.claimNext(ledgerRun.runId, 'account-a', 2, 'cycle-ledger'), null, 'same account cannot take a second formal attempt')
  const secondAttempt = sellerStore.claimNext(ledgerRun.runId, 'account-b', 2, 'cycle-ledger')
  assert.equal(secondAttempt.currentAttempt.accountId, 'account-b')
  sellerStore.finalizeFormalAttempt(secondAttempt.id, {
    accountId: 'account-b',
    cycleKey: 'cycle-ledger',
    status: 'needs_review',
    reasonCode: 'EXPECTED_COUNT_UNKNOWN'
  })
  const persistedLedger = sellerStore.getSources({ q: 'attempt-ledger' }).items[0]
  assert.deepEqual(persistedLedger.attemptedAccountIds.sort(), ['account-a', 'account-b'])
  assert.equal(persistedLedger.attempts.length, 2)

  // Full production recovery may explicitly revisit a needs_review row that
  // was captured before a crawl fix. The retry is bounded to the supplied
  // seller IDs and one claim per current run.
  sellerStore.importLinks('https://www.goofish.com/personal?userId=review-retry', 'review-retry.txt')
  const reviewSource = sellerStore.getAllSourceRows().find((row) => row.sellerId === 'review-retry')
  const reviewCycle = 'review-cycle'
  const priorReviewClaim = sellerStore.claimNext('prior-review-run', 'account-a', 1, reviewCycle)
  sellerStore.finalizeFormalAttempt(priorReviewClaim.id, {
    accountId: 'account-a',
    cycleKey: reviewCycle,
    status: 'needs_review',
    reasonCode: 'EXPECTED_COUNT_UNKNOWN'
  })
  const reviewClaim = sellerStore.claimNext('review-run', 'account-a', 1, reviewCycle, {
    allowedSellerIds: ['review-retry'],
    reviewSellerIds: ['review-retry']
  })
  assert.equal(reviewClaim.id, reviewSource.id, 'production recovery can explicitly retry a needs_review seller')
  assert.notEqual(reviewClaim.currentAttempt.attemptKey, priorReviewClaim.currentAttempt.attemptKey, 'review retry must have a distinct formal attempt key')
  sellerStore.finalizeFormalAttempt(reviewClaim.id, {
    accountId: 'account-a',
    cycleKey: reviewCycle,
    status: 'needs_review',
    reasonCode: 'EXPECTED_COUNT_UNKNOWN'
  })
  assert.equal(sellerStore.claimNext('review-run', 'account-a', 1, reviewCycle, {
    allowedSellerIds: ['review-retry'],
    reviewSellerIds: ['review-retry']
  }), null, 'needs_review retry is bounded to one attempt per run')

  for (const status of ['failed', 'needs_review', 'login_expired', 'risk_cooldown']) {
    const sellerId = `terminal-${status.replace('_', '-')}`
    sellerStore.importLinks(`https://www.goofish.com/personal?userId=${sellerId}`, `${status}.txt`)
    const row = sellerStore.getAllSourceRows().find((entry) => entry.sellerId === sellerId)
    sellerStore.markSource(row.id, { status, reasonCode: `TEST_${status.toUpperCase()}`, retryable: true })
    const terminalRun = sellerStore.prepareRun()
    const claimedByOtherAccount = sellerStore.claimNext(terminalRun.runId, 'account-b', 2, `cycle-${status}`, {
      allowedSellerIds: [sellerId]
    })
    assert.equal(claimedByOtherAccount, null, `${status} cannot be transferred to another account`)
  }
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  rmSync(tempDataDir, { recursive: true, force: true })
}

console.log(`seller state matrix passed (${cases.length} cases)`)
