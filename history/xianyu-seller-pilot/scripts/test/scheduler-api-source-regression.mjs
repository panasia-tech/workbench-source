import assert from 'node:assert/strict'
import { buildUnifiedSchedulerSource } from '../../src/main/scheduler-source.js'

const settings = { maxTasks: 0 }

// No successful API snapshot means the scheduler has no executable source,
// even when an Excel collection exists elsewhere in the application.
const blockedState = {
  source: 'no_source',
  status: 'unconfigured',
  ready: false,
  lastGoodAt: null,
  reason: '库存 API 尚未配置或尚未成功同步'
}
const blocked = buildUnifiedSchedulerSource({
  settings,
  sourceState: blockedState,
  tasks: [{ id: 'excel-1', source: 'excel_extension', enabled: true }]
})
assert.deepEqual(blocked.tasks, [])
assert.equal(blocked.source, 'api_spu')
assert.equal(blocked.sourceState, blockedState)
assert.equal(blocked.blockedReason, blockedState.reason)

// A failed refresh may continue with the last-good API snapshot. Excel rows
// absent from that snapshot remain valid extension work and keep the same
// API-owned scheduler source.
const staleState = {
  source: 'api_spu',
  status: 'failed',
  ready: true,
  lastGoodAt: '2026-08-25T08:00:00.000Z',
  reason: null
}
const staleTasks = [{ id: 'excel-extension-1', source: 'excel_extension', enabled: true }]
const stale = buildUnifiedSchedulerSource({ settings, sourceState: staleState, tasks: staleTasks })
assert.deepEqual(stale.tasks, staleTasks)
assert.equal(stale.source, 'api_spu')
assert.equal(stale.blockedReason, null)

console.log('scheduler API source regression: passed (no-source fail-closed; last-good stale snapshot keeps unified extensions)')
