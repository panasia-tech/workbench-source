import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(scriptDir, '../..')
const pricesPath = join(appRoot, 'src/renderer/src/views/Prices.vue')
const historyPath = join(appRoot, 'src/renderer/src/views/PriceHistory.vue')
const snapshotComponentPath = join(appRoot, 'src/renderer/src/components/MarketSnapshotDialog.vue')
const routerPath = join(appRoot, 'src/renderer/src/router.js')
const consolePath = join(appRoot, 'src/renderer/src/views/Console.vue')
const preloadPath = join(appRoot, 'src/preload/index.js')
const mainPath = join(appRoot, 'src/main/index.js')

function sourceText(path) {
  return readFileSync(path, 'utf8')
}

function assertStaticContracts() {
  const prices = sourceText(pricesPath)
  const history = sourceText(historyPath)
  const snapshot = sourceText(snapshotComponentPath)
  const router = sourceText(routerPath)
  const consoleView = sourceText(consolePath)
  const preload = sourceText(preloadPath)
  const main = sourceText(mainPath)
  const pricesTemplate = prices.split(/<script\s+setup[^>]*>/i, 1)[0]
  const historyTemplate = history.split(/<script\s+setup[^>]*>/i, 1)[0]
  const pricesRows = pricesTemplate.split(/<(?:MarketSnapshotDialog|el-dialog)\b/i, 1)[0]
  const historyRows = historyTemplate.split(/<(?:MarketSnapshotDialog|el-dialog)\b/i, 1)[0]

  assert.doesNotMatch(prices, /queryTaskResults|tasks:results|price-history-table|price-history-scroll-container|history-table-scroll|运行历史（每次尝试）/, 'current-task page must not embed the history surface')
  assert.match(prices, /(?:router\.push\(['"]\/prices\/history|prices\/history|运行历史)/, 'current-task page must expose the sole history entry')
  assert.match(history, /(?:queryTaskResults|tasks:results)/, 'history page must consume tasks:results')
  assert.match(history, /data-testid=["']price-history-table["']|history-list/, 'history page must have a stable list selector')
  assert.match(router, /PriceHistory/, 'router must register the dedicated history view')
  assert.match(router, /path:\s*['"]prices\/history['"][\s\S]*component:\s*PriceHistory/, 'router must expose /prices/history')
  assert.match(consoleView, /(?:route\.path\s*===\s*['"]\/prices\/history['"]|route\.path\.startsWith\(['"]\/prices['"]\))/, 'history must remain in the market-record domain')

  assert.match(prices, /(?:查看详情)/, 'current rows must expose one detail entry')
  assert.equal((pricesRows.match(/查看详情/g) || []).length, 1, 'current rows must have one visible detail action')
  assert.equal((historyRows.match(/查看详情/g) || []).length, 1, 'history rows must have one visible detail action')
  for (const source of [pricesRows, historyRows]) {
    assert.doesNotMatch(source, /@click="(?:rejectAiAndSearch|approveAiReview|editTaskCorrection|writeBackApi|suggestAliases|viewSnapshot|viewBreakdown)\b/, 'processing actions must stay inside row detail')
    assert.doesNotMatch(source, /overflow-x\s*:\s*(?:auto|scroll)/, 'C-end surface must not expose horizontal dragging')
    assert.match(source, /采购价对比|class=["']comparison["']|priceComparison/, 'purchase comparison must remain the merged status surface')
    assert.match(source, /(?:comparisonReason|priceComparison|\.reason)/, 'purchase comparison reason/value must remain visible')
    for (const duplicate of ['SPU 详情', '任务SPU编码', '别称', '来源', '状态', 'API 当前销售价', 'API 操作']) {
      assert.doesNotMatch(source, new RegExp(`label=["']${duplicate}`), `duplicate ${duplicate} column must not return`)
    }
  }

  assert.match(prices, /const queueKind = ref\('all'\)/, 'all must be the default primary group')
  assert.match(prices, /key: 'all',[\s\S]*key: 'failed',[\s\S]*key: 'pending',[\s\S]*key: 'success',[\s\S]*key: 'review'/, 'the primary navigation must contain exactly the five display groups')
  assert.match(prices, /label: '全部'/, 'all primary group label must stay visible')
  assert.match(prices, /label: '待采集'/, 'pending primary group label must stay visible')
  assert.match(prices, /label: '成功'/, 'success primary group label must stay visible')
  assert.match(prices, /label: '(?:失败|异常)'/, 'failed/anomaly primary group label must stay visible')
  assert.match(prices, /label: '待复核'/, 'review primary group label must stay visible')
  assert.match(prices, /key: 'purchase_100_119',[\s\S]*label: '未满120%'/, 'the under-120 price band must use the persisted comparison key')
  assert.match(prices, /key: 'purchase_120_plus',[\s\S]*label: '120%档'/, 'the 120% price band must use the persisted comparison key')
  assert.match(prices, /key: 'purchase_150_plus',[\s\S]*label: '150%档'/, 'the 150% price band must use the persisted comparison key')
  assert.match(prices, /key: 'purchase_200_plus',[\s\S]*label: '200%档'/, 'the 200% price band must use the persisted comparison key')
  assert.match(prices, /priceBandCounts\[item\.key\]\s*\|\|\s*0/, 'price-band buttons must render the main-process aggregate count')
  assert.match(prices, /priceBandCounts\.value\s*=\s*res\.priceBandCounts\s*\|\|\s*\{\}/, 'queue DTO price-band counts must be stored without client-side recounting')
  for (const [key, text] of [['purchase_100_119', '未满120%'], ['purchase_120_plus', '120%档'], ['purchase_150_plus', '150%档'], ['purchase_200_plus', '200%档']]) {
    assert.match(history, new RegExp(`key:\\s*['"]${key}['"]`), `/prices/history must retain ${key}`)
    assert.match(history, new RegExp(text), `/prices/history must retain ${text}`)
  }

  const allSnapshot = `${prices}\n${history}\n${snapshot}`
  assert.match(allSnapshot, /snapshotEntries/, 'snapshot dialog must consume per-query snapshot entries')
  assert.match(allSnapshot, /entryId/, 'snapshot tabs must preserve explicit entry IDs when supplied')
  assert.match(allSnapshot, /(?:entryId.*query|query.*entryId|snapshotBindingMatches)/s, 'snapshot/log binding must use entryId and/or query')
  assert.match(allSnapshot, /queryLogs/, 'snapshot dialog must consume persisted per-query logs')
  assert.match(allSnapshot, /(?:selectSnapshot\(|activeSnapshot|selectedEntry)/, 'snapshot dialog must switch by selected query entry')
  assert.match(allSnapshot, /getTaskSnapshot\(entry\.path\)|getTaskSnapshot\(\s*[^)]*path/, 'snapshot reads must use the selected entry path only')
  assert.match(allSnapshot, /!entry\.path|!\s*entry\.path|!activeEntry(?:\.value)?\.path|path\s*===[^\n]*null/, 'missing snapshot paths must be explicit')
  assert.match(allSnapshot, /diagnostic(?:Snapshot)?Html|诊断快照|快照诊断|原始网页没有可读取的快照|没有保存原始网页快照/, 'missing or unreadable snapshots must render a diagnostic document')
  assert.match(allSnapshot, /log_only|logOnly|仅日志|只保存了该关键词的判定日志/, 'log-only entries must remain visible')

  assert.match(preload, /queryTaskResults:\s*\(params\)\s*=>\s*ipcRenderer\.invoke\('tasks:results', params\)/, 'preload must bridge queryTaskResults to tasks:results')
  assert.match(main, /ipcMain\.handle\('tasks:results', \(_e, params\) => taskStore\.getRunResults\(params \|\| \{\}\)\)/, 'main must delegate tasks:results to getRunResults')
}

function task({ id, model, account }) {
  return {
    id,
    name: `测试显示器 ${model}`,
    brand: '测试品牌',
    model,
    category: '显示器',
    keyword: model,
    referencePrice: 400,
    referencePriceStatus: 'valid',
    referencePriceReason: '',
    searchKeywords: [model],
    account
  }
}

function fixtureRows() {
  const now = new Date().toISOString()
  const row = ({ id, model, price = null, status = 'success', reason = '', aiReviewStatus = '', account = `fixture-${id}-account`, searchKeywords = [model], snapshotPath, snapshotQuery, snapshotPaths, snapshotEntries, queryLogs, priceBreakdown }) => ({
    id,
    runId: `${id}-run`,
    taskId: `${id}-task`,
    name: `测试显示器 ${model}`,
    brand: '测试品牌',
    model,
    category: '显示器',
    keyword: model,
    account,
    at: now,
    price,
    referencePrice: 400,
    referencePriceStatus: 'valid',
    referencePriceReason: '',
    source: 'market_quote',
    status,
    reason,
    ...(aiReviewStatus ? { aiReviewStatus } : {}),
    searchKeywords,
    ...(snapshotPath ? { snapshotPath } : {}),
    ...(snapshotQuery ? { snapshotQuery } : {}),
    ...(snapshotPaths ? { snapshotPaths } : {}),
    ...(snapshotEntries ? { snapshotEntries } : {}),
    ...(queryLogs ? { queryLogs } : {}),
    ...(priceBreakdown ? { priceBreakdown } : {})
  })
  return [
    row({
      id: 'fixture-under-120',
      model: 'M470',
      price: 470,
      searchKeywords: ['M470', 'M470 显示器'],
      snapshotEntries: [
        { entryId: 'm470-q1', query: 'M470', path: '/fixture/m470-1.html', snapshotStatus: 'saved', cardCount: 1 },
        { entryId: 'm470-q2', query: 'M470 显示器', path: '/fixture/m470-2.html', snapshotStatus: 'saved', cardCount: 2 }
      ],
      queryLogs: [
        { entryId: 'm470-q1', query: 'M470', cards: 1, accepted: 1, blocked: 0, nonTarget: 0, lowPrice: 0, marked: 0, markReasonCodes: ['accepted'] },
        { entryId: 'm470-q2', query: 'M470 显示器', cards: 2, accepted: 2, blocked: 0, nonTarget: 0, lowPrice: 0, marked: 0, markReasonCodes: ['accepted'] }
      ]
    }),
    {
      id: 'fixture-success-row',
      runId: 'fixture-success-run',
      taskId: 'fixture-success-task',
      name: '测试显示器 M550',
      brand: '测试品牌',
      model: 'M550',
      category: '显示器',
      keyword: 'M550',
      account: 'fixture-success-account',
      at: now,
      price: 550,
      referencePrice: 400,
      referencePriceStatus: 'valid',
      referencePriceReason: '',
      priceComparison: {
        marketPrice: 550,
        purchasePrice: 400,
        ratio: 1.375,
        ratioPercent: 137.5,
        markupPercent: 37.5,
        difference: 150,
        key: 'purchase_120_plus',
        label: '达到采购价120%',
        reason: '行情价为采购价的 137.5%'
      },
      priceBand: 'purchase_120_plus',
      priceRatioPercent: 137.5,
      priceMarkupPercent: 37.5,
      priceReason: '行情价为采购价的 137.5%',
      source: 'market_quote',
      status: 'success',
      reason: '',
      searchKeywords: ['M550', 'M550 电竞版', 'M550 二手'],
      snapshotEntries: [
        { entryId: 'm550-q1', query: 'M550', path: '/fixture/m550-1.html', snapshotStatus: 'saved', cardCount: 2 },
        { entryId: 'm550-q2', query: 'M550 电竞版', path: '/fixture/m550-2.html', snapshotStatus: 'saved', cardCount: 1 },
        { entryId: 'm550-q3', query: 'M550 二手', path: null, snapshotStatus: 'log_only', error: '导航失败' }
      ],
      queryLogs: [
        { entryId: 'm550-q1', query: 'M550', cards: 2, accepted: 1, blocked: 1, nonTarget: 0, lowPrice: 0, marked: 1, markReasonCodes: ['blacklist'], cardSummaries: [{ title: 'M550 正确商品', itemId: 'm550-1' }] },
        { entryId: 'm550-q2', query: 'M550 电竞版', cards: 1, accepted: 1, blocked: 0, nonTarget: 0, lowPrice: 0, marked: 0, markReasonCodes: ['accepted'], cardSummaries: [{ title: 'M550 电竞版', itemId: 'm550-2' }] },
        { entryId: 'm550-q3', query: 'M550 二手', cards: 0, accepted: 0, blocked: 0, nonTarget: 0, lowPrice: 0, marked: 0, error: '导航失败' }
      ]
    },
    row({ id: 'fixture-150-row', model: 'M600', price: 600 }),
    row({ id: 'fixture-200-row', model: 'M800', price: 800 }),
    row({
      id: 'fixture-mixed-legacy',
      model: 'MMIXED',
      searchKeywords: ['MMIXED', 'MMIXED alias', 'MMIXED code'],
      snapshotPath: '/fixture/mixed-primary.html',
      snapshotQuery: 'MMIXED',
      snapshotPaths: ['/fixture/mixed-primary.html', '/fixture/mixed-secondary.html', '/fixture/mixed-third.html'],
      snapshotEntries: [],
      queryLogs: [
        { entryId: 'mixed-log-2', query: 'MMIXED alias', snapshotStatus: 'log_only', logOnly: true, error: '旧版日志没有绑定路径' },
        { entryId: 'mixed-log-3', query: 'MMIXED code', snapshotStatus: 'log_only', logOnly: true, error: '旧版日志没有绑定路径' }
      ]
    }),
    {
      id: 'fixture-below-purchase-row',
      runId: 'fixture-below-purchase-run',
      taskId: 'fixture-below-purchase-task',
      name: '测试显示器 M350',
      brand: '测试品牌',
      model: 'M350',
      category: '显示器',
      keyword: 'M350',
      account: 'fixture-error-account',
      at: now,
      price: 350,
      referencePrice: 400,
      referencePriceStatus: 'valid',
      referencePriceReason: '',
      priceComparison: {
        marketPrice: 350,
        purchasePrice: 400,
        ratio: 0.875,
        ratioPercent: 87.5,
        markupPercent: -12.5,
        difference: -50,
        key: 'below_purchase_price',
        label: '低于采购价',
        reason: '行情价 ¥350 低于采购价 ¥400（差 ¥50.00）'
      },
      priceBand: 'below_purchase_price',
      priceRatioPercent: 87.5,
      priceMarkupPercent: -12.5,
      priceReason: '行情价 ¥350 低于采购价 ¥400（差 ¥50.00）',
      source: 'market_quote',
      status: 'invalid_price',
      reason: '行情价低于采购价'
    },
    row({ id: 'fixture-empty-row', model: 'MEMPTY', status: 'empty', reason: '没有找到在售商品' }),
    row({ id: 'fixture-fail-row', model: 'MFAIL', status: 'fail', reason: '页面加载失败' }),
    row({ id: 'fixture-invalid-row', model: 'MINVALID', price: 90, status: 'invalid_price', reason: '低于最低有效价格' }),
    row({ id: 'fixture-risk-row', model: 'MRISK', status: 'risk_control', reason: '账号触发风控暂停' }),
    row({ id: 'fixture-ai-candidate-row', model: 'MAICAND', status: 'empty', reason: 'AI 候选待处理', aiReviewStatus: 'candidate' }),
    row({ id: 'fixture-ai-review-row', model: 'MAINREVIEW', status: 'fail', reason: 'AI 结果待人工确认', aiReviewStatus: 'needs_review' })
  ]
}

function writeGuiFixture(directory) {
  const targetDir = resolve(directory)
  const targetFile = join(targetDir, 'xianyu-task-center.json')
  mkdirSync(targetDir, { recursive: true })
  if (existsSync(targetFile)) throw new Error(`refusing to overwrite existing fixture: ${targetFile}`)
  const rows = fixtureRows()
  const tasks = rows.map((row) => ({
    id: row.taskId,
    name: row.name,
    brand: row.brand,
    model: row.model,
    category: row.category,
    keyword: row.keyword,
    referencePrice: row.referencePrice,
    referencePriceStatus: row.referencePriceStatus,
    referencePriceReason: row.referencePriceReason,
    searchKeywords: row.searchKeywords || [row.keyword],
    ...(row.aiReviewStatus ? { aiReviewStatus: row.aiReviewStatus } : {})
  }))
  tasks.push({
    id: 'fixture-pending-task',
    name: '测试显示器 MPENDING',
    brand: '测试品牌',
    model: 'MPENDING',
    category: '显示器',
    keyword: 'MPENDING',
    referencePrice: 400,
    referencePriceStatus: 'valid',
    referencePriceReason: '',
    searchKeywords: ['MPENDING']
  })
  writeFileSync(targetFile, JSON.stringify({
    activeCollectionId: 'fixture-collection',
    collections: [{ id: 'fixture-collection', name: '采购价对比回归', tasks }],
    settings: {},
    runs: rows.map((row) => ({ id: row.runId, collectionId: 'fixture-collection', status: 'done', total: 1, startedAt: row.at, finishedAt: row.at })),
    runResults: rows,
    lastImport: null,
    wmsSkus: [],
    wmsSyncedAt: null
  }, null, 2))
  console.log(`GUI fixture written: ${targetFile}`)
}

function assertSnapshotFixtures() {
  const rows = fixtureRows()
  const twoQuery = rows.find((row) => row.id === 'fixture-under-120')
  const threeQuery = rows.find((row) => row.id === 'fixture-success-row')
  const mixedLegacy = rows.find((row) => row.id === 'fixture-mixed-legacy')
  assert.equal(twoQuery.snapshotEntries.length, 2, 'GUI fixture must include a two-query snapshot task')
  assert.equal(threeQuery.snapshotEntries.length, 3, 'GUI fixture must include a three-query snapshot task')
  assert.equal(mixedLegacy.snapshotEntries.length, 0, 'mixed legacy fixture must exercise an empty snapshotEntries array')
  assert.equal(mixedLegacy.snapshotPaths.length, 3, 'mixed legacy fixture must retain every scalar/array path')
  assert.deepEqual(mixedLegacy.queryLogs.filter((log) => log.logOnly).map((log) => log.query), ['MMIXED alias', 'MMIXED code'])
  for (const row of [twoQuery, threeQuery]) {
    assert.equal(row.snapshotEntries.length, row.queryLogs.length, 'every fixture query must have a matching snapshot entry and log')
    row.snapshotEntries.forEach((entry, index) => {
      assert.equal(entry.query, row.queryLogs[index].query, 'fixture query logs must bind to the same explicit query')
      assert.equal(entry.entryId, row.queryLogs[index].entryId, 'fixture query logs must bind to the same explicit entryId')
      assert.ok(Object.prototype.hasOwnProperty.call(entry, 'path'), 'fixture entry must carry an explicit path, including null failures')
    })
  }
}

async function runTaskStoreRegression() {
  const dataDir = mkdtempSync(join(tmpdir(), 'xianyu-price-comparison-display-'))
  process.env.XIAN_YU_TASK_STORE_DIR = dataDir
  try {
    const store = await import(`../../src/main/task-store.js?price-display=${Date.now()}`)
    const firstRun = store.startRun({ total: 1, source: 'display-regression' })
    store.recordRunResult(firstRun.id, task({ id: 'task-success', model: 'M550', account: 'Account-Alpha' }), {
      price: 550,
      status: 'success',
      source: 'market_quote',
      account: 'Account-Alpha'
    })

    // A second run for the same task is deliberate: the history table counts
    // attempts, rather than collapsing audit evidence by taskId.
    const retryRun = store.startRun({ total: 1, source: 'display-regression' })
    store.recordRunResult(retryRun.id, task({ id: 'task-success', model: 'M550', account: 'Account-Alpha' }), {
      price: 560,
      status: 'success',
      source: 'market_quote',
      account: 'Account-Alpha'
    })

    const errorRun = store.startRun({ total: 1, source: 'display-regression' })
    store.recordRunResult(errorRun.id, task({ id: 'task-error', model: 'M350', account: 'Account-Beta' }), {
      price: 350,
      status: 'invalid_price',
      source: 'market_quote',
      account: 'Account-Beta',
      reason: '行情价低于采购价'
    })

    const all = store.getRunResults({ page: 1, pageSize: 50 })
    assert.equal(all.total, 3, 'total must count duplicate run-result attempts')
    assert.deepEqual(all.items.map((row) => row.price), [350, 560, 550], 'run-result rows must stay newest-first')

    const success = all.items.find((row) => row.price === 550)
    assert.ok(success, 'the 550 success row must be returned')
    assert.equal(success.priceComparison.key, 'purchase_120_plus')
    assert.equal(success.priceComparison.ratioPercent, 137.5)
    assert.equal(success.priceComparison.markupPercent, 37.5)
    assert.match(success.priceComparison.reason, /137\.5%/)

    const lowPrice = store.getRunResults({ status: 'invalid_price', page: 1, pageSize: 50 })
    assert.equal(lowPrice.total, 1)
    assert.equal(lowPrice.items[0].priceComparison.key, 'below_purchase_price')
    assert.match(lowPrice.items[0].priceComparison.reason, /低于采购价/)

    const success120 = store.getRunResults({ group: 'success', priceBand: 'purchase_120_plus', page: 1, pageSize: 50 })
    assert.equal(success120.total, 2, 'success price-band filtering must use priceComparison.key')
    assert.deepEqual(success120.items.map((row) => row.price), [560, 550])
    assert.equal(store.getRunResults({ group: 'attention', page: 1, pageSize: 50 }).total, 1, 'attention must aggregate invalid-price history')
    assert.equal(store.getRunResults({ group: 'pending', page: 1, pageSize: 50 }).total, 0, 'pending must not fabricate a history row')

    const accountResults = store.getRunResults({ q: 'account-alpha', page: 1, pageSize: 50 })
    assert.equal(accountResults.total, 2, 'q must retain account matching and duplicate attempts')
    assert.deepEqual(accountResults.items.map((row) => row.price), [560, 550])
    assert.equal(store.getRunResults({ q: 'account-beta', status: 'invalid_price', page: 1, pageSize: 50 }).total, 1)
    assert.equal(store.getRunResults({ q: 'does-not-exist', page: 1, pageSize: 50 }).total, 0)

    const pageOne = store.getRunResults({ page: 1, pageSize: 2 })
    const pageTwo = store.getRunResults({ page: 2, pageSize: 2 })
    assert.deepEqual(pageOne.items.map((row) => row.price), [350, 560])
    assert.deepEqual(pageTwo.items.map((row) => row.price), [550])
    assert.equal(pageOne.total, 3)
    assert.equal(pageTwo.total, 3)
    console.log('price comparison display regression: passed (bridge contract + 550/400 success + below-purchase error + attempt history)')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.XIAN_YU_TASK_STORE_DIR
  }
}

assertStaticContracts()
assertSnapshotFixtures()
const fixtureFlag = process.argv.indexOf('--write-gui-fixture')
if (fixtureFlag >= 0) {
  const directory = process.argv[fixtureFlag + 1]
  if (!directory || directory.startsWith('--')) throw new Error('usage: node price-comparison-display-regression.mjs --write-gui-fixture <isolated-dir>')
  writeGuiFixture(directory)
} else {
  await runTaskStoreRegression()
}
