import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateSchedule } from '../../src/main/seller-schedule.js'

const settings = {
  weeklyEnabled: true,
  weeklyDay: 1,
  weeklyTime: '02:00',
  timezone: 'Asia/Shanghai'
}

const at = (iso, extra = {}) => evaluateSchedule({ now: iso, settings, ...extra })

assert.equal(at('2026-08-23T17:59:00.000Z').outcome, 'idle', 'RPA-07 Monday 01:59 Shanghai is not due')

const due = at('2026-08-23T18:00:00.000Z')
assert.equal(due.outcome, 'scheduled', 'RPA-07 Monday 02:00 starts once')
assert.equal(due.shouldStart, true)
assert.match(due.cycleKey, /^seller-weekly:2026-08-24:02:00:Asia\/Shanghai$/)

const catchUp = at('2026-08-24T02:00:00.000Z')
assert.equal(catchUp.outcome, 'catch_up', 'RPA-07 Monday 10:00 Shanghai catches up')
assert.equal(catchUp.shouldStart, true)

const missed = at('2026-08-25T03:00:01.000Z')
assert.equal(missed.outcome, 'missed', 'older than 24 hours is reported without starting')
assert.equal(missed.shouldStart, false)

assert.equal(at('2026-08-24T02:00:00.000Z', { lastCycle: { cycleKey: catchUp.cycleKey } }).outcome, 'duplicate')
assert.equal(at('2026-08-24T02:00:00.000Z', { running: true }).outcome, 'skipped_overlap')

assert.equal(evaluateSchedule({ now: '2026-08-24T02:00:00.000Z', settings: { ...settings, weeklyEnabled: false } }).outcome, 'idle')
assert.throws(() => evaluateSchedule({ now: '2026-08-24T02:00:00.000Z', settings: { ...settings, timezone: 'UTC' } }), /Asia\/Shanghai/)
assert.throws(() => evaluateSchedule({ now: '2026-08-24T02:00:00.000Z', settings: { ...settings, weeklyTime: '25:99' } }), /weeklyTime/)

const tempDataDir = mkdtempSync(join(tmpdir(), 'seller-schedule-'))
try {
  process.env.XIANYU_SELLER_DATA_DIR = tempDataDir
  const sellerStore = await import(`../../src/main/seller-store.js?schedule=${Date.now()}`)
  sellerStore.importLinks([
    'https://www.goofish.com/personal?userId=completed',
    'https://www.goofish.com/personal?userId=no-active',
    'https://www.goofish.com/personal?userId=pending',
    'https://www.goofish.com/personal?userId=retryable-failed'
  ].join('\n'), 'schedule-fixture.txt')
  const rows = sellerStore.getAllSourceRows()
  sellerStore.markSource(rows[0].id, { status: 'completed', reasonCode: 'COMPLETE_EVIDENCE' })
  sellerStore.markSource(rows[1].id, { status: 'no_active', reasonCode: 'NO_ACTIVE_COMPLETE' })
  sellerStore.markSource(rows[3].id, { status: 'failed', reasonCode: 'NETWORK_RETRY_EXHAUSTED', retryable: true })

  const claim = sellerStore.claimScheduleCycle(due)
  assert.equal(claim.claimed, true, 'cycle is durably claimed before navigation')
  assert.throws(
    () => sellerStore.claimScheduleCycle(at('2026-08-24T02:00:00.000Z', { running: true })),
    /cannot be claimed/,
    'an overlap does not consume the weekly cycle and may catch up later'
  )
  assert.equal(sellerStore.claimScheduleCycle(due).claimed, false, 'same process cannot claim a cycle twice')
  const retained = sellerStore.getAllSourceRows()
  assert.equal(retained.find((row) => row.id === rows[0].id).status, 'completed')
  assert.equal(retained.find((row) => row.id === rows[1].id).status, 'no_active')

  const reloadedStore = await import(`../../src/main/seller-store.js?schedule-reload=${Date.now()}`)
  assert.equal(reloadedStore.claimScheduleCycle(due).claimed, false, 'restart cannot claim a persisted cycle twice')
  const run = reloadedStore.prepareRun({ reset: false })
  const pending = reloadedStore.claimNext(run.runId, 'account-a', 1, due.cycleKey)
  assert.match(pending.url, /userId=pending/, 'scheduled work selects pending first')
  reloadedStore.finalizeFormalAttempt(pending.id, {
    accountId: 'account-a', cycleKey: due.cycleKey, status: 'completed', reasonCode: 'COMPLETE_EVIDENCE'
  })
  const retryable = reloadedStore.claimNext(run.runId, 'account-b', 1, due.cycleKey)
  assert.equal(retryable, null, 'a finalized failed row is never transferred to another account')
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  rmSync(tempDataDir, { recursive: true, force: true })
}

console.log('seller schedule matrix passed (RPA-07)')
