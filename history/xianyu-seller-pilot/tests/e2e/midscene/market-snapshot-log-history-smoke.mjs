import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Build an isolated task-store fixture for the market snapshot/log GUI path.
 *
 * This file is intentionally a deterministic fixture builder, not a fake GUI
 * runner. It emits the exact paths and expected evidence for the real C-end
 * path: /prices -> /prices/history -> one row detail -> per-query evidence.
 */

const queries = {
  pg248qp: ['PG248QP', 'ROG PG248QP', 'PG248QP 540Hz'],
  monitor: ['KTC H27T22', 'KTC H27T22 180Hz']
}

const capturedAt = '2026-08-25T05:10:00.000Z'
const pageUrl = (query) => `https://s.2.taobao.com/list/list.htm?q=${encodeURIComponent(query)}`

function card({ itemId = '', itemUrl = '', title, price, decision, reasonCode }) {
  const attrs = [
    'class="feeds-item-wrap"',
    itemId ? `data-item-id="${itemId}"` : '',
    itemUrl ? `data-item-url="${itemUrl}" href="${itemUrl}"` : '',
    decision ? `data-xianyu-decision="${decision}"` : '',
    reasonCode ? `data-xianyu-reason-code="${reasonCode}"` : ''
  ].filter(Boolean).join(' ')
  return `<a ${attrs}><span class="title">${title}</span><span class="price">¥${price}</span></a>`
}

function snapshotHtml(query, cards) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>行情快照 · ${query}</title></head><body><header data-query="${query}">搜索词：${query}</header><main class="search-container">${cards.map(card).join('')}</main></body></html>`
}

function entry({ query, path, cards, taskDecision = 'success', taskReason = '已完成商品 ID/链接判定' }) {
  const summaries = cards.map((item) => ({
    itemId: item.itemId || null,
    itemUrl: item.itemUrl || null,
    title: item.title,
    decision: item.decision || 'review',
    reasonCode: item.reasonCode || 'unmatchable_card'
  }))
  const reasonCodes = [...new Set(summaries.map((item) => item.reasonCode))]
  const accepted = summaries.filter((item) => item.reasonCode === 'accepted').length
  const blacklisted = summaries.filter((item) => item.reasonCode === 'blacklist').length
  const nonTarget = summaries.filter((item) => item.reasonCode === 'relevance').length
  const lowPrice = summaries.filter((item) => item.reasonCode === 'low_price').length
  return {
    query,
    path,
    pageUrl: pageUrl(query),
    capturedAt,
    snapshotStatus: 'captured',
    error: null,
    cards: summaries.length,
    passed: accepted,
    accepted,
    blacklisted,
    nonTarget,
    lowPrice,
    marked: blacklisted + nonTarget + lowPrice,
    markReasonCodes: reasonCodes,
    cardSummaries: summaries,
    titles: summaries.slice(0, 10).map((item) => item.title),
    links: summaries.slice(0, 10).map((item) => item.itemUrl).filter(Boolean),
    taskDecision,
    taskReason
  }
}

function queryLog(snapshotEntry) {
  return {
    entryId: snapshotEntry.entryId,
    query: snapshotEntry.query,
    snapshotStatus: snapshotEntry.snapshotStatus,
    error: snapshotEntry.error,
    cards: snapshotEntry.cards,
    accepted: snapshotEntry.accepted,
    blacklisted: snapshotEntry.blacklisted,
    nonTarget: snapshotEntry.nonTarget,
    lowPrice: snapshotEntry.lowPrice,
    marked: snapshotEntry.marked,
    reasonCodes: snapshotEntry.markReasonCodes,
    titles: snapshotEntry.titles,
    links: snapshotEntry.links,
    decisionSummary: snapshotEntry.taskReason
  }
}

function buildErrorRow() {
  const query = 'M350'
  const entryId = 'm350-q1'
  return {
    id: 'fixture-m350-result',
    runId: 'fixture-m350-run',
    taskId: 'fixture-m350',
    name: '测试显示器 M350',
    brand: '测试品牌',
    model: 'M350',
    category: '显示器',
    keyword: query,
    searchKeywords: [query],
    searchFieldLabels: ['搜索关键词1'],
    account: 'market-snapshot-fixture',
    at: capturedAt,
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
      reason: '行情价 ¥350 低于采购价 ¥400'
    },
    priceBand: 'below_purchase_price',
    priceRatioPercent: 87.5,
    priceMarkupPercent: -12.5,
    priceReason: '行情价 ¥350 低于采购价 ¥400',
    source: 'market_quote_fixture',
    status: 'invalid_price',
    reason: '行情价低于采购价',
    snapshotPath: null,
    snapshotQuery: query,
    snapshotPaths: [],
    snapshotEntries: [{
      entryId,
      query,
      path: null,
      pageUrl: pageUrl(query),
      capturedAt,
      snapshotStatus: 'unrecorded',
      error: '该次运行没有保存逐关键词快照',
      cards: 0,
      accepted: 0,
      marked: 0,
      reasonCodes: ['below_purchase_price']
    }],
    queryLogs: [{
      entryId,
      query,
      snapshotStatus: 'log_only',
      logOnly: true,
      error: '行情价低于采购价',
      cards: 0,
      accepted: 0,
      marked: 0,
      reasonCodes: ['below_purchase_price']
    }],
    taskDecision: { status: 'invalid_price', label: '错误价格', reason: '行情价低于采购价' },
    priceBreakdown: { queryResults: [{ query, cards: 0, priced: 0, snapshotPath: null }] }
  }
}

function buildCards(kind, queryIndex) {
  if (kind === 'pg248qp') {
    const acceptedId = `pg248qp-accepted-${queryIndex}`
    const acceptedUrl = `https://item.taobao.com/item.htm?id=${acceptedId}`
    return [
      { itemId: acceptedId, itemUrl: acceptedUrl, title: queryIndex === 0 ? '华硕 PG248QP 540Hz 正品显示器' : 'ROG PG248QP 型号变体 正品', price: 550, decision: 'accepted', reasonCode: 'accepted' },
      { itemId: `pg248qp-overlap-${queryIndex}`, itemUrl: `https://item.taobao.com/item.htm?id=pg248qp-overlap-${queryIndex}`, title: 'PG248QP 近似/重叠型号（精确 ID 不同）', price: 620, decision: 'accepted', reasonCode: 'accepted' },
      { itemId: `pg248qp-blacklist-${queryIndex}`, itemUrl: `https://item.taobao.com/item.htm?id=pg248qp-blacklist-${queryIndex}`, title: 'PG248QP 配件 含维修/拆机', price: 300, decision: 'blocked', reasonCode: 'blacklist' },
      { itemId: `pg248qp-other-${queryIndex}`, itemUrl: `https://item.taobao.com/item.htm?id=pg248qp-other-${queryIndex}`, title: '其他品牌 27英寸显示器', price: 500, decision: 'blocked', reasonCode: 'relevance' },
      { itemId: `pg248qp-low-${queryIndex}`, itemUrl: `https://item.taobao.com/item.htm?id=pg248qp-low-${queryIndex}`, title: 'PG248QP 低价故障机', price: 80, decision: 'blocked', reasonCode: 'low_price' },
      { itemId: '', itemUrl: '', title: 'PG248QP 无法解析商品 ID 的卡片', price: 550, decision: 'review', reasonCode: 'unmatchable_card' }
    ]
  }
  const acceptedId = `monitor-accepted-${queryIndex}`
  return [
    { itemId: acceptedId, itemUrl: `https://item.taobao.com/item.htm?id=${acceptedId}`, title: 'KTC H27T22 180Hz 正品显示器', price: 550, decision: 'accepted', reasonCode: 'accepted' },
    { itemId: `monitor-blacklist-${queryIndex}`, itemUrl: `https://item.taobao.com/item.htm?id=monitor-blacklist-${queryIndex}`, title: 'KTC H27T22 配件/维修', price: 300, decision: 'blocked', reasonCode: 'blacklist' },
    { itemId: `monitor-other-${queryIndex}`, itemUrl: `https://item.taobao.com/item.htm?id=monitor-other-${queryIndex}`, title: '其他型号显示器', price: 550, decision: 'blocked', reasonCode: 'relevance' },
    { itemId: `monitor-low-${queryIndex}`, itemUrl: `https://item.taobao.com/item.htm?id=monitor-low-${queryIndex}`, title: 'KTC H27T22 低价故障机', price: 80, decision: 'blocked', reasonCode: 'low_price' },
    { itemId: '', itemUrl: '', title: 'KTC H27T22 无法解析商品 ID 的卡片', price: 550, decision: 'review', reasonCode: 'unmatchable_card' }
  ]
}

function buildRow({ taskId, model, brand, queries: taskQueries, category = '显示器', price = 550, kind }) {
  const snapshotDir = resolve(process.env.__MARKET_SNAPSHOT_TARGET_DIR || '.')
  const entries = taskQueries.map((query, index) => {
    const cards = buildCards(kind, index)
    const path = join(snapshotDir, 'task-snapshots', `${taskId}-${index + 1}.html`)
    return entry({ query, path, cards })
  })
  const decisionMapByQuery = Object.fromEntries(entries.map((snapshotEntry) => [snapshotEntry.query, Object.fromEntries(snapshotEntry.cardSummaries.map((summary) => [summary.itemId || `url:${summary.itemUrl || summary.title}`, summary]))]))
  const logs = entries.map(queryLog)
  const at = capturedAt
  return {
    id: `${taskId}-result`,
    runId: `${taskId}-run`,
    taskId,
    name: `${brand} ${model}`,
    brand,
    model,
    category,
    keyword: taskQueries[0],
    searchKeywords: taskQueries,
    searchFieldLabels: taskQueries.map((_, index) => `搜索关键词${index + 1}`),
    account: 'market-snapshot-fixture',
    at,
    price,
    referencePrice: 400,
    referencePriceStatus: 'valid',
    referencePriceReason: '',
    priceComparison: {
      marketPrice: price,
      purchasePrice: 400,
      ratio: price / 400,
      ratioPercent: price / 4,
      markupPercent: price / 4 - 100,
      difference: price - 400,
      key: 'purchase_120_plus',
      label: '达到采购价120%',
      reason: `行情价为采购价的 ${price / 4}%`
    },
    priceBand: 'purchase_120_plus',
    priceRatioPercent: price / 4,
    priceMarkupPercent: price / 4 - 100,
    priceReason: `行情价为采购价的 ${price / 4}%`,
    source: 'market_quote_fixture',
    status: 'success',
    reason: '已完成抓取；采购价对比正常',
    snapshotPath: entries[0].path,
    snapshotQuery: entries[0].query,
    snapshotPaths: entries.map((snapshotEntry) => snapshotEntry.path),
    snapshotEntries: entries,
    queryLogs: logs,
    decisionMapByQuery,
    taskDecision: { status: 'success', label: '成功', reason: '全部关键词均已记录快照与判定日志' },
    purchasePriceFence: {
      reasonCode: 'purchase_price_fence',
      scope: 'task',
      message: '采购价围栏为任务级标记，统一作用于全部快照，不作为单卡片原因'
    },
    priceBreakdown: {
      queryResults: entries.map((snapshotEntry) => ({ query: snapshotEntry.query, cards: snapshotEntry.cards, priced: snapshotEntry.accepted, snapshotPath: snapshotEntry.path }))
    }
  }
}

function buildMixedLegacyRow(snapshotDir) {
  const snapshotPaths = [1, 2, 3].map((index) => join(snapshotDir, 'task-snapshots', `fixture-mixed-legacy-${index}.html`))
  return {
    id: 'fixture-mixed-legacy-result',
    runId: 'fixture-mixed-legacy-run',
    taskId: 'fixture-mixed-legacy',
    name: '测试显示器 MMIXED',
    brand: '测试品牌',
    model: 'MMIXED',
    category: '显示器',
    keyword: 'MMIXED',
    searchKeywords: ['MMIXED', 'MMIXED alias', 'MMIXED code'],
    searchFieldLabels: ['搜索关键词1', '搜索关键词2', '搜索关键词3'],
    account: 'market-snapshot-fixture',
    at: capturedAt,
    price: 550,
    status: 'success',
    reason: '旧版路径字段兼容回归',
    snapshotPath: snapshotPaths[0],
    snapshotQuery: 'MMIXED',
    snapshotPaths,
    snapshotEntries: [],
    queryLogs: [
      { entryId: 'fixture-mixed-log-2', query: 'MMIXED alias', snapshotStatus: 'log_only', logOnly: true, error: '旧版日志没有绑定路径' },
      { entryId: 'fixture-mixed-log-3', query: 'MMIXED code', snapshotStatus: 'log_only', logOnly: true, error: '旧版日志没有绑定路径' }
    ],
    priceBreakdown: { queryResults: ['MMIXED', 'MMIXED alias', 'MMIXED code'].map((query) => ({ query, cards: 0, priced: 0 })) }
  }
}

export function writeFixture(directory) {
  const target = resolve(directory)
  const storeFile = join(target, 'xianyu-task-center.json')
  if (existsSync(storeFile)) throw new Error(`refusing to overwrite existing task-store fixture: ${storeFile}`)
  mkdirSync(join(target, 'task-snapshots'), { recursive: true })
  process.env.__MARKET_SNAPSHOT_TARGET_DIR = target
  const pgRow = buildRow({ taskId: 'fixture-pg248qp', model: 'PG248QP', brand: '华硕', queries: queries.pg248qp, kind: 'pg248qp' })
  const monitorRow = buildRow({ taskId: 'fixture-monitor', model: 'H27T22', brand: 'KTC', queries: queries.monitor, kind: 'monitor' })
  const mixedLegacyRow = buildMixedLegacyRow(target)
  const errorRow = buildErrorRow()
  const rows = [pgRow, monitorRow, mixedLegacyRow, errorRow]
  for (const row of [pgRow, monitorRow]) {
    assert.equal(row.snapshotEntries.length, row.queryLogs.length, `${row.taskId} must retain one log per query`)
    for (const entry of row.snapshotEntries) {
      const log = row.queryLogs.find((candidate) => candidate.entryId === entry.entryId && candidate.query === entry.query)
      assert.ok(log, `${row.taskId} query ${entry.query} must bind by entryId and query`)
      assert.ok(Object.prototype.hasOwnProperty.call(entry, 'path'), `${row.taskId} entry must carry an explicit path`)
    }
  }
  assert.equal(errorRow.snapshotEntries[0].path, null, 'error row must preserve a null snapshot path')
  assert.equal(errorRow.queryLogs[0].logOnly, true, 'error row must preserve the log-only diagnostic')
  assert.equal(mixedLegacyRow.queryLogs.filter((log) => log.logOnly).length, 2, 'legacy row must preserve both named log-only entries')
  for (const row of rows) {
    for (const snapshotEntry of row.snapshotEntries) {
      if (!snapshotEntry.path) continue
      const cards = row.taskId === 'fixture-pg248qp' ? buildCards('pg248qp', row.snapshotEntries.indexOf(snapshotEntry)) : buildCards('monitor', row.snapshotEntries.indexOf(snapshotEntry))
      writeFileSync(snapshotEntry.path, snapshotHtml(snapshotEntry.query, cards), 'utf8')
      assert.ok(readFileSync(snapshotEntry.path, 'utf8').includes(`<title>行情快照 · ${snapshotEntry.query}</title>`), '每个可读 tab 必须对应自己的 HTML 标题')
    }
  }
  mixedLegacyRow.snapshotPaths.forEach((path, index) => {
    writeFileSync(path, snapshotHtml(`兼容快照 ${index + 1}`, []), 'utf8')
  })
  const tasks = rows.map((row) => ({
    id: row.taskId,
    name: row.name,
    brand: row.brand,
    model: row.model,
    category: row.category,
    keyword: row.keyword,
    searchKeywords: row.searchKeywords,
    searchFieldLabels: row.searchFieldLabels,
    referencePrice: row.referencePrice,
    referencePriceStatus: row.referencePriceStatus,
    enabled: true
  }))
  const payload = {
    activeCollectionId: 'market-snapshot-fixture-collection',
    collections: [{ id: 'market-snapshot-fixture-collection', name: '行情快照日志 GUI 回归', tasks }],
    settings: { blacklistKeywords: ['配件', '维修', '拆机'] },
    runs: rows.map((row) => ({ id: row.runId, collectionId: 'market-snapshot-fixture-collection', status: 'done', total: 1, success: 1, startedAt: row.at, finishedAt: row.at })),
    runResults: rows,
    lastImport: null,
    wmsSkus: [],
    wmsSyncedAt: null
  }
  writeFileSync(storeFile, JSON.stringify(payload, null, 2), 'utf8')
  const manifest = {
    fixtureDirectory: target,
    taskStore: storeFile,
    snapshotDirectory: join(target, 'task-snapshots'),
    tasks: rows.map((row) => ({
      taskId: row.taskId,
      queries: row.searchKeywords,
      snapshots: row.snapshotEntries.length
        ? row.snapshotEntries.map((snapshotEntry) => snapshotEntry.path).filter(Boolean)
        : [...new Set([...(row.snapshotPaths || []), row.snapshotPath].filter(Boolean))],
      queryLogs: row.queryLogs.length
    })),
    expected: {
      viewport: { width: 2048, height: 1152 },
      surfaces: {
        primaryPath: '/prices',
        historyPath: '/prices/history',
        primaryContainsHistory: false,
        historyIsOnlyHistorySurface: true
      },
      primary: { oneRowDetailEntry: '查看详情', priceBands: ['未满120%', '120%档', '150%档', '200%档'], horizontalScroll: false },
      history: { readOnly: true, requiredTestId: 'price-history-table', oneRowDetailEntry: '查看详情', horizontalScroll: false },
      dialog: '任务判定 + 采购价对比原因 + 逐关键词快照/日志',
      pg248qpReasonCodes: ['accepted', 'blacklist', 'relevance', 'low_price', 'unmatchable_card'],
      purchasePriceFenceScope: 'task',
      mixedLegacy: { paths: 3, namedLogOnly: 2, positionalQueryBinding: false },
      error: { taskId: 'fixture-m350', path: null, reason: '行情价低于采购价' }
    },
    guiStatus: 'FIXTURE ONLY: requires real Electron/Computer Use or Midscene click-through'
  }
  writeFileSync(join(target, 'market-snapshot-log-history-fixture.json'), JSON.stringify(manifest, null, 2), 'utf8')
  delete process.env.__MARKET_SNAPSHOT_TARGET_DIR
  return manifest
}

const flag = process.argv.indexOf('--write-gui-fixture')
const target = flag >= 0 ? process.argv[flag + 1] : mkdtempSync(join(tmpdir(), 'xianyu-market-snapshot-gui-'))
if (!target || target.startsWith('--')) throw new Error('usage: node market-snapshot-log-history-smoke.mjs --write-gui-fixture <isolated-dir>')
const manifest = writeFixture(target)
assert.equal(manifest.tasks.find((task) => task.taskId === 'fixture-pg248qp').queries.length, 3)
assert.equal(manifest.tasks.find((task) => task.taskId === 'fixture-monitor').queries.length, 2)
assert.equal(manifest.tasks.find((task) => task.taskId === 'fixture-m350').queries.length, 1)
assert.equal(manifest.expected.surfaces.historyPath, '/prices/history')
assert.equal(manifest.expected.error.path, null)
console.log(JSON.stringify(manifest, null, 2))
console.log('GUI smoke fixture: written; real desktop click-through is a separate gate')
