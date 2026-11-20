import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import XLSXPkg from 'xlsx'

const XLSX = XLSXPkg.default || XLSXPkg
const dataDir = mkdtempSync(join(tmpdir(), 'seller-evidence-'))
process.env.XIANYU_SELLER_DATA_DIR = dataDir
process.env.XIANYU_SELLER_CANONICAL_MANIFEST = join(dataDir, 'missing-manifest.json')

try {
  // The seller page is virtualized; exercise the pure evidence renderer with
  // a full 1,000-item result before touching durable storage.
  const schedulerSource = readFileSync(new URL('../../src/main/seller-scheduler.js', import.meta.url), 'utf8')
  const rendererStart = schedulerSource.indexOf('function escapeHtml')
  const rendererEnd = schedulerSource.indexOf('\nasync function captureSellerSnapshot')
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart, 'seller evidence renderer block is extractable')
  const rendererCode = schedulerSource.slice(rendererStart, rendererEnd).replace('export function buildSellerEvidenceHtml', 'function buildSellerEvidenceHtml')
  const { buildSellerEvidenceHtml } = new Function('businessSellerId', 'resolveAuthoritativeSellerName', `const SNAPSHOT_SECRET_PARAM = /token|signature|sig|session|auth|credential|secret|password|cookie|access[_-]?key/i; ${rendererCode}; return { buildSellerEvidenceHtml }`)(() => 'seller-evidence-001', ({ sourceSellerName = '', pageSellerName = '' } = {}) => String(sourceSellerName || pageSellerName || ''))
  const fullItems = Array.from({ length: 1000 }, (_, index) => ({
    itemId: `full-item-${index + 1}`,
    itemUrl: `/item?id=full-item-${index + 1}&token=redacted`,
    imageUrl: `/images/full-item-${index + 1}.jpg?session=redacted`,
    title: `完整商品 ${index + 1}`,
    price: index + 1,
    status: index % 2 ? 'sold' : 'active',
    category: index % 2 ? '已售分类' : '在售分类'
  }))
  const fullHtml = buildSellerEvidenceHtml({ sellerName: '证据卖家', items: fullItems, ok: true, evidence: { branches: { combined: { stopReason: 'expected_reached', expectedCount: 1000 } } } }, {
    source: { sellerId: 'seller-evidence-001', url: 'https://www.goofish.com/personal?userId=seller-evidence-001' },
    pageUrl: 'https://www.goofish.com/personal?userId=seller-evidence-001'
  })
  assert.match(fullHtml, /data-seller-item-count="1000"/)
  for (const item of fullItems) assert.match(fullHtml, new RegExp(item.itemId), `snapshot keeps ${item.itemId}`)
  assert.match(fullHtml, /https:\/\/www\.goofish\.com\/item\?id=full-item-1/)
  assert.match(fullHtml, /https:\/\/www\.goofish\.com\/images\/full-item-1\.jpg/)
  assert.match(fullHtml, /完整结果，已达到页面可信总数/)
  assert.doesNotMatch(fullHtml, /<script|javascript:|token=|session=/i, 'generated evidence has no executable or sensitive URL content')

  const partialHtml = buildSellerEvidenceHtml({ sellerName: '部分证据卖家', items: fullItems.slice(0, 3), ok: true, capped: true, evidence: { branches: { combined: { stopReason: 'platform_boundary', expectedCount: 1000, platformBoundaryReached: true } } } }, {
    source: { sellerId: 'seller-evidence-partial', url: 'https://www.goofish.com/personal?userId=seller-evidence-partial' },
    pageUrl: 'https://www.goofish.com/personal?userId=seller-evidence-partial'
  })
  assert.match(partialHtml, /部分证据，停止原因：platform_boundary；不得视为完成/)
  assert.doesNotMatch(partialHtml, /完整结果，已达到页面可信总数/)

  const store = await import(`../../src/main/seller-store.js?evidence=${Date.now()}`)
  const imported = store.importLinks('https://www.goofish.com/personal?userId=seller-evidence-001\n', 'seller-ids.txt')
  assert.equal(imported.added, 1)
  const source = store.getAllSourceRows()[0]
  const job = store.prepareRun({ cycleKey: 'evidence-cycle', trigger: 'test' })
  const claimed = store.claimNext(job.runId, 'account-evidence', 1, 'evidence-cycle')
  assert.equal(claimed.id, source.id)

  const snapshot = store.saveSellerSnapshot('<html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/"></head><body><script>window.token="secret"</script><object data="https://evil.example/payload"></object><embed src="https://evil.example/payload"><a href="https://www.goofish.com/personal?userId=seller-evidence-001&token=secret">seller-evidence-001</a><img src="/img.png?token=relative-secret" srcset="/a.png 1x, javascript:alert(1) 2x" style="background:url(https://www.goofish.com/a.png?token=secret)"><img src="data:image/png;base64,AA=="></body></html>', {
    runId: job.runId,
    sourceId: claimed.id,
    sellerId: claimed.sellerId,
    sellerName: '证据卖家',
    sourceUrl: claimed.url,
    attemptKey: claimed.currentAttempt.attemptKey,
    accountId: 'account-evidence',
    pageUrl: claimed.url,
    viewport: { width: 1200, height: 800 }
  })
  assert.equal(snapshot.snapshotId.length, 32)
  assert.equal(existsSync(snapshot.path), true)
  const sanitizedHtml = readFileSync(snapshot.path, 'utf8')
  assert.doesNotMatch(sanitizedHtml, /<script|<object|<embed|<base|http-equiv\s*=\s*["']?refresh|token=|javascript:/i, 'DOM snapshots strip executable code and sensitive URL params')
  assert.match(sanitizedHtml, /data:image\/png;base64,AA==/i, 'validated raster data URLs remain available for offline snapshot images')
  assert.equal(store.readSellerSnapshot({ snapshotId: snapshot.snapshotId }).url, snapshot.url)
  assert.equal(store.readSellerSnapshot({ path: snapshot.path }).snapshotId, snapshot.snapshotId, 'secure realpath returned by DTO remains readable')

  // Legacy metadata may contain fields that the current writer never emits;
  // reads must still expose only the allowlisted envelope.
  const metadataPath = `${snapshot.path.slice(0, -5)}.json`
  const legacyMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  writeFileSync(metadataPath, JSON.stringify({ ...legacyMetadata, cookie: 'legacy-cookie', customToken: 'DEMO_ONLY_REDACTED' }), 'utf8')
  const safeLegacySnapshot = store.readSellerSnapshot({ snapshotId: snapshot.snapshotId })
  assert.equal('cookie' in safeLegacySnapshot, false)
  assert.equal('customToken' in safeLegacySnapshot, false)

  const items = [
    { itemId: 'item-evidence-1', itemUrl: 'https://www.goofish.com/item?id=item-evidence-1&token=secret', title: '在售商品', status: 'active', price: 120 },
    { itemId: 'item-evidence-2', itemUrl: 'https://www.goofish.com/item?id=item-evidence-2', title: '已售商品', status: 'sold', price: 80 }
  ]
  assert.equal(store.appendItems(items, { runId: job.runId, source: claimed, snapshotId: snapshot.snapshotId }), 2)
  const legacyItem = { itemId: 'legacy-item-1', itemUrl: 'https://www.goofish.com/item?id=legacy-item-1&token=legacy-secret', title: '旧格式商品', status: 'active', sellerUrl: claimed.url, sellerId: claimed.sellerId, runId: 'legacy-run' }
  appendFileSync(store.getDataPaths().itemsPath, `${JSON.stringify(legacyItem)}\n`, 'utf8')
  const finalized = store.finalizeFormalAttempt(claimed.id, {
    accountId: 'account-evidence',
    cycleKey: 'evidence-cycle',
    status: 'completed',
    reasonCode: 'EVIDENCE_OK',
    sellerName: '证据卖家',
    itemCount: 2,
    activeCount: 1,
    soldCount: 1,
    evidence: { expected: { active: 1, sold: 1 }, itemIds: { active: ['item-evidence-1'], sold: ['item-evidence-2'] } },
    expected: { active: 1, sold: 1 },
    itemIds: { active: ['item-evidence-1'], sold: ['item-evidence-2'] },
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    snapshotPath: snapshot.path,
    snapshotCapturedAt: snapshot.capturedAt,
    snapshotBytes: snapshot.bytes
  })
  assert.equal(finalized.snapshotId, snapshot.snapshotId)
  assert.equal(finalized.attempts.at(-1).snapshotId, snapshot.snapshotId)

  // Explicit canonical migration must preserve the existing source ID. If the
  // source key were regenerated from the canonical URL, old item/snapshot
  // references would become orphaned even though the seller still exists.
  const manifestPath = join(dataDir, 'canonical.manifest.json')
  const manifestHash = createHash('sha256').update(claimed.sellerId).digest('hex')
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-24T00:00:00.000Z',
    count: 1,
    sha256: manifestHash,
    hashAlgorithm: 'sha256(sortedSellerIdsJoinedByNewline)',
    provenance: { label: 'seller-evidence-migration', sourcePath: 'test-fixture' },
    sellerIds: [claimed.sellerId]
  }), 'utf8')
  const priorSourceId = claimed.id
  store.importCanonicalSellerManifest(manifestPath, { expectedCount: 1 })
  assert.equal(store.getAllSourceRows()[0].id, priorSourceId, 'canonical migration preserves the stable source ID')
  appendFileSync(store.getDataPaths().itemsPath, `${JSON.stringify({
    observationId: 'orphan-observation-1',
    sourceId: 'old-source-1',
    itemId: 'orphan-item-1',
    itemUrl: 'https://www.goofish.com/item?id=orphan-item-1&token=orphan-secret',
    sellerUrl: claimed.url,
    sellerId: claimed.sellerId,
    title: '旧来源商品',
    status: 'active',
    runId: job.runId
  })}\n`, 'utf8')
  const orphanSnapshot = store.saveSellerSnapshot('<html><body>old source evidence</body></html>', {
    runId: job.runId,
    sourceId: 'old-source-1',
    sellerId: claimed.sellerId,
    sellerName: '证据卖家',
    attemptKey: 'old-source-attempt',
    capturedAt: '2026-08-24T00:00:01.000Z'
  })
  assert.equal(store.queryItems({ sourceId: claimed.id, pageSize: 10 }).total, 4, 'current source selector falls back to historical source IDs')
  assert.equal(store.querySellerSnapshots({ sourceId: claimed.id, pageSize: 10 }).total, 2, 'snapshot selector falls back to historical source IDs')

  const filtered = store.queryItems({ sellerId: claimed.sellerId, sourceId: claimed.id, runId: job.runId, snapshotId: snapshot.snapshotId, pageSize: 10 })
  assert.equal(filtered.tailLimited, false)
  assert.equal(filtered.total, 2)
  const legacyFiltered = store.queryItems({ sellerId: claimed.sellerId, sourceId: claimed.id, pageSize: 10 })
  assert.equal(legacyFiltered.total, 4, 'sourceId selector resolves legacy observations without sourceId')
  assert.equal(filtered.items.some((row) => row.sourceId === claimed.id), true)
  assert.equal(filtered.items.every((row) => !JSON.stringify(row).includes('secret')), true)
  assert.equal(store.querySellerSnapshots({ sellerId: claimed.sellerId, runId: job.runId }).total, 2)
  const detail = store.getSellerQueueDetail({ sellerId: claimed.sellerId })
  assert.equal(detail.ok, true)
  assert.equal(detail.items.length, 4)
  assert.equal(detail.snapshots.length, 2)
  assert.equal(detail.attempts.at(-1).snapshotId, snapshot.snapshotId)

  // The renderer uses the explicit `group` dimension. Exercise the durable
  // read model directly so the four UI cards cannot regress to a status-only
  // API that fails as soon as a card is clicked.
  const groupSummary = store.getSellerEvidenceSummary()
  assert.deepEqual(groupSummary.groupCounts, { all: 1, pending: 0, completed: 1, failed: 0 })
  const allGroupRows = store.querySellerMembership({ dimension: 'group', group: 'all', pageSize: 10 })
  const completedGroupRows = store.querySellerMembership({ dimension: 'group', group: 'completed', pageSize: 10 })
  assert.equal(allGroupRows.total, 1)
  assert.equal(completedGroupRows.total, 1)
  assert.equal(completedGroupRows.items[0].sellerId, claimed.sellerId)

  store.addEvent({ type: 'start', runId: job.runId, sellerId: claimed.sellerId, trigger: 'manual', at: '2026-08-24T00:00:00.000Z' })
  store.addEvent({ type: 'seller-done', runId: job.runId, sellerId: claimed.sellerId, outcome: 'completed', at: '2026-08-24T00:00:02.000Z' })
  assert.equal(store.queryEventHistory({ runId: job.runId }).total, 2)
  const runDetail = store.getSellerRunDetail(job.runId)
  assert.equal(runDetail.sellers.length, 1)
  assert.equal(runDetail.trigger, 'manual')
  assert.equal(runDetail.outcome, 'completed')
  const outputPath = join(dataDir, 'seller-detail.xlsx')
  const exported = store.exportSellerDetails({ filter: { dimension: 'indexed', status: null, q: '' }, outputPath })
  assert.equal(exported.sellerCount, 1)
  assert.equal(exported.itemCount, 4)
  assert.equal(exported.attemptCount, 1)
  assert.equal(exported.snapshotCount, 2)
  const workbook = XLSX.read(readFileSync(outputPath), { type: 'buffer' })
  assert.deepEqual(workbook.SheetNames, ['卖家汇总', '商品明细', '采集历史', '网页快照'])
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['商品明细']).length, 4)
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['商品明细']).some((row) => /token|secret/i.test(JSON.stringify(row))), false, 'Excel removes legacy sensitive item URL parameters')
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['网页快照']).length, 2)
  const originalSnapshot = readFileSync(snapshot.path)
  writeFileSync(snapshot.path, Buffer.concat([originalSnapshot, Buffer.from('tampered')]))
  assert.throws(() => store.readSellerSnapshot({ snapshotId: snapshot.snapshotId }), /校验失败|元数据无效/)
  writeFileSync(snapshot.path, originalSnapshot)
  const oversized = store.chunkSellerExportRows(Array.from({ length: 1_000_001 }, (_, index) => ({ index })))
  assert.deepEqual(oversized.map((chunk) => chunk.length), [999_999, 2], 'oversized sheets split without dropping rows')
  console.log('seller evidence regression: PASS')
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  delete process.env.XIANYU_SELLER_CANONICAL_MANIFEST
  rmSync(dataDir, { recursive: true, force: true })
}
