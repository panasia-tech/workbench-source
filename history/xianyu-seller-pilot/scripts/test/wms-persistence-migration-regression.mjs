import assert from 'node:assert/strict'
import { createWmsPersistence, sanitizeWmsSyncState } from '../../src/main/wms-persistence.js'

let state = { status: 'unconfigured' }
let snapshot = [{ sku_code: 'SKU-1', status: 'IN_STOCK' }]
const persistence = createWmsPersistence({
  readState: () => state,
  writeState: (next) => { state = next },
  readSnapshot: () => snapshot,
  writeSnapshot: (next) => { snapshot = next }
})

let protectedSecrets = null
let cleared = false
const migrated = persistence.migrateLegacy({
  legacyState: { wmsSyncedAt: '2026-08-25T00:00:00.000Z', counts: { skuTotal: 1, spuTotal: 1 } },
  legacySecrets: { mcpKey: 'secret-key', restUsername: 'ADMIN', restPassword: 'DEMO_ONLY_REDACTED' },
  saveSecrets: (value) => { protectedSecrets = { ...value }; return true },
  clearLegacySecrets: () => { cleared = true }
})
assert.equal(migrated.ok, true)
assert.equal(migrated.secretMigrated, true)
assert.equal(cleared, true)
assert.deepEqual(protectedSecrets, { mcpKey: 'secret-key', restUsername: 'ADMIN', restPassword: 'DEMO_ONLY_REDACTED' })
assert.equal(migrated.state.lastSuccessAt, '2026-08-25T00:00:00.000Z')
assert.deepEqual(snapshot, [{ sku_code: 'SKU-1', status: 'IN_STOCK' }])

let saveAttempts = 0
const blocked = persistence.migrateLegacy({
  legacyState: { wmsSyncedAt: '2026-08-25T00:00:00.000Z' },
  legacySecrets: { restPassword: 'DEMO_ONLY_REDACTED' },
  saveSecrets: () => { saveAttempts += 1; return false }
})
assert.equal(blocked.ok, false)
assert.equal(blocked.secretBlocked, true)
assert.equal(saveAttempts, 1)

const sanitized = sanitizeWmsSyncState({
  status: 'failed', safeError: 'authorization=Bearer leak-token',
  lastSuccessAt: '2026-08-20T00:00:00.000Z', counts: { skuTotal: 1, spuTotal: 1 }
}, { now: Date.parse('2026-08-25T00:00:00.000Z') })
assert.equal(sanitized.stale, true)
assert.doesNotMatch(sanitized.safeError, /leak-token/)

console.log('wms persistence migration regression: passed (versioned state/last-good snapshot/protected-secret gate/stale sanitization)')
