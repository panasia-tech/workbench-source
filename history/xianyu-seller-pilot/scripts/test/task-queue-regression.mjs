import assert from 'node:assert/strict'
import { buildQueueView, queueRetryMode, retryableQueue } from '../../src/main/task-queue.js'
import { searchQueriesForTask } from '../../src/main/search-queries.js'

const tasks = [
  { id: 'success', name: '成功型号', brand: '飞利浦', model: '25M2N32', enabled: true },
  { id: 'empty', name: '无在售型号', brand: '飞利浦', model: '27 M1N5500ZR', enabled: true, aiCorrectionStatus: 'done' },
  { id: 'fail', name: '失败型号', brand: '创维', model: 'F25-G37F', enabled: true, aiCorrectionStatus: 'failed' },
  { id: 'invalid', name: '错误价格型号', brand: 'SANC', model: 'G4', enabled: true },
  { id: 'risk', name: '风控型号', brand: '飞利浦', model: '242M8', enabled: true },
  { id: 'pending', name: '未采集型号', brand: 'AOC', model: '24G2', enabled: true },
  { id: 'review', name: 'AI候选待确认', brand: '华硕', model: 'VG259CMS', enabled: true, aiReviewStatus: 'candidate' },
  { id: 'review-needs', name: 'AI复核待处理', brand: '华硕', model: 'VG279QM', enabled: true, aiReviewStatus: 'needs_review' }
]
const runs = [{ id: 'run-1', collectionId: 'collection-1' }]
const runResults = [
  { runId: 'run-1', taskId: 'success', status: 'success', price: 300 },
  { runId: 'run-1', taskId: 'empty', status: 'empty', reason: '没有在售' },
  { runId: 'run-1', taskId: 'fail', status: 'fail', reason: '页面超时' },
  { runId: 'run-1', taskId: 'invalid', status: 'invalid_price', price: 39 },
  { runId: 'run-1', taskId: 'risk', status: 'risk_control', reason: '请求频繁' }
]

const all = buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'all' })
assert.deepEqual(all.counts, { all: 8, anomaly: 3, pending: 3, success: 1, empty: 1, fail: 1, invalid_price: 1, ai_review: 2, risk_control: 1 })
assert.deepEqual(all.groupCounts, { all: 8, failed: 4, pending: 1, success: 1, review: 2 })
assert.deepEqual(all.priceBandCounts, {
  purchase_100_119: 0,
  purchase_120_plus: 0,
  purchase_150_plus: 0,
  purchase_200_plus: 0
})
assert.equal(all.groupCounts.failed + all.groupCounts.pending + all.groupCounts.success + all.groupCounts.review, all.groupCounts.all)
assert.equal(all.items.filter((row) => row.queueKind === 'pending').length, 3)
assert.equal(all.items.filter((row) => row.displayGroup === 'pending').length, all.groupCounts.pending)
assert.equal(all.items.filter((row) => row.displayGroup === 'success').length, all.groupCounts.success)
assert.equal(all.items.filter((row) => row.displayGroup === 'failed').length, all.groupCounts.failed)
assert.equal(all.items.filter((row) => row.displayGroup === 'review').length, all.groupCounts.review)
assert.equal(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'failed' }).total, 4)
assert.equal(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'review' }).total, 2)
assert.equal(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'attention' }).total, 6)
assert.equal(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'success' }).total, 1)
assert.equal(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'pending' }).total, 1)
assert.deepEqual(
  new Set(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'attention' }).items.map((row) => row.id)),
  new Set(['empty', 'fail', 'invalid', 'risk', 'review', 'review-needs'])
)
assert.equal(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'anomaly' }).total, 3)
assert.equal(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'risk_control' }).items[0].name, '风控型号')
assert.equal(all.aiCorrectionCount, 2)
assert.equal(all.aiReviewCount, 2)
assert.equal(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'ai_correction' }).total, 2)
assert.equal(buildQueueView({ tasks, runs, runResults, collectionId: 'collection-1', kind: 'ai_review' }).total, 2)
assert.equal(retryableQueue('anomaly'), true)
assert.equal(retryableQueue('failed'), true)
assert.equal(retryableQueue('ai_correction'), true)
assert.equal(retryableQueue('risk_control'), false)
assert.equal(queueRetryMode('empty').strategy, 'broad')

// Price-band counters describe only the newest result for every current
// successful task. They must not be affected by queue filters, search terms,
// paging, non-success results, or history attempts that were superseded.
const priceBandTasks = [
  { id: 'under', name: '未满120', model: 'UNDER' },
  { id: 'at120', name: '120档', model: 'AT120' },
  { id: 'at150', name: '150档', model: 'AT150' },
  { id: 'at200', name: '200档', model: 'AT200' },
  { id: 'failed-band', name: '异常价格', model: 'FAILED' },
  { id: 'missing-band', name: '缺少价格档', model: 'MISSING' }
]
const priceBandRuns = [
  { id: 'price-old', collectionId: 'price-bands' },
  { id: 'price-new', collectionId: 'price-bands' }
]
const priceBandResult = (runId, taskId, status, key, at) => ({
  runId,
  taskId,
  status,
  at,
  ...(key ? { priceComparison: { key } } : {})
})
const priceBandResults = [
  priceBandResult('price-old', 'under', 'success', 'purchase_200_plus', '2026-08-20T00:00:00.000Z'),
  priceBandResult('price-new', 'under', 'success', 'purchase_100_119', '2026-08-21T00:00:00.000Z'),
  priceBandResult('price-new', 'at120', 'success', 'purchase_120_plus', '2026-08-21T00:00:00.000Z'),
  priceBandResult('price-new', 'at150', 'success', 'purchase_150_plus', '2026-08-21T00:00:00.000Z'),
  priceBandResult('price-new', 'at200', 'success', 'purchase_200_plus', '2026-08-21T00:00:00.000Z'),
  priceBandResult('price-new', 'failed-band', 'invalid_price', 'purchase_200_plus', '2026-08-21T00:00:00.000Z'),
  priceBandResult('price-new', 'missing-band', 'success', null, '2026-08-21T00:00:00.000Z')
]
const priceBandView = buildQueueView({
  tasks: priceBandTasks,
  runs: priceBandRuns,
  runResults: priceBandResults,
  collectionId: 'price-bands',
  kind: 'success',
  q: 'does-not-match',
  page: 2,
  pageSize: 1
})
assert.equal(priceBandView.total, 0, 'current queue filters must not affect aggregate price-band counts')
assert.deepEqual(priceBandView.priceBandCounts, {
  purchase_100_119: 1,
  purchase_120_plus: 1,
  purchase_150_plus: 1,
  purchase_200_plus: 1
})

// 历史版本的 runResults 使用 UUID，当前 Excel 任务可能使用内容 hash；别名仍应把异常找回来。
const legacyView = buildQueueView({
  tasks: [{ id: 'hash-id', name: '华硕 VG259CMS', brand: '华硕', model: 'VG259CMS', aliases: ['华硕 G259CMS', 'G259CMS'] }],
  runs: [{ id: 'legacy-run', collectionId: 'collection-1' }],
  runResults: [{ runId: 'legacy-run', taskId: 'old-uuid', name: '华硕 G259CMS', brand: '华硕', model: 'G259CMS', status: 'empty', reason: '历史无在售' }],
  collectionId: 'collection-1', kind: 'anomaly'
})
assert.equal(legacyView.total, 1)
assert.equal(legacyView.items[0].lastReason, '历史无在售')
assert.equal(legacyView.items[0].attempts, 1)

const mixedIdView = buildQueueView({
  tasks: [{ id: 'hash-id', name: '华硕 VG259CMS', brand: '华硕', model: 'VG259CMS', aliases: ['华硕 G259CMS'] }],
  runs: [{ id: 'old-run', collectionId: 'collection-1' }, { id: 'new-run', collectionId: 'collection-1' }],
  runResults: [
    { runId: 'new-run', taskId: 'old-uuid', name: '华硕 G259CMS', brand: '华硕', model: 'G259CMS', status: 'empty', reason: '新日志', at: '2026-08-22T16:33:41.643Z' },
    { runId: 'old-run', taskId: 'hash-id', name: '华硕 G259CMS', brand: '华硕', model: 'G259CMS', status: 'success', price: 500, at: '2026-08-22T10:45:13.209Z' }
  ],
  collectionId: 'collection-1', kind: 'all'
})
assert.equal(mixedIdView.items[0].lastReason, '新日志')
assert.equal(mixedIdView.items[0].lastStatus, 'empty')
assert.equal(mixedIdView.items[0].model, 'VG259CMS')
assert.equal(mixedIdView.items[0].lastResultModel, 'G259CMS')

const monitorTask = { brand: '飞利浦', model: '27 M1N5500ZR', category: '显示器', aliases: ['飞利浦 27M1N5500ZR'] }
const normal = searchQueriesForTask(monitorTask)
const broad = searchQueriesForTask(monitorTask, { strategy: 'broad' })
assert.deepEqual(normal, ['27 M1N5500ZR', '飞利浦 27 M1N5500ZR'])
assert.ok(broad.length > normal.length)
assert.ok(broad.includes('27M1N5500ZR'))
assert.ok(broad.includes('飞利浦 27M1N5500ZR'))

const canonicalTask = {
  brand: 'KTC',
  model: '27GS820',
  category: '显示器',
  searchKeywords: ['27GS820', 'KTC 27GS820', 'G27P']
}
assert.deepEqual(
  searchQueriesForTask(canonicalTask),
  canonicalTask.searchKeywords,
  '正常队列必须逐项消费 task-store 已归一化的实际查询数组'
)

console.log('task queue regression: passed (one latest queue per task; price-band counts use current successes only; abnormal searches broadened)')
