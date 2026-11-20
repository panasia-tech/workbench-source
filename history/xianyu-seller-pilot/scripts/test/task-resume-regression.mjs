import assert from 'node:assert/strict'
import { buildResumePlan } from '../../src/main/task-resume.js'

const tasks = [
  { id: 'a', name: '已成功' },
  { id: 'b', name: '低价错误' },
  { id: 'c', name: '风控时正在跑' },
  { id: 'd', name: '尚未开始' },
  { id: 'e', name: '失败后重试' }
]
const runs = [
  { id: 'run-latest', collectionId: 'collection-1', status: 'stopped', total: 5, finishedAt: '2026-08-22T07:00:00.000Z', reason: '检测到请求频繁' },
  { id: 'run-other', collectionId: 'collection-2', status: 'stopped', total: 5 }
]
const runResults = [
  { runId: 'run-latest', taskId: 'a', status: 'success' },
  { runId: 'run-latest', taskId: 'b', status: 'invalid_price' },
  { runId: 'run-latest', taskId: 'c', status: 'risk_control' },
  { runId: 'run-latest', taskId: 'e', status: 'fail' }
]

const plan = buildResumePlan({ collectionId: 'collection-1', tasks, runs, runResults })
assert.equal(plan.available, true)
assert.equal(plan.runId, 'run-latest')
assert.equal(plan.completedCount, 2)
assert.equal(plan.pendingCount, 3)
assert.equal(plan.nextTask, '风控时正在跑')
assert.deepEqual(plan.pendingTaskIds, ['c', 'd', 'e'])

const noResume = buildResumePlan({ collectionId: 'collection-1', tasks, runs: [], runResults: [] })
assert.equal(noResume.available, false)
assert.deepEqual(noResume.pendingTaskIds, [])

const completedFromHead = buildResumePlan({
  collectionId: 'collection-1',
  tasks,
  runs: [{ id: 'run-done', collectionId: 'collection-1', status: 'done', total: 5 }],
  runResults: []
})
assert.equal(completedFromHead.available, false, '从头开始的新一轮完成后，不应继续更早的旧断点')

console.log('task resume regression: passed (completed results skipped; risk/fail retried)')
