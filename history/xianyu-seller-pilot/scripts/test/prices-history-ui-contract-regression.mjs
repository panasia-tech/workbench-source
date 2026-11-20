import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseVueSfc } from '@vue/compiler-sfc'

/**
 * Static contract for the C-end market-record surfaces.
 *
 * The product deliberately has two surfaces, rather than two tables on one
 * page: /prices is the current-task list and /prices/history is the read-only
 * run-history list. This test is strict about that information architecture,
 * while keeping the implementation details of the Vue row component flexible.
 */

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(scriptDir, '../..')
const pricesPath = join(appRoot, 'src/renderer/src/views/Prices.vue')
const historyPath = join(appRoot, 'src/renderer/src/views/PriceHistory.vue')
const snapshotPath = join(appRoot, 'src/renderer/src/components/MarketSnapshotDialog.vue')
const routerPath = join(appRoot, 'src/renderer/src/router.js')
const consolePath = join(appRoot, 'src/renderer/src/views/Console.vue')
const fixturePath = join(scriptDir, 'fixtures/prices-history-ui-contract.json')

const read = (path) => readFileSync(path, 'utf8')
const prices = read(pricesPath)
const history = read(historyPath)
const snapshot = read(snapshotPath)
const router = read(routerPath)
const consoleView = read(consolePath)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const historySfc = parseVueSfc(history, { filename: historyPath })
assert.equal(historySfc.errors.length, 0, `PriceHistory.vue must have balanced Vue template tags: ${historySfc.errors.map((error) => error.message || String(error)).join('; ')}`)

function template(source) {
  return source.split(/<script\s+setup[^>]*>/i, 1)[0]
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length
}

function assertSingleDetailEntry(source, label) {
  const view = template(source)
  const rowSurface = view.split(/<(?:MarketSnapshotDialog|el-dialog)\b/i, 1)[0]
  assert.match(rowSurface, /查看详情/, `${label} must expose a single user-facing detail entry`)
  assert.equal(count(rowSurface, /查看详情/g), 1, `${label} must not repeat the detail action in every feature column`)
  assert.doesNotMatch(
    rowSurface,
    /@click="(?:rejectAiAndSearch|approveAiReview|editTaskCorrection|writeBackApi|suggestAliases|viewSnapshot|viewBreakdown)\b/,
    `${label} must not flatten processing actions into the row`
  )
}

function assertPriceBands(source, label) {
  for (const [key, text] of [
    ['purchase_100_119', '未满120%'],
    ['purchase_120_plus', '120%档'],
    ['purchase_150_plus', '150%档'],
    ['purchase_200_plus', '200%档']
  ]) {
    assert.match(source, new RegExp(`key:\\s*['"]${key}['"]`), `${label} must retain ${key} filtering`)
    assert.match(source, new RegExp(text), `${label} must retain the ${text} label`)
  }
}

function assertCompactComparison(source, label) {
  assert.match(source, /采购价对比|class=["']comparison["']|priceComparison/, `${label} must retain the merged purchase-price comparison`)
  assert.match(source, /(?:comparisonReason|priceComparison)/, `${label} must show the comparison reason/value`)
  assert.match(source, /(?:historyStatusLabel|statusLabel|statusLabels|queueLabel|taskDecision)/, `${label} must keep status in the comparison/detail summary`)
  for (const duplicate of ['SPU 详情', '任务SPU编码', '别称', '来源', '状态', 'API 当前销售价', 'API 操作']) {
    assert.doesNotMatch(template(source), new RegExp(`label=["']${duplicate}`), `${label} must not add a duplicate ${duplicate} column`)
  }
}

function assertPrimarySurface() {
  const view = template(prices)
  assert.match(view, /行情(?:记录|任务)/, 'primary surface must retain a neutral market-record title')
  assert.match(view, /当前任务/, 'primary surface must explain that it is the current-task surface')
  assert.match(prices, /(?:router\.push\(['"]\/prices\/history|prices\/history|运行历史)/, 'primary surface must expose the sole history entry')

  for (const embeddedHistory of [
    'price-history-table',
    'price-history-scroll-container',
    'history-table-scroll',
    '运行历史（每次尝试）',
    'queryTaskResults',
    'tasks:results'
  ]) {
    const escaped = embeddedHistory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.doesNotMatch(prices, new RegExp(escaped), `/prices must not embed ${embeddedHistory}`)
  }
  assertPriceBands(prices, '/prices')
  assertCompactComparison(prices, '/prices')
  assertSingleDetailEntry(prices, '/prices')
  assert.doesNotMatch(prices, /overflow-x\s*:\s*(?:auto|scroll)/, '/prices must not expose horizontal dragging')
}

function assertHistorySurface() {
  const view = template(history)
  assert.match(history, /(?:queryTaskResults|tasks:results)/, 'history must consume the existing run-result source')
  assert.match(history, /(?:list|historyRows|items)/, 'history must render retained run-result rows')
  assert.match(view, /运行历史/, 'history surface must identify retained runs')
  assert.match(view, /只读|仅查看|查看详情/, 'history surface must be read-only')
  assert.match(history, /data-testid=["']price-history-table["']|history-list/, 'history must provide a stable list selector')
  assert.match(history, /writebackAudit|history-writeback-audit/, 'history must expose the latest API writeback audit when present')
  assert.match(history, /API 销售价[\s\S]*API 建议价[\s\S]*成本价[\s\S]*行情观察价/, 'history must keep API/current-cost/market prices visibly separated')
  assertPriceBands(history, '/prices/history')
  assertCompactComparison(history, '/prices/history')
  assertSingleDetailEntry(history, '/prices/history')
  assert.doesNotMatch(history, /overflow-x\s*:\s*(?:auto|scroll)/, '/prices/history must not expose horizontal dragging')
  assert.doesNotMatch(history, /(?:rejectAiAndSearch|approveAiReview|editTaskCorrection|writeBackApi|suggestAliases|requeueFailed)\s*\(/, 'history must not expose mutable processing actions')
}

function assertRoutingSurface() {
  assert.match(router, /import\s+PriceHistory\s+from\s+['"]\.\/views\/PriceHistory\.vue['"]/, 'router must register the dedicated history view')
  assert.match(router, /path:\s*['"]prices\/history['"][\s\S]*component:\s*PriceHistory/, 'router must expose /prices/history')
  assert.match(consoleView, /(?:route\.path\s*===\s*['"]\/prices\/history['"]|route\.path\.startsWith\(['"]\/prices['"]\))/, 'console must keep history under the market-record domain')
  assert.match(consoleView, /['"]\/prices\/history['"][\s\S]*['"](?:\/prices|行情记录)['"]|startsWith\(['"]\/prices['"]\)/, 'history must keep the /prices menu active')
}

function assertSnapshotContract() {
  const all = `${prices}\n${history}\n${snapshot}`
  assert.match(all, /snapshotEntries/, 'shared details must expose per-query snapshot entries')
  assert.match(all, /queryLogs/, 'shared details must expose persisted per-query logs')
  assert.match(all, /entryId/, 'snapshot/log binding must retain explicit entry IDs')
  assert.match(all, /entry\.query|snapshotQuery\(|query\s*:/, 'snapshot/log binding must retain explicit query names')
  assert.match(all, /(?:entryId.*query|query.*entryId|snapshotBindingMatches)/s, 'snapshot/log binding must support entryId/query matching')
  assert.match(all, /!entry\.path|!\s*entry\.path|!activeEntry(?:\.value)?\.path|path\s*===[^\n]*null/, 'a null snapshot path must be a first-class state')
  assert.match(all, /getTaskSnapshot\(entry\.path\)|getTaskSnapshot\(\s*[^)]*path/, 'saved details must read the selected entry path only')
  assert.match(all, /diagnostic(?:Snapshot)?Html|诊断快照|快照诊断|原始网页没有可读取的快照|没有保存原始网页快照/, 'missing/unreadable snapshots must produce a diagnostic document')
  assert.match(all, /log_only|logOnly|仅日志|只保存了该关键词的判定日志/, 'log-only entries must remain visible as diagnostics')
  assert.match(all, /selectSnapshot\(|(?:activeSnapshot|activeEntry|selectedEntry|indexActive)|function select\(/, 'details must switch by selected query, not an implicit array position')
}

function bindLogsByEntryOrQuery(entries, logs) {
  return entries.map((entry) => logs.find((log) => (
    entry.entryId && log.entryId && entry.entryId === log.entryId
  )) || logs.find((log) => (
    entry.query && log.query && entry.query === log.query
  )) || null)
}

function assertFixtureContract() {
  assert.deepEqual(fixture.surfaces, {
    primaryPath: '/prices',
    historyPath: '/prices/history',
    primaryContainsHistory: false,
    historyIsOnlyHistorySurface: true
  })
  assert.deepEqual(fixture.primaryFilters, ['全部', '待采集', '成功', '异常', '待复核'])
  assert.deepEqual(fixture.priceBands, ['未满120%', '120%档', '150%档', '200%档'])
  assert.equal(fixture.primaryRows.length, 2)
  assert.ok(fixture.primaryRows.every((row) => row.detailEntry === '查看详情'))
  assert.equal(fixture.historyRows.length, 3)

  const pg = fixture.historyRows.find((row) => row.taskId === 'fixture-pg248qp')
  assert.ok(pg, 'PG248QP must remain the three-query diagnostic fixture')
  assert.equal(pg.snapshotEntries.length, 3)
  assert.equal(pg.queryLogs.length, 3)
  assert.equal(new Set(pg.snapshotEntries.map((entry) => entry.entryId)).size, 3)
  assert.equal(bindLogsByEntryOrQuery(pg.snapshotEntries, pg.queryLogs).filter(Boolean).length, 3)
  assert.ok(pg.snapshotEntries.every((entry) => pg.queryLogs.some((log) => log.entryId === entry.entryId && log.query === entry.query)))

  const twoQuery = fixture.historyRows.find((row) => row.taskId === 'fixture-m470')
  assert.equal(twoQuery.snapshotEntries.length, 2, 'two-query fixture must remain covered')
  assert.deepEqual(bindLogsByEntryOrQuery(twoQuery.snapshotEntries, twoQuery.queryLogs).map((log) => log.query), ['M470', 'M470 显示器'])

  const error = fixture.historyRows.find((row) => row.taskId === 'fixture-m350')
  const errorLog = bindLogsByEntryOrQuery(error.snapshotEntries, error.queryLogs)[0]
  assert.equal(error.snapshotEntries[0].path, null, 'error fixture must cover an unavailable original snapshot')
  assert.equal(error.snapshotEntries[0].entryId, errorLog.entryId)
  assert.match(`${error.snapshotEntries[0].error} ${errorLog.error} ${errorLog.reasonCodes}`, /行情价低于采购价|below_purchase_price/)

  const mixed = fixture.mixedLegacyRow
  assert.deepEqual([...new Set([...(mixed.snapshotPaths || []), mixed.snapshotPath].filter(Boolean))], ['legacy-first.html', 'legacy-second.html', 'legacy-primary.html'])
  assert.equal(mixed.queryLogs.filter((log) => log.logOnly).length, 2, 'legacy log-only entries must not be discarded')
}

assertRoutingSurface()
assertPrimarySurface()
assertHistorySurface()
assertSnapshotContract()
assertFixtureContract()
console.log('prices history UI contract regression: PASS (C-end two-surface flow, one detail entry, merged comparison, explicit snapshot diagnostics)')
