import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDataDir = mkdtempSync(join(tmpdir(), 'seller-recovery-'))
const exportDir = mkdtempSync(join(tmpdir(), 'seller-recovery-export-'))

try {
  process.env.XIANYU_SELLER_DATA_DIR = tempDataDir
  let sellerStore = await import(`../../src/main/seller-store.js?recovery-seed=${Date.now()}`)
  sellerStore.importLinks([
    'https://www.goofish.com/personal?userId=recover-active',
    'https://www.goofish.com/personal?userId=corrupt-line',
    'https://www.goofish.com/personal?userId=scoped-pending'
  ].join('\n'), 'recovery-fixture.txt')
  // A process can disappear after a seller is finalized but before the next
  // claim. There is no orphan `running` row in that case; the persisted job
  // flag is the only evidence that the queue must resume on startup.
  const startupRun = sellerStore.prepareRun({ cycleKey: 'cycle-startup-resume' })
  assert.equal(sellerStore.getStatus().job.running, true)
  sellerStore = await import(`../../src/main/seller-store.js?startup-resume=${Date.now()}`)
  const startupRecovery = sellerStore.getRecoveryRun()
  assert.equal(startupRecovery?.recoveryPending, true, 'a crashed running job with pending sellers is resumable')
  assert.equal(startupRecovery?.resumePendingWork, true, 'startup recovery records why no orphan row was needed')
  const run = sellerStore.prepareRun()
  const claimed = sellerStore.claimNext(run.runId, 'account-a', 1, 'cycle-recovery')
  sellerStore.markSource(claimed.id, {
    status: 'running',
    reason: 'sold branch interrupted',
    reasonCode: 'BRANCH_CHECKPOINT',
    expected: { active: 2, sold: 3 },
    itemIds: { active: ['active-1', 'active-2'], sold: ['sold-1'] },
    evidence: { branches: { active: { complete: true }, sold: { complete: false } } }
  })
  const paths = sellerStore.getDataPaths()
  writeFileSync(`${paths.checkpointPath}.tmp-crash`, '{partial', 'utf8')

  sellerStore = await import(`../../src/main/seller-store.js?recovery-reload=${Date.now()}`)
  const observedBeforeRecovery = sellerStore.getAllSourceRows().find((row) => row.id === claimed.id)
  assert.equal(observedBeforeRecovery.status, 'running', 'diagnostic reads preserve an unexpired orphan row')
  const orphanLeasePath = observedBeforeRecovery.currentAttempt?.lease?.lockPath
  if (orphanLeasePath) {
    const ownerPath = join(orphanLeasePath, 'owner.json')
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
    writeFileSync(ownerPath, JSON.stringify({ ...owner, expiresAt: new Date(Date.now() - 1000).toISOString() }))
  }
  // Status reads are intentionally read-only; explicit run preparation owns
  // orphan recovery after the lease/diagnostic split in Plan 02.
  sellerStore.prepareRun({ cycleKey: 'cycle-recovery-reload' })
  const recovered = sellerStore.getAllSourceRows().find((row) => row.id === claimed.id)
  assert.equal(recovered.status, 'pending', 'orphan running work is recoverable pending')
  assert.equal(recovered.reasonCode, 'RECOVERED_INTERRUPTED')
  assert.equal(recovered.reason, 'sold branch interrupted')
  assert.deepEqual(recovered.expected, { active: 2, sold: 3 })
  assert.deepEqual(recovered.itemIds, { active: ['active-1', 'active-2'], sold: ['sold-1'] })
  assert.deepEqual(recovered.attemptedAccountIds, ['account-a'])
  assert.equal(recovered.currentAttempt.accountId, 'account-a', 'interrupted formal attempt is preserved for same-account resume')
  sellerStore.appendItems([{ itemId: 'sold-2', status: 'sold', title: 'checkpointed item' }], { runId: run.runId, source: recovered })
  sellerStore.appendItems([{ itemId: 'sold-2', status: 'sold', title: 'same observation retried' }], { runId: run.runId, source: recovered })
  const observations = readFileSync(sellerStore.getDataPaths().itemsPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(observations[0].observationId, observations[1].observationId, 'retrying the same durable observation has a stable dedupe key')
  const durableProgress = readFileSync(sellerStore.getDataPaths().progressPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(durableProgress.at(-1).lastItemBatchCount, 1, 'each committed item batch advances the fsynced per-seller recovery log')
  const resumedRun = sellerStore.prepareRun()
  const resumed = sellerStore.claimNext(resumedRun.runId, 'account-a', 1, 'cycle-recovery')
  assert.equal(resumed.id, claimed.id)
  assert.equal(resumed.currentAttempt.attemptKey, recovered.currentAttempt.attemptKey, 'resume reuses the formal attempt instead of creating a duplicate')

  // The same module instance must recover an interrupted claim too; a full
  // Electron restart is not required before clicking “继续未完成任务”. A
  // graceful cleanup releases the durable lease before the explicit restart.
  sellerStore.releaseLease(resumed.id, {
    accountId: 'account-a',
    runId: resumed.currentAttempt.runId,
    cycleKey: resumed.currentAttempt.cycleKey,
    token: resumed.currentAttempt.lease.token
  })
  const sameProcessRun = sellerStore.prepareRun()
  const sameProcessRecovered = sellerStore.claimNext(sameProcessRun.runId, 'account-a', 1, 'cycle-recovery')
  assert.equal(sameProcessRecovered.id, claimed.id, 'same-process restart exposes the interrupted claim')
  assert.equal(sameProcessRecovered.currentAttempt.attemptKey, recovered.currentAttempt.attemptKey, 'same-process resume reuses the original formal attempt key')
  sellerStore.finalizeFormalAttempt(sameProcessRecovered.id, {
    accountId: 'account-a', cycleKey: 'cycle-recovery', status: 'completed', reasonCode: 'COMPLETE_EVIDENCE'
  })

  // Parallel workers can interleave their synchronous claims, but one seller
  // still has one durable current attempt. Restart resumes account A; only
  // after A finalizes incomplete can account B receive the handoff attempt.
  sellerStore.importLinks('https://www.goofish.com/personal?userId=parallel-interleave', 'parallel-interleave.txt')
  const interleavedRun = sellerStore.prepareRun()
  const interleaveOptions = { allowedSellerIds: ['parallel-interleave'] }
  const accountAClaim = sellerStore.claimNext(interleavedRun.runId, 'account-a', 2, 'cycle-interleave', interleaveOptions)
  assert.ok(accountAClaim)
  assert.equal(sellerStore.claimNext(interleavedRun.runId, 'account-b', 2, 'cycle-interleave', interleaveOptions), null, 'account B cannot claim while account A owns the current durable attempt')
  sellerStore.markSource(accountAClaim.id, {
    status: 'running', reasonCode: 'BRANCH_CHECKPOINT', expected: { active: 2, sold: 1 },
    itemIds: { active: ['active-a'], sold: ['sold-a'] },
    evidence: { branches: { active: { complete: true }, sold: { complete: false } } }
  })
  const interleavedAttemptKey = accountAClaim.currentAttempt.attemptKey
  sellerStore = await import(`../../src/main/seller-store.js?parallel-interleave-reload=${Date.now()}`)
  const observedInterleaved = sellerStore.getAllSourceRows().find((row) => row.sellerId === 'parallel-interleave')
  const interleavedLeasePath = observedInterleaved.currentAttempt?.lease?.lockPath
  if (interleavedLeasePath) {
    const ownerPath = join(interleavedLeasePath, 'owner.json')
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
    writeFileSync(ownerPath, JSON.stringify({ ...owner, expiresAt: new Date(Date.now() - 1000).toISOString() }))
  }
  sellerStore.prepareRun({ cycleKey: 'cycle-interleave-reload' })
  const recoveredInterleaved = sellerStore.getAllSourceRows().find((row) => row.sellerId === 'parallel-interleave')
  assert.equal(recoveredInterleaved.status, 'pending')
  assert.equal(recoveredInterleaved.currentAttempt.accountId, 'account-a')
  assert.equal(recoveredInterleaved.currentAttempt.attemptKey, interleavedAttemptKey, 'restart preserves the original formal attempt key')
  assert.deepEqual(recoveredInterleaved.itemIds, { active: ['active-a'], sold: ['sold-a'] })
  assert.deepEqual(recoveredInterleaved.evidence.branches, { active: { complete: true }, sold: { complete: false } })
  const resumedInterleaved = sellerStore.claimNext(interleavedRun.runId, 'account-a', 2, 'cycle-interleave', interleaveOptions)
  assert.equal(resumedInterleaved.currentAttempt.attemptKey, interleavedAttemptKey, 'same account resumes the orphan instead of opening a duplicate')
  sellerStore.finalizeFormalAttempt(resumedInterleaved.id, {
    accountId: 'account-a', cycleKey: 'cycle-interleave', status: 'incomplete', reasonCode: 'TRUSTED_COUNT_SHORT'
  })
  const accountBContinuation = sellerStore.claimNext(interleavedRun.runId, 'account-b', 2, 'cycle-interleave', interleaveOptions)
  assert.equal(accountBContinuation.currentAttempt.accountId, 'account-b')
  sellerStore.finalizeFormalAttempt(accountBContinuation.id, {
    accountId: 'account-b', cycleKey: 'cycle-interleave', status: 'completed', reasonCode: 'COMPLETE_EVIDENCE',
    itemIds: { active: ['active-a', 'active-b'], sold: ['sold-a', 'sold-b'] }
  })
  const interleavedLedger = sellerStore.getSources({ q: 'parallel-interleave' }).items[0]
  assert.deepEqual(interleavedLedger.attemptedAccountIds.sort(), ['account-a', 'account-b'])
  assert.equal(interleavedLedger.attempts.length, 2, 'A incomplete to B completed leaves two formal attempts')
  assert.equal(interleavedLedger.attempts.filter((attempt) => attempt.cycleKey === 'cycle-interleave').every((attempt) => attempt.endedAt), true)
  assert.equal(sellerStore.claimNext(interleavedRun.runId, 'account-a', 2, 'cycle-interleave', interleaveOptions), null, 'A cannot claim the seller twice in one cycle')

  const corruptTarget = sellerStore.getAllSourceRows().find((row) => row.id !== claimed.id)
  appendFileSync(paths.progressPath, JSON.stringify({
    id: corruptTarget.id, schemaVersion: 3, status: 'incomplete', reasonCode: 'BEFORE_CORRUPTION', updatedAt: '2099-01-01T00:00:00.000Z'
  }) + '\n')
  appendFileSync(paths.progressPath, '{malformed-middle-line\n')
  appendFileSync(paths.progressPath, JSON.stringify({
    id: corruptTarget.id, schemaVersion: 3, status: 'failed', reasonCode: 'AFTER_CORRUPTION', retryable: true, updatedAt: '2100-01-01T00:00:00.000Z'
  }) + '\n')
  sellerStore = await import(`../../src/main/seller-store.js?corruption-reload=${Date.now()}`)
  assert.equal(sellerStore.getAllSourceRows().find((row) => row.id === corruptTarget.id).reasonCode, 'AFTER_CORRUPTION', 'a bad middle row does not hide later valid evidence')
  appendFileSync(paths.progressPath, JSON.stringify({
    id: corruptTarget.id,
    schemaVersion: 3,
    status: 'failed',
    reasonCode: 'CRAWL_FAILED',
    reason: '卖家页导航超时',
    lastAccountId: 'account-b',
    evidence: { failureReasonCode: 'NAV_TIMEOUT' },
    updatedAt: '2110-01-01T00:00:00.000Z'
  }) + '\n')
  sellerStore = await import(`../../src/main/seller-store.js?transient-failure-reload=${Date.now()}`)
  const migratedTransient = sellerStore.getAllSourceRows().find((row) => row.id === corruptTarget.id)
  assert.equal(migratedTransient.status, 'incomplete', 'a transient navigation failure is not left permanently failed')
  assert.equal(migratedTransient.retryable, true, 'transient navigation failure is marked for one bounded retry')
  assert.equal(migratedTransient.reasonCode, 'TRANSIENT_RETRY_PENDING')
  const retryRun = sellerStore.prepareRun()
  const retryClaim = sellerStore.claimNext(retryRun.runId, 'account-b', 1, 'cycle-transient-retry', {
    retryableSellerIds: [corruptTarget.sellerId],
    maxTransientRetries: 1
  })
  assert.equal(retryClaim.id, corruptTarget.id, 'bounded retry can reclaim the transient seller')
  sellerStore.finalizeFormalAttempt(retryClaim.id, {
    accountId: 'account-b', cycleKey: 'cycle-transient-retry', status: 'completed', reasonCode: 'COMPLETE_EVIDENCE'
  })
  sellerStore.importLinks('https://www.goofish.com/personal?userId=safety-retry', 'safety-retry.txt')
  const safetyRetrySource = sellerStore.getAllSourceRows().find((row) => row.sellerId === 'safety-retry')
  sellerStore.markSource(safetyRetrySource.id, {
    status: 'incomplete',
    reasonCode: 'SAFETY_LIMIT_REACHED',
    lastAccountId: 'account-b',
    expected: { active: 10, sold: 0 },
    itemIds: { active: ['safety-item'], sold: [] }
  })
  sellerStore = await import(`../../src/main/seller-store.js?safety-retry-reload=${Date.now()}`)
  const migratedSafetyRetry = sellerStore.getAllSourceRows().find((row) => row.sellerId === 'safety-retry')
  assert.equal(migratedSafetyRetry.retryable, true, 'safety-limited evidence receives one bounded continuation')
  assert.equal(migratedSafetyRetry.reasonCode, 'INCOMPLETE_RETRY_PENDING')
  const safetyRetryRun = sellerStore.prepareRun()
  const safetyRetryClaim = sellerStore.claimNext(safetyRetryRun.runId, 'account-b', 1, 'cycle-safety-retry', {
    allowedSellerIds: ['safety-retry'],
    retryableSellerIds: ['safety-retry'],
    maxTransientRetries: 1
  })
  assert.equal(safetyRetryClaim.id, safetyRetrySource.id, 'safety-limited seller can be reclaimed once')
  sellerStore.finalizeFormalAttempt(safetyRetryClaim.id, {
    accountId: 'account-b', cycleKey: 'cycle-safety-retry', status: 'incomplete', reasonCode: 'SAFETY_LIMIT_REACHED'
  })
  const scopedRun = sellerStore.prepareRun()
  const excludedTerminal = sellerStore.claimNext(scopedRun.runId, 'account-b', 1, 'cycle-fast', {
    allowedSellerIds: [corruptTarget.sellerId],
    pendingOnly: true
  })
  assert.equal(excludedTerminal, null, 'test-fast does not duplicate a terminal fixture member')
  const pendingTarget = sellerStore.getAllSourceRows().find((row) => row.url.includes('scoped-pending'))
  const scopedPending = sellerStore.claimNext(scopedRun.runId, 'account-b', 1, 'cycle-fast', {
    allowedSellerIds: [pendingTarget.sellerId],
    pendingOnly: true
  })
  assert.equal(scopedPending.id, pendingTarget.id, 'test-fast claims only pending members of its frozen fixture')

  const frozenSellerIds = Array.from({ length: 20 }, (_, index) => `frozen-${String(index + 1).padStart(2, '0')}`)
  sellerStore.importLinks(frozenSellerIds.map((sellerId) => `https://www.goofish.com/personal?userId=${sellerId}`).join('\n'), 'frozen-20.txt')
  const frozenRun = sellerStore.prepareRun()
  const frozenClaims = []
  while (true) {
    const row = sellerStore.claimNext(frozenRun.runId, 'account-fast', 1, 'cycle-frozen-20', {
      allowedSellerIds: frozenSellerIds,
      pendingOnly: true
    })
    if (!row) break
    frozenClaims.push(row)
    sellerStore.finalizeFormalAttempt(row.id, {
      accountId: 'account-fast', cycleKey: 'cycle-frozen-20', status: 'completed', reasonCode: 'COMPLETE_EVIDENCE'
    })
  }
  assert.equal(frozenClaims.length, 20, 'frozen business seller IDs resolve to exactly 20 internal source rows')
  assert.deepEqual(frozenClaims.map((row) => row.sellerId).sort(), frozenSellerIds.sort())
  assert.ok(readdirSync(sellerStore.getDataPaths().eventsDir).some((name) => name.endsWith('.jsonl')), 'corruption is recorded in partitioned diagnostics')

  // An unexpired lease is rebound to the new run identity on recovery; the
  // owner file must follow that identity so renew/release remain authorized.
  sellerStore.importLinks('https://www.goofish.com/personal?userId=unexpired-rebind', 'unexpired-rebind.txt')
  const unexpiredRun = sellerStore.prepareRun()
  const unexpiredOptions = { allowedSellerIds: ['unexpired-rebind'] }
  const unexpiredClaim = sellerStore.claimNext(unexpiredRun.runId, 'account-a', 1, 'cycle-unexpired-rebind', unexpiredOptions)
  sellerStore = await import(`../../src/main/seller-store.js?unexpired-rebind=${Date.now()}`)
  const unexpiredResumeRun = sellerStore.prepareRun()
  const unexpiredResumed = sellerStore.claimNext(unexpiredResumeRun.runId, 'account-a', 1, 'cycle-unexpired-rebind', unexpiredOptions)
  assert.equal(unexpiredResumed.id, unexpiredClaim.id)
  assert.equal(sellerStore.renewLease(unexpiredResumed.id, {
    accountId: 'account-a',
    runId: unexpiredResumed.currentAttempt.runId,
    cycleKey: unexpiredResumed.currentAttempt.cycleKey,
    token: unexpiredResumed.currentAttempt.lease.token
  }).renewed, true, 'rebound unexpired lease can be renewed')
  assert.equal(sellerStore.releaseLease(unexpiredResumed.id, {
    accountId: 'account-a',
    runId: unexpiredResumed.currentAttempt.runId,
    cycleKey: unexpiredResumed.currentAttempt.cycleKey,
    token: unexpiredResumed.currentAttempt.lease.token
  }).released, true, 'rebound unexpired lease can be released')

  const now = new Date('2026-08-23T12:00:00.000Z')
  sellerStore.addEvent({ at: '2026-08-13T12:00:00.000Z', type: 'archive-me' })
  sellerStore.addEvent({ at: '2026-02-22T12:00:00.000Z', type: 'expire-me', token: 'must-not-archive' })
  const dryArchive = sellerStore.maintainEventHistory({ now, dryRun: true })
  assert.equal(dryArchive.archive.length >= 2, true)
  assert.equal(dryArchive.delete.length, 0, 'dry-run never deletes evidence')
  sellerStore.maintainEventHistory({ now, dryRun: false })
  const archives = readdirSync(sellerStore.getDataPaths().eventArchiveDir).filter((name) => name.endsWith('.gz'))
  assert.equal(archives.length >= 2, true, 'closed partitions are gzip archived')
  const blocked = sellerStore.maintainEventHistory({ now, dryRun: true })
  assert.equal(blocked.blockedDelete.length >= 1, true, '180-day deletion is blocked without a recoverable export')

  const manifestPath = sellerStore.exportEventHistory({ destinationDir: exportDir, now })
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.files.length >= 2, true)
  assert.equal(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && existsSync(file.exportPath)), true)
  const cleanup = sellerStore.maintainEventHistory({ now, dryRun: false, exportManifestPath: manifestPath })
  assert.equal(cleanup.deleted.length >= 1, true, 'expired archives delete only after verified export')
  assert.equal(existsSync(paths.checkpointPath), true, 'latest checkpoint is protected from history cleanup')
  assert.equal(existsSync(paths.itemsPath), true, 'current item/dedupe evidence survives history cleanup')
  assert.match(readFileSync(paths.itemsPath, 'utf8'), /sold-2/)
  assert.doesNotMatch(readFileSync(manifestPath, 'utf8'), /must-not-archive/, 'manifest contains checksums and paths, not event secrets')

  // Starting a run for the other eligible accounts must not discard the
  // cooling account's durable recovery marker; the scheduler needs it to
  // release that account after the safety window instead of leaving it stuck.
  sellerStore.scheduleRiskRecovery({ accountId: 'account-a', coolingUntil: new Date(Date.now() + 60_000).toISOString(), reasonCode: 'PUBLIC_HOME_FALLBACK' })
  sellerStore.prepareRun({ cycleKey: 'cycle-preserve-risk-recovery' })
  assert.equal(sellerStore.getRiskRecovery()?.accountId, 'account-a', 'active runs preserve pending risk recovery metadata')
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  rmSync(tempDataDir, { recursive: true, force: true })
  rmSync(exportDir, { recursive: true, force: true })
}

console.log('seller store recovery and retention matrix passed (RPA-04/RPA-07)')
