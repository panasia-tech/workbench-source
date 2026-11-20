/**
 * Seller business state is derived exclusively from durable crawl evidence.
 * Renderer labels and crawler `ok` flags are deliberately not accepted here.
 */
export const SELLER_STATUSES = Object.freeze([
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

export const SELLER_REASON_CODES = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETE_EVIDENCE: 'COMPLETE_EVIDENCE',
  NO_ACTIVE_COMPLETE: 'NO_ACTIVE_COMPLETE',
  EXPECTED_COUNT_UNKNOWN: 'EXPECTED_COUNT_UNKNOWN',
  EXPECTED_COUNT_UNTRUSTED: 'EXPECTED_COUNT_UNTRUSTED',
  TRUSTED_COUNT_SHORT: 'TRUSTED_COUNT_SHORT',
  TRUSTED_COUNT_EXCEEDED: 'TRUSTED_COUNT_EXCEEDED',
  EXPLICIT_CAP: 'EXPLICIT_CAP',
  PLATFORM_BOUNDARY_REACHED: 'PLATFORM_BOUNDARY_REACHED',
  // Legacy persisted reason; new runs use PLATFORM_BOUNDARY_REACHED.
  PLATFORM_CAP_REACHED: 'PLATFORM_CAP_REACHED',
  UNKNOWN_ITEM_STATUS: 'UNKNOWN_ITEM_STATUS',
  SAFETY_LIMIT_REACHED: 'SAFETY_LIMIT_REACHED',
  INTERRUPTED_PARTIAL: 'INTERRUPTED_PARTIAL',
  PRIOR_EXPECTED_PARTIAL: 'PRIOR_EXPECTED_PARTIAL',
  DOM_ANOMALY: 'DOM_ANOMALY',
  BRANCH_ITEM_OVERLAP: 'BRANCH_ITEM_OVERLAP',
  LOGIN_EXPIRED: 'LOGIN_EXPIRED',
  RISK_CONTROL: 'RISK_CONTROL',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',
  CRAWL_FAILED: 'CRAWL_FAILED',
  // For a seller whose displayed total is above this platform-policy
  // threshold, the tab counts are known to be unreliable. The operator's
  // business rule is to accept the crawl as complete after auth, crawl and
  // persistence failures have been ruled out.
  LARGE_SELLER_POLICY_ACCEPTED: 'LARGE_SELLER_POLICY_ACCEPTED'
})

export const LARGE_SELLER_TOTAL_THRESHOLD = 1500

const idsOf = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((id) => String(id || '').trim())
  .filter(Boolean))]

const knownCount = (value) => value !== null && value !== undefined && value !== '' && Number.isInteger(Number(value)) && Number(value) >= 0

function expectedCountsOf(evidence = {}) {
  const firstPage = evidence.firstPageExpected || {}
  const expected = evidence.expected || {}
  return {
    active: knownCount(firstPage.active) ? Number(firstPage.active) : (knownCount(expected.active) ? Number(expected.active) : null),
    sold: knownCount(firstPage.sold) ? Number(firstPage.sold) : (knownCount(expected.sold) ? Number(expected.sold) : null)
  }
}

function isLargeSellerEvidence(evidence = {}) {
  const firstPage = evidence.firstPageExpected || {}
  const firstPageHasAnyCount = knownCount(firstPage.active) || knownCount(firstPage.sold)
  // Once the first page exposes either tab, the threshold decision is locked
  // to that first-page observation. Do not combine a later branch total with
  // one first-page total and accidentally turn a small seller into a large
  // seller after the page re-renders.
  const { active, sold } = firstPageHasAnyCount
    ? {
        active: knownCount(firstPage.active) ? Number(firstPage.active) : null,
        sold: knownCount(firstPage.sold) ? Number(firstPage.sold) : null
      }
    : expectedCountsOf(evidence)
  // If either branch alone is already over the threshold, the total is
  // certainly over it. Otherwise require both branches to calculate the
  // total; a single small known branch must not be treated as large.
  return (active !== null && active > LARGE_SELLER_TOTAL_THRESHOLD) ||
    (sold !== null && sold > LARGE_SELLER_TOTAL_THRESHOLD) ||
    (active !== null && sold !== null && active + sold > LARGE_SELLER_TOTAL_THRESHOLD)
}

function result(status, reasonCode, evidence, extra = {}) {
  const expected = expectedCountsOf(evidence)
  return Object.freeze({
    status,
    reasonCode,
    availabilityClass: status === 'no_active' ? 'no_active' : null,
    expected: {
      active: expected.active,
      sold: expected.sold
    },
    counts: extra.counts || { active: 0, sold: 0 },
    overlapIds: extra.overlapIds || []
  })
}

/**
 * Convert untrusted page evidence into exactly one current seller status.
 * Priority is security/persistence, then contradictory evidence, then explicit
 * incompleteness, and only finally completion.
 */
export function evaluateSellerEvidence(evidence = {}) {
  const activeIds = idsOf(evidence.itemIds?.active)
  const soldIds = idsOf(evidence.itemIds?.sold)
  const unknownIds = idsOf(evidence.unknownItemIds)
  const activeSet = new Set(activeIds)
  const overlapIds = soldIds.filter((id) => activeSet.has(id))
  const counts = { active: activeIds.length, sold: soldIds.length }
  const extras = { counts, overlapIds }
  const expected = expectedCountsOf(evidence)

  // Security and durability evidence must never be hidden by a renderer's
  // requested transitional label.
  if (evidence.loggedOut || evidence.loginExpired) return result('login_expired', SELLER_REASON_CODES.LOGIN_EXPIRED, evidence, extras)
  if (evidence.riskControl || evidence.verificationRequired) return result('risk_cooldown', SELLER_REASON_CODES.RISK_CONTROL, evidence, extras)
  if (evidence.persistenceFailed) return result('failed', SELLER_REASON_CODES.PERSISTENCE_FAILED, evidence, extras)
  if (evidence.requestedStatus === 'pending') return result('pending', SELLER_REASON_CODES.PENDING, evidence, extras)
  if (evidence.requestedStatus === 'running') return result('running', SELLER_REASON_CODES.RUNNING, evidence, extras)
  if (evidence.domAnomaly) return result('needs_review', SELLER_REASON_CODES.DOM_ANOMALY, evidence, extras)
  if (evidence.failed || evidence.error) return result('failed', SELLER_REASON_CODES.CRAWL_FAILED, evidence, extras)
  // Large sellers are the explicit exception to exact item/count proof. The
  // platform may expose misleading tab totals or stop rendering the full
  // list. Once the page was reachable and the result can be persisted, the
  // business rule accepts the seller as completed rather than retrying it as
  // an endless review/partial item.
  if (isLargeSellerEvidence(evidence)) {
    return result('completed', SELLER_REASON_CODES.LARGE_SELLER_POLICY_ACCEPTED, evidence, extras)
  }
  if (unknownIds.length) return result('needs_review', SELLER_REASON_CODES.UNKNOWN_ITEM_STATUS, evidence, extras)
  if (overlapIds.length || evidence.overlap) return result('needs_review', SELLER_REASON_CODES.BRANCH_ITEM_OVERLAP, evidence, extras)
  // A code-detected bottom/loading boundary is not a network failure. Keep it
  // incomplete and auditable, but never infer it from a fixed item count.
  if (evidence.platformBoundaryReached) return result('incomplete', SELLER_REASON_CODES.PLATFORM_BOUNDARY_REACHED, evidence, extras)
  if (evidence.platformCapReached) return result('incomplete', SELLER_REASON_CODES.PLATFORM_CAP_REACHED, evidence, extras)
  if (evidence.capped) return result('incomplete', SELLER_REASON_CODES.EXPLICIT_CAP, evidence, extras)
  if (evidence.safetyLimitReached) return result('incomplete', SELLER_REASON_CODES.SAFETY_LIMIT_REACHED, evidence, extras)
  if (evidence.interruptedPartial) return result('incomplete', SELLER_REASON_CODES.INTERRUPTED_PARTIAL, evidence, extras)
  if (evidence.priorExpectedPartial) return result('incomplete', SELLER_REASON_CODES.PRIOR_EXPECTED_PARTIAL, evidence, extras)

  const activeKnown = knownCount(expected.active)
  const soldKnown = knownCount(expected.sold)
  if (!activeKnown || !soldKnown) return result('needs_review', SELLER_REASON_CODES.EXPECTED_COUNT_UNKNOWN, evidence, extras)
  if (evidence.expectedTrusted?.active !== true || evidence.expectedTrusted?.sold !== true) {
    return result('needs_review', SELLER_REASON_CODES.EXPECTED_COUNT_UNTRUSTED, evidence, extras)
  }

  if (counts.active < Number(expected.active) || counts.sold < Number(expected.sold)) {
    return result('incomplete', SELLER_REASON_CODES.TRUSTED_COUNT_SHORT, evidence, extras)
  }
  if (counts.active > Number(expected.active) || counts.sold > Number(expected.sold)) {
    return result('needs_review', SELLER_REASON_CODES.TRUSTED_COUNT_EXCEEDED, evidence, extras)
  }
  return Number(expected.active) === 0
    ? result('no_active', SELLER_REASON_CODES.NO_ACTIVE_COMPLETE, evidence, extras)
    : result('completed', SELLER_REASON_CODES.COMPLETE_EVIDENCE, evidence, extras)
}

const TRANSIENT_REASONS = new Set(['RENDER_CRASH', 'NAV_TRANSIENT'])

/**
 * Account display names are presentation only. A runnable account must have a
 * unique durable ID and a one-to-one persistent Chromium partition.
 */
export function validateAccountIdentities(accounts = []) {
  const ids = new Set()
  const partitions = new Set()
  const adsPowerProfiles = new Set()
  return accounts.map((account) => {
    const id = String(account?.id || '').trim()
    const partition = String(account?.partition || '').trim()
    if (!id) throw new TypeError('account id must be non-empty')
    if (ids.has(id)) throw new TypeError(`duplicate account id: ${id}`)
    if (!partition || !partition.startsWith('persist:')) throw new TypeError(`account ${id} must map to a persistent partition`)
    if (partitions.has(partition)) throw new TypeError(`duplicate partition: ${partition}`)
    const provider = String(account?.browserProvider || '').trim().toLowerCase()
    const profileId = String(account?.adsPowerId || account?.browserProfileId || '').trim()
    if (provider === 'adspower' && !profileId) throw new TypeError(`account ${id} requires an AdsPower profile`)
    if (profileId) {
      if (adsPowerProfiles.has(profileId)) throw new TypeError(`duplicate AdsPower profile: ${profileId}`)
      adsPowerProfiles.add(profileId)
    }
    ids.add(id)
    partitions.add(partition)
    return { ...account, id, partition }
  })
}

/** Decide whether a formal attempt may retry or move to another account. */
export function decideNextAttempt(state = {}, accounts = []) {
  const attempted = new Set((state.attemptedAccountIds || []).map(String))
  const currentAccountId = String(state.currentAttempt?.accountId || state.accountId || '')
  const transientReason = String(state.transientReason || state.currentAttempt?.transientReason || '')
  const immediateRetryUsed = Boolean(state.currentAttempt?.immediateRetryUsed ?? state.immediateRetryUsed)

  if (TRANSIENT_REASONS.has(transientReason) && currentAccountId && !immediateRetryUsed) {
    return { action: 'retry_same_account', accountId: currentAccountId, immediateRetryUsed: true }
  }
  if (state.status !== 'incomplete') return { action: 'stop', reasonCode: `TERMINAL_${String(state.status || 'unknown').toUpperCase()}` }

  const next = accounts.find((account) => {
    const id = String(account?.id || '').trim()
    return id && !attempted.has(id) && id !== currentAccountId && account.enabled !== false
  })
  return next
    ? { action: 'continue_other_account', accountId: String(next.id) }
    : { action: 'stop', reasonCode: 'NO_UNUSED_ACCOUNT' }
}
