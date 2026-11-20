import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { createPriceCandidatePreview, selectPriceCandidate } from '../../src/main/price-candidate.js'

const dataDir = mkdtempSync(join(tmpdir(), 'xianyu-price-preview-'))
process.env.XIAN_YU_TASK_STORE_DIR = dataDir

try {
  const store = await import(`../../src/main/task-store.js?price-preview=${Date.now()}`)
  const run = store.startRun({ total: 7 })
  const cases = [
    [80, 'below_minimum'],
    [119.9, 'purchase_100_119'],
    [120, 'purchase_120_plus'],
    [149.9, 'purchase_120_plus'],
    [150, 'purchase_150_plus'],
    [199.9, 'purchase_150_plus'],
    [200, 'purchase_200_plus']
  ]
  for (const [price, key] of cases) {
    const row = store.recordRunResult(run.id, {
      id: `preview-${price}`,
      name: `预览-${price}`,
      brand: '测试',
      model: `M${price}`,
      category: '显示器',
      referencePrice: 100
    }, { price, status: 'success', source: 'market_quote' })
    assert.equal(row.priceComparison.key, key, `${price} should retain preview band`)
  }

  const listed = store.getRunResults({ page: 1, pageSize: 20 }).items
  assert.equal(listed.length, cases.length)
  assert.equal(listed.find((row) => row.price === 80)?.priceComparison.label, '低于100元')
  assert.equal(listed.find((row) => row.price === 119.9)?.priceComparison.key, 'purchase_100_119')
  assert.equal(listed.find((row) => row.price === 120)?.priceComparison.label, '达到采购价120%')
  assert.equal(listed.find((row) => row.price === 149.9)?.priceComparison.key, 'purchase_120_plus')
  assert.equal(listed.find((row) => row.price === 150)?.priceComparison.ratioPercent, 150)
  assert.equal(listed.find((row) => row.price === 199.9)?.priceComparison.key, 'purchase_150_plus')
  assert.equal(listed.find((row) => row.price === 200)?.priceComparison.label, '达到采购价200%')

  const success120 = store.getRunResults({ group: 'success', priceBand: 'purchase_120_plus', page: 1, pageSize: 20 })
  assert.equal(success120.total, 2)
  assert.deepEqual(success120.items.map((row) => row.price), [149.9, 120])
  assert.equal(store.getRunResults({ group: 'success', priceBand: 'purchase_100_119', page: 1, pageSize: 20 }).total, 1)
  assert.equal(store.getRunResults({ group: 'success', priceBand: 'purchase_150_plus', page: 1, pageSize: 20 }).total, 2)
  assert.equal(store.getRunResults({ group: 'success', priceBand: 'purchase_200_plus', page: 1, pageSize: 20 }).total, 1)
  assert.equal(store.getRunResults({ group: 'pending', page: 1, pageSize: 20 }).total, 0, 'pending must not fabricate historical rows')

  // Historical result rows did not always persist referencePrice. The read
  // path must recover it from the imported task collection before classifying.
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['品牌', '型号', '采购价'],
    ['测试', '历史回填', 100]
  ])
  XLSX.utils.book_append_sheet(workbook, sheet, '行情任务')
  store.importSpreadsheet(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), '历史回填.xlsx')
  const importedTask = store.getTasks({ page: 1, pageSize: 1 }).items[0]
  const newerWorkbook = XLSX.utils.book_new()
  const newerSheet = XLSX.utils.aoa_to_sheet([
    ['品牌', '型号'],
    ['测试', '历史回填']
  ])
  XLSX.utils.book_append_sheet(newerWorkbook, newerSheet, '行情任务')
  store.importSpreadsheet(XLSX.write(newerWorkbook, { type: 'buffer', bookType: 'xlsx' }), '最新但缺采购价.xlsx')
  const newerTask = store.getTasks({ page: 1, pageSize: 1 }).items[0]
  store.applyTaskPatches([{ id: newerTask.id, aiReviewStatus: 'candidate', aiReviewReason: '等待人工确认' }])
  const fallbackRun = store.startRun({ total: 1 })
  store.recordRunResult(fallbackRun.id, {
    ...newerTask,
    // Simulate an old result writer that omitted the purchase price fields.
    referencePrice: undefined,
    referencePriceStatus: undefined,
    referencePriceReason: ''
  }, { price: 150, status: 'success', source: 'historical_result' })
  const fallbackRow = store.getRunResults({ page: 1, pageSize: 1 }).items[0]
  assert.equal(importedTask.referencePrice, 100)
  assert.equal(newerTask.referencePrice, null)
  assert.equal(fallbackRow.referencePrice, 100)
  assert.equal(fallbackRow.priceComparison.key, 'purchase_150_plus')
  assert.equal(store.getRunResults({ q: '历史回填', group: 'attention', page: 1, pageSize: 10 }).total, 1, 'current task AI state must promote the historical row to attention')
  assert.equal(store.getRunResults({ q: '历史回填', group: 'success', page: 1, pageSize: 10 }).total, 0)
  assert.equal(store.getRunResults({ q: '历史回填', group: 'success', priceBand: 'purchase_150_plus', page: 1, pageSize: 10 }).total, 0)
  console.log('price preview regression: passed (persisted comparison bands and reasons)')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

// The historical comparison bands above are display facts only.  The new
// policy preview keeps API prices separate and still requires explicit choice
// before a selected price can exist.
const candidateNow = Date.parse('2026-08-25T12:00:00.000Z')
const candidatePreview = createPriceCandidatePreview({
  spuCode: 'SPU-HISTORY',
  skuCode: 'SKU-HISTORY',
  costPrice: 100,
  apiCurrentSalePrice: 150,
  apiSuggestPrice: 200,
  marketObservations: [
    { id: 'one', price: 141, source: 'goofish', observedAt: new Date(candidateNow - 3_600_000).toISOString() },
    { id: 'two', price: 149, source: 'goofish', observedAt: new Date(candidateNow - 3_600_000).toISOString() },
    { id: 'three', price: 151, source: 'goofish', observedAt: new Date(candidateNow - 3_600_000).toISOString() },
  ],
}, { now: candidateNow })
assert.equal(candidatePreview.status, 'ready')
assert.equal(candidatePreview.market.median, 149)
assert.equal(candidatePreview.recommendationPrice, 150)
assert.equal(candidatePreview.facts.apiCurrentSalePrice, 150)
assert.equal(candidatePreview.facts.apiSuggestPrice, 200)
assert.equal(candidatePreview.market.sampleCount, 3)
assert.equal(Object.hasOwn(candidatePreview, 'selectedPrice'), false)
assert.throws(() => selectPriceCandidate(candidatePreview, { choice: 'recommendation' }), /显式确认/)
const confirmedCandidate = selectPriceCandidate(candidatePreview, {
  choice: 'market_median',
  confirmed: true,
  operatorId: 'history-test',
  selectedAt: candidateNow,
})
assert.equal(confirmedCandidate.selectedPrice, 150)
assert.equal(confirmedCandidate.selection.choice, 'market_median')
assert.match(confirmedCandidate.selectionIdempotencyKey, /price-policy-v1:150$/)
assert.equal(Object.hasOwn(candidatePreview, 'selectedPrice'), false)

console.log('price preview policy compatibility: passed (display bands remain facts)')
