import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(scriptDir, '../..')
const generatorPath = join(projectDir, 'scripts/data/generate-canonical-seller-manifest.mjs')
const productionManifestPath = join(projectDir, 'resources/seller-index/canonical-sellers.manifest.json')
const requireCanonical = process.argv.includes('--require-canonical-manifest')

const generator = await import(`../data/generate-canonical-seller-manifest.mjs?test=${Date.now()}`)

function runGenerator(args) {
  return execFileSync(process.execPath, [generatorPath, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function assertRejectedMutation(manifest, mutate, pattern) {
  const changed = clone(manifest)
  mutate(changed)
  assert.throws(() => generator.verifyCanonicalSellerManifest(changed), pattern)
}

if (requireCanonical) {
  const artifact = JSON.parse(readFileSync(productionManifestPath, 'utf8'))
  const verified = generator.verifyCanonicalSellerManifest(artifact, { expectedCount: 9977 })
  assert.equal(verified.count, 9977, 'RPA-07 production artifact must contain exactly 9,977 seller IDs')
  const serialized = JSON.stringify(artifact)
  assert.doesNotMatch(serialized, /sellerName|canonicalUrl|sourceUrl|cookie|token|cities|mainContent|mainType/i, 'artifact must not retain source fields')
  assertRejectedMutation(artifact, (value) => value.sellerIds.push(value.sellerIds[0]), /duplicate/i)
  assertRejectedMutation(artifact, (value) => { value.count -= 1 }, /count/i)
  assertRejectedMutation(artifact, (value) => { value.sellerIds[0] = '999999999999999999' }, /sorted|hash/i)
  assertRejectedMutation(artifact, (value) => { value.sha256 = '0'.repeat(64) }, /hash/i)
}

const tempDir = mkdtempSync(join(tmpdir(), 'seller-index-regression-'))
try {
  const inputPath = join(tempDir, 'replaceable-input.json')
  const manifestPath = join(tempDir, 'canonical.manifest.json')
  writeFileSync(inputPath, JSON.stringify([
    { sellerId: '3003', sellerName: 'must-not-leak', cookie: 'must-not-leak' },
    { sellerId: '1001', sourceUrl: 'https://example.invalid/private' },
    { sellerId: '4004', token: 'must-not-leak' },
    { sellerId: '2002', cities: 'must-not-leak' },
    { sellerId: '5005' },
    { sellerId: '6006' },
    { sellerId: '7007' },
    { sellerId: '8008' },
    { sellerId: '9009' }
  ]))
  runGenerator(['--input', inputPath, '--output', manifestPath, '--expected-count', '9', '--provenance', 'regression-fixture'])
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(manifest.sellerIds, ['1001', '2002', '3003', '4004', '5005', '6006', '7007', '8008', '9009'])
  assert.equal(manifest.count, 9)
  assert.equal(generator.verifyCanonicalSellerManifest(manifest, { expectedCount: 9 }).count, 9)
  assert.deepEqual(Object.keys(manifest).sort(), ['count', 'generatedAt', 'hashAlgorithm', 'provenance', 'schemaVersion', 'sellerIds', 'sha256'].sort())
  assert.doesNotMatch(JSON.stringify(manifest), /must-not-leak|sellerName|sourceUrl|cookie|token|cities/i)

  writeFileSync(inputPath, JSON.stringify([{ sellerId: '1001' }, { sellerId: ' 1001 ' }, { sellerId: '2002' }, { sellerId: '3003' }]))
  assert.throws(
    () => runGenerator(['--input', inputPath, '--output', manifestPath, '--expected-count', '4']),
    /duplicate/i,
    'duplicates after normalization must abort generation'
  )

  {
    const dataDir = join(tempDir, 'store')
    const sourcePath = join(dataDir, 'seller-sources.json')
    mkdirSync(dataDir, { recursive: true })
    process.env.XIANYU_SELLER_DATA_DIR = dataDir
    process.env.XIANYU_SELLER_CANONICAL_MANIFEST = manifestPath
    writeFileSync(sourcePath, JSON.stringify([
    { id: 'legacy-a', url: 'https://www.goofish.com/personal?userId=1001', sellerName: 'A', cookie: 'drop-me' },
    { id: 'legacy-b', url: 'https://www.goofish.com/personal?userId=2002', sellerName: 'B' },
    { id: 'legacy-c1', url: 'https://www.goofish.com/personal?userId=3003', sellerName: 'C1' },
    { id: 'legacy-c2', url: 'https://www.goofish.com/personal?userId=3003', sellerName: 'C2' },
    { id: 'legacy-malformed', url: 'not-a-seller-url', sellerName: 'bad' }
    ]))

    const sellerStore = await import(`../../src/main/seller-store.js?index-regression=${Date.now()}`)
    const reconciliation = sellerStore.importCanonicalSellerManifest(manifestPath, { expectedCount: 9 })
  assert.equal(reconciliation.legacy.total, 5)
  assert.equal(reconciliation.legacy.accounted, 5)
  assert.equal(reconciliation.legacy.matched + reconciliation.legacy.needsReview, 5)
  assert.equal(reconciliation.canonical.total, 9)
  assert.equal(reconciliation.canonical.added, 6)
  assert.equal(reconciliation.canonical.indexed, 9)
  assert.equal(reconciliation.reviewRows.length, reconciliation.legacy.needsReview)
  assert.equal(reconciliation.reviewRows.every((row) => row.status === 'needs_review'), true)
  assert.doesNotMatch(JSON.stringify(reconciliation), /drop-me|cookie/i)
  assert.doesNotMatch(readFileSync(sourcePath, 'utf8'), /drop-me|cookie/i, 'canonical source persistence strips legacy credentials')

  const indexed = sellerStore.querySellerMembership({ dimension: 'indexed', page: 1, pageSize: 100 })
  assert.equal(indexed.total, 9)

  for (const row of sellerStore.getAllSourceRows()) {
    assert.equal(sellerStore.isIndexed(row), true)
    assert.equal(['pending', 'running', 'completed', 'no_active', 'incomplete', 'needs_review', 'failed', 'login_expired', 'risk_cooldown'].includes(row.status), true)
  }

  const statuses = ['pending', 'running', 'completed', 'no_active', 'incomplete', 'needs_review', 'failed', 'login_expired', 'risk_cooldown']
  indexed.items.forEach((row, index) => sellerStore.markSource(row.id, { status: statuses[index], reasonCode: `TEST_${statuses[index].toUpperCase()}` }))
  sellerStore.markSource(indexed.items[0].id, {
    status: statuses[0],
    checkpointHash: 'a'.repeat(64),
    persistedAt: '2026-08-22T01:00:00.000Z',
    itemIds: { active: ['item-loaded'], sold: [] },
    attempts: [{ cycleKey: 'cycle-test', accountId: 'account-a', crawlStartedAt: '2026-08-22T01:00:00.000Z' }]
  })
  sellerStore.markSource(indexed.items[1].id, {
    status: statuses[1],
    attempts: [{
      cycleKey: 'cycle-test',
      accountId: 'account-a',
      crawlStartedAt: '2026-08-22T01:00:00.000Z',
      crawlFinishedAt: '2026-08-22T01:01:00.000Z',
      crawlResult: 'failed'
    }]
  })
  const third = indexed.items[2]
  sellerStore.markSource(third.id, {
    status: 'completed',
    snapshotHash: 'b'.repeat(64),
    committedAt: '2026-08-22T01:02:00.000Z',
    attempts: [{
      cycleKey: 'cycle-test',
      accountId: 'account-a',
      crawlStartedAt: '2026-08-22T01:00:00.000Z',
      crawlFinishedAt: '2026-08-22T01:02:00.000Z',
      crawlResult: 'completed'
    }]
  })

  assert.equal(sellerStore.querySellerMembership({ dimension: 'loaded' }).total, 2, 'loaded requires committed content evidence')
  assert.equal(sellerStore.querySellerMembership({ dimension: 'crawled' }).total, 2, 'crawled requires a finalized durable attempt')
  const summary = sellerStore.getSellerEvidenceSummary()
  assert.equal(summary.indexed, 9)
  assert.equal(summary.loaded, 2)
  assert.equal(summary.crawled, 2)
  assert.equal(Object.values(summary.statuses).reduce((sum, value) => sum + value, 0), summary.indexed)
  for (const [status, count] of Object.entries(summary.statuses)) {
    assert.equal(count, 1, `nine-status partition contains ${status} exactly once in the fixture`)
    assert.equal(sellerStore.querySellerMembership({ dimension: 'status', status }).total, count, `summary/query equality for ${status}`)
  }
  for (const [dimension, count] of [['indexed', summary.indexed], ['loaded', summary.loaded], ['crawled', summary.crawled]]) {
    const traversed = []
    for (let page = 1; traversed.length < count; page += 1) {
      const result = sellerStore.querySellerMembership({ dimension, page, pageSize: 1 })
      if (!result.items.length) break
      traversed.push(...result.items)
    }
    assert.equal(traversed.length, count, `${dimension} complete page traversal equals summary`)
    assert.equal(new Set(traversed.map((row) => row.sellerId)).size, count, `${dimension} page traversal contains no duplicate seller`)
  }
    assert.throws(() => sellerStore.querySellerMembership({ dimension: 'unknown' }), /dimension/i)
    assert.throws(() => sellerStore.querySellerMembership({ dimension: 'status', status: 'done' }), /status/i)

    const mismatchStoreDir = join(tempDir, 'restart-url-mismatch')
    mkdirSync(mismatchStoreDir, { recursive: true })
    process.env.XIANYU_SELLER_DATA_DIR = mismatchStoreDir
    process.env.XIANYU_SELLER_CANONICAL_MANIFEST = manifestPath
    const mismatchSeed = await import(`../../src/main/seller-store.js?mismatch-seed=${Date.now()}`)
    mismatchSeed.reconcileCanonicalSellerManifest(manifestPath, { expectedCount: 9 })
    const mismatchSourcePath = mismatchSeed.getDataPaths().sourcePath
    const corruptedSources = JSON.parse(readFileSync(mismatchSourcePath, 'utf8'))
    const corrupted = corruptedSources.find((row) => row.sellerId === '1001')
    corrupted.url = 'https://www.goofish.com/personal?userId=2002'
    writeFileSync(mismatchSourcePath, JSON.stringify(corruptedSources))

    const mismatchRestart = await import(`../../src/main/seller-store.js?mismatch-restart=${Date.now()}`)
    const repaired = mismatchRestart.reconcileCanonicalSellerManifest(manifestPath, { expectedCount: 9 })
    assert.equal(repaired.changed, true, 'matching manifest metadata cannot bypass sellerId/URL consistency after restart')
    assert.equal(repaired.reviewRows.some((row) => (
      row.reasonCode === 'LEGACY_SELLER_ID_URL_MISMATCH' &&
      row.preservedSource.sellerId === '1001' &&
      row.preservedSource.url.includes('userId=2002')
    )), true, 'mismatched seller identity remains losslessly represented in reconciliation evidence')
    const repaired1001 = mismatchRestart.getAllSourceRows().find((row) => row.sellerId === '1001')
    assert.equal(repaired1001.url, 'https://www.goofish.com/personal?userId=1001')
    assert.equal(repaired1001.status, 'pending')
    assert.equal(mismatchRestart.reconcileCanonicalSellerManifest(manifestPath, { expectedCount: 9 }).changed, false)

    if (requireCanonical) {
      const productionStoreDir = join(tempDir, 'production-reconciliation')
      mkdirSync(productionStoreDir, { recursive: true })
      const productionManifest = JSON.parse(readFileSync(productionManifestPath, 'utf8'))
      const legacyRows = productionManifest.sellerIds.slice(0, 9731).map((sellerId) => ({
        id: `legacy-${sellerId}`,
        sellerId,
        url: `https://www.goofish.com/personal?userId=${encodeURIComponent(sellerId)}`,
        source: 'installed-user-data-fixture'
      }))
      writeFileSync(join(productionStoreDir, 'seller-sources.json'), JSON.stringify(legacyRows))
      writeFileSync(join(productionStoreDir, 'seller-checkpoint-v3.json'), JSON.stringify({
        schemaVersion: 3,
        persistedAt: '2026-08-23T00:00:00.000Z',
        records: [{ id: legacyRows[0].id, schemaVersion: 3, status: 'completed', reasonCode: 'PRESERVED_LEGACY_PROGRESS' }]
      }))
      writeFileSync(join(productionStoreDir, 'xianyu-seller-crawl.json'), JSON.stringify({ sourceMode: 'canonical' }))
      process.env.XIANYU_SELLER_DATA_DIR = productionStoreDir
      process.env.XIANYU_SELLER_CANONICAL_MANIFEST = productionManifestPath
      const productionStore = await import(`../../src/main/seller-store.js?production-reconciliation=${Date.now()}`)
      const productionReport = productionStore.reconcileCanonicalSellerManifest(productionManifestPath, { expectedCount: 9977 })
      assert.equal(productionReport.changed, true)
      assert.deepEqual(productionReport.legacy, {
        total: 9731,
        matched: 9731,
        needsReview: 0,
        accounted: 9731
      }, 'all measured legacy seller-source rows must reconcile explicitly')
      assert.deepEqual(productionReport.canonical, {
        total: 9977,
        indexed: 9977,
        added: 246
      }, 'canonical-only sellers become explicit source-only pending rows')
      assert.equal(productionStore.getSellerEvidenceSummary().indexed, 9977)
      assert.equal(productionStore.getAllSourceRows().find((row) => row.sellerId === legacyRows[0].sellerId)?.status, 'completed', 'existing progress is preserved by seller ID')
      const secondPass = productionStore.reconcileCanonicalSellerManifest(productionManifestPath, { expectedCount: 9977 })
      assert.equal(secondPass.changed, false, 'the verified manifest hash anchors a one-time startup reconciliation')
      assert.equal(secondPass.manifest.sha256, productionManifest.sha256)
      assert.equal(productionStore.getSellerEvidenceSummary().indexed, 9977)
    }
  }
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  delete process.env.XIANYU_SELLER_CANONICAL_MANIFEST
  rmSync(tempDir, { recursive: true, force: true })
}

console.log('seller index regression passed')
