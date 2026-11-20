import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'seller-source-mode-'))
const manifestPath = join(dataDir, 'canonical.manifest.json')
const sellerId = 'canonical-only'
const sha256 = createHash('sha256').update(sellerId).digest('hex')
mkdirSync(dataDir, { recursive: true })
writeFileSync(join(dataDir, 'seller-sources.json'), JSON.stringify([{
  id: 'legacy-external',
  sellerId: 'legacy-external',
  url: 'https://www.goofish.com/personal?userId=legacy-external',
  sellerName: '普通导入卖家',
  source: 'legacy-file'
}], null, 2))
writeFileSync(join(dataDir, 'xianyu-seller-crawl.json'), JSON.stringify({
  lastCanonicalImport: { sha256, count: 1 },
  job: { running: false }
}, null, 2))
writeFileSync(manifestPath, JSON.stringify({
  schemaVersion: 1,
  generatedAt: '2026-08-22T00:00:00.000Z',
  count: 1,
  sha256,
  hashAlgorithm: 'sha256(sortedSellerIdsJoinedByNewline)',
  provenance: { label: 'source-mode-regression', sourcePath: 'generated-test-fixture' },
  sellerIds: [sellerId]
}, null, 2))

process.env.XIANYU_SELLER_DATA_DIR = dataDir
process.env.XIANYU_SELLER_CANONICAL_MANIFEST = manifestPath
try {
  const store = await import(`../../src/main/seller-store.js?source-mode=${Date.now()}`)
  const before = store.getStatus()
  assert.equal(before.sourceMode, 'imported', 'legacy hash alone cannot force canonical mode')
  assert.equal(before.evidence.indexed, 1, 'ordinary legacy seller remains visible')

  const reconciliation = store.reconcileCanonicalSellerManifest(manifestPath, { expectedCount: 1 })
  assert.equal(reconciliation.skipped, true, 'ordinary imported rows do not get replaced by startup reconciliation')
  assert.equal(store.getAllSourceRows()[0].sellerId, 'legacy-external')

  store.importCanonicalSellerManifest(manifestPath, { expectedCount: 1 })
  assert.equal(store.getStatus().sourceMode, 'canonical', 'explicit manifest import enters canonical mode')
  assert.equal(store.getAllSourceRows()[0].sellerId, sellerId)
  console.log('seller source mode migration regression: PASS')
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  delete process.env.XIANYU_SELLER_CANONICAL_MANIFEST
  rmSync(dataDir, { recursive: true, force: true })
}
