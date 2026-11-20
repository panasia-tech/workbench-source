import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'seller-risk-recovery-'))
try {
  process.env.XIANYU_SELLER_DATA_DIR = dataDir
  writeFileSync(join(dataDir, 'xianyu-seller-crawl.json'), JSON.stringify({
    accountSafetyStates: {
      'legacy-account': {
        status: 'cooling',
        reasonCode: 'PUBLIC_HOME_FALLBACK',
        coolingUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        lastEvidenceAt: new Date().toISOString()
      },
      'real-risk-account': {
        status: 'cooling',
        reasonCode: 'HTTP_429',
        coolingUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        lastEvidenceAt: new Date().toISOString()
      }
    },
    safetyPolicyVersion: 1
  }))
  const store = await import(`../../src/main/seller-store.js?risk-recovery=${Date.now()}`)
  assert.equal(store.getAccountSafetyState('legacy-account'), null, 'stale public-home fallback from the pre-isolation policy is revalidated after upgrade')
  assert.equal(store.getAccountSafetyState('real-risk-account')?.reasonCode, 'HTTP_429', 'real 429 safety state survives the navigation-policy migration')
  assert.equal(store.getSettings().maxItemsPerSeller, 0, '卖家主页默认由页面证据自适应收口，不使用固定数量围栏')
  store.importLinks([
    'https://www.goofish.com/personal?userId=risk-source',
    'https://www.goofish.com/personal?userId=other-source'
  ].join('\n'), 'risk-recovery.txt')

  const run = store.prepareRun({ cycleKey: 'cycle-risk', trigger: 'manual' })
  const row = store.claimNext(run.runId, 'account-a', 1, 'cycle-risk')
  assert.ok(row)
  store.finalizeFormalAttempt(row.id, {
    accountId: 'account-a',
    cycleKey: 'cycle-risk',
    status: 'risk_cooldown',
    reasonCode: 'HTTP_429',
    lastAccountId: 'account-a'
  })
  const cooling = store.setAccountCooling('account-a', { reasonCode: 'HTTP_429' })
  const recovery = store.scheduleRiskRecovery({
    accountId: 'account-a',
    coolingUntil: cooling.coolingUntil,
    reasonCode: cooling.reasonCode,
    sellerId: 'risk-source',
    runId: run.runId,
    cycleKey: run.cycleKey
  })
  assert.equal(store.getRiskRecovery().accountId, 'account-a')
  const ordinaryRecovery = store.getRecoveryRun()
  assert.equal(ordinaryRecovery?.recoveryPending, true, 'ordinary startup recovery must continue for non-cooled accounts')
  assert.equal(store.getStatus().job.riskRecoveryPending, true, 'ordinary recovery must preserve the cooled-account marker')
  assert.ok(store.claimRecoveryRun(), 'ordinary recovery can claim the non-cooled queue')
  const claimedJobPath = join(dataDir, 'xianyu-seller-crawl.json')
  const claimedJob = JSON.parse(readFileSync(claimedJobPath, 'utf8'))
  writeFileSync(claimedJobPath, JSON.stringify({ ...claimedJob, job: { ...claimedJob.job, recoveryClaimedAt: new Date(Date.now() - 31_000).toISOString() } }))
  const reloadedAfterCrash = await import(`../../src/main/seller-store.js?risk-recovery-crash=${Date.now()}`)
  assert.ok(reloadedAfterCrash.claimRecoveryRun(), 'an old recovery claim is reclaimable after a process dies before start')

  const claimedRecovery = store.claimRiskRecovery()
  assert.equal(claimedRecovery.accountId, 'account-a')
  assert.equal(store.getRiskRecovery(), null)
  const released = store.releaseRiskCooldown('account-a')
  assert.equal(released.released, 1)
  const releasedRow = store.getAllSourceRows().find((entry) => entry.sellerId === 'risk-source')
  assert.equal(releasedRow.status, 'pending')
  assert.equal(releasedRow.reasonCode, 'RISK_COOLDOWN_EXPIRED')
  assert.equal(releasedRow.attempts.length, 1, 'the risk attempt remains auditable')

  const retryRun = store.prepareRun({ cycleKey: 'seller-risk-recovery:retry' })
  const retry = store.claimNext(retryRun.runId, 'account-a', 1, 'seller-risk-recovery:retry')
  assert.equal(retry.sellerId, 'risk-source', 'released risk rows can be claimed in a new cycle')
  assert.equal(retry.currentAttempt.cycleKey, 'seller-risk-recovery:retry')

  // A failed eligibility check can put the marker back without losing the
  // original account, seller, and cycle evidence.
  store.finalizeFormalAttempt(retry.id, {
    accountId: 'account-a',
    cycleKey: 'seller-risk-recovery:retry',
    status: 'risk_cooldown',
    reasonCode: 'HTTP_429',
    lastAccountId: 'account-a'
  })
  const restored = store.restoreRiskRecovery({ ...recovery, coolingUntil: new Date(Date.now() + 60_000).toISOString() }, {
    retryAt: new Date(Date.now() + 60_000).toISOString(),
    reason: '账号仍需人工登录'
  })
  assert.equal(restored.accountId, 'account-a')
  assert.equal(store.getStatus().job.riskRecoveryPending, true)
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
}

console.log('seller risk recovery regression: passed (durable cooldown marker, safe release, new-cycle retry)')
