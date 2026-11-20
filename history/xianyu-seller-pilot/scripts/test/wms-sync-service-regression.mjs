import assert from 'node:assert/strict'
import { createWmsSyncService } from '../../src/main/wms-sync-service.js'
import { createWmsPersistence } from '../../src/main/wms-persistence.js'

const iso = (value) => new Date(value).toISOString()
const flush = () => new Promise((resolve) => setImmediate(resolve))

function fixture({ state = {}, rows = [] } = {}) {
  let persistedState = { ...state }
  let snapshot = [...rows]
  const persistence = createWmsPersistence({
    readState: () => persistedState,
    writeState: (next) => { persistedState = { ...next } },
    readSnapshot: () => snapshot,
    writeSnapshot: (next) => { snapshot = [...next] }
  })
  return { persistence, getState: () => persistedState, getSnapshot: () => snapshot }
}

// A successful injected sync publishes only safe metadata and counts.
{
  const store = fixture()
  const service = createWmsSyncService({
    persistence: store.persistence,
    isConfigured: () => true,
    sync: async () => ({ ok: true, source: 'fixture', syncedAt: iso(1000), skuTotal: 2, spuTotal: 1, invalidSpuRows: 0 }),
    now: () => 1000
  })
  const state = await service.refresh({ reason: 'manual' })
  assert.equal(state.status, 'synced')
  assert.equal(state.source, 'fixture')
  assert.equal(state.lastAttemptAt, iso(1000))
  assert.equal(state.lastSuccessAt, iso(1000))
  assert.equal(state.stale, false)
  assert.equal(state.schemaVersion, 1)
  assert.deepEqual(state.counts, { skuTotal: 2, spuTotal: 1, invalidSpuRows: 0 })
  assert.equal('password' in state, false)
  assert.equal('token' in state, false)
}

// Concurrent callers share one promise and therefore one upstream request.
{
  const store = fixture()
  let calls = 0
  let resolveSync
  const service = createWmsSyncService({
    persistence: store.persistence,
    isConfigured: () => true,
    sync: () => {
      calls += 1
      return new Promise((resolve) => { resolveSync = resolve })
    },
    now: () => 2000
  })
  const first = service.refresh({ reason: 'manual' })
  const second = service.refresh({ reason: 'interval' })
  assert.strictEqual(first, second)
  await flush()
  assert.equal(calls, 1)
  resolveSync({ ok: true, source: 'fixture', syncedAt: iso(2000), skuTotal: 1, spuTotal: 1 })
  await first
  assert.equal(calls, 1)
}

// Failure is safe: the previous complete snapshot and success timestamp stay.
{
  const store = fixture({
    rows: [{ sku_code: 'SKU-1', status: 'IN_STOCK' }],
    state: {
      status: 'synced', source: 'fixture', lastSuccessAt: iso(3000),
      counts: { skuTotal: 1, spuTotal: 1, invalidSpuRows: 0 }
    }
  })
  const service = createWmsSyncService({
    persistence: store.persistence,
    isConfigured: () => true,
    sync: async () => { throw new Error('authorization=Bearer hidden-token') },
    now: () => 4000,
    retryDelayMs: 60_000
  })
  const state = await service.refresh({ reason: 'manual' })
  assert.equal(state.status, 'failed')
  assert.equal(state.lastSuccessAt, iso(3000))
  assert.deepEqual(store.getSnapshot(), [{ sku_code: 'SKU-1', status: 'IN_STOCK' }])
  assert.match(state.safeError, /REDACTED|WMS 同步失败/)
  assert.doesNotMatch(state.safeError, /hidden-token/)
}

// Startup + bounded retry: one initial attempt and at most three retries.
{
  const store = fixture()
  const timers = []
  let calls = 0
  const service = createWmsSyncService({
    persistence: store.persistence,
    isConfigured: () => true,
    sync: async () => {
      calls += 1
      throw new Error('upstream unavailable')
    },
    now: () => 5000,
    retryDelayMs: 1,
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length },
    clearTimeoutFn: () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {}
  })
  service.start()
  await flush()
  for (let i = 0; i < 3; i += 1) {
    const next = timers.shift()
    assert.equal(typeof next, 'function')
    next()
    await flush()
  }
  assert.equal(calls, 4)
  assert.equal(service.getState().retry, 3)
  assert.equal(timers.length, 0)
  await service.stop()
}

console.log('wms sync service regression: passed (single-flight/sanitized state/cache preservation/bounded retry)')
