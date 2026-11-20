import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDatabase } = require('../../server/db/database.js')
const { createFakeProvider } = require('../../server/browser/fake-provider.js')
const { createServerWorker } = require('../../server/jobs/db-worker.js')
const {
  WORKBENCH_SCHEDULE_ID,
  SELLER_SCHEDULE_ID,
  nextDailyRun,
  nextWeeklyRun,
  syncSellerSchedule,
  syncWorkbenchSchedule
} = require('../../server/jobs/recurring-schedules.js')

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for recurring schedule children')
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-recurring-schedule-'))
  const db = createDatabase({ filename: path.join(tempDir, 'server.sqlite') })
  const now = new Date('2026-08-31T01:00:00.000Z') // 09:00 Asia/Shanghai

  db.upsertBrowserProfile({ id: 'profile-recurring-1', provider: 'fake', vendorProfileId: 'fixture-1', label: 'Fixture 1' })
  db.upsertBrowserProfile({ id: 'profile-recurring-2', provider: 'fake', vendorProfileId: 'fixture-2', label: 'Fixture 2' })
  db.createWorkbenchCollection({ id: 'collection-recurring', sourceFile: 'recurring.xlsx', sheetName: '任务', tasks: [
    { id: 'task-recurring-1', brand: '品牌', model: '型号一', name: '型号一', searchKeywords: ['型号一'] },
    { id: 'task-recurring-2', brand: '品牌', model: '型号二', name: '型号二', searchKeywords: ['型号二'] }
  ] })
  db.upsertSellerSources([
    { id: 'seller-recurring-1', sellerId: 'seller-recurring-1', url: 'https://www.goofish.com/user/recurring-1', sellerName: '卖家一' }
  ])

  const daily = syncWorkbenchSchedule(db, { dailyEnabled: true, dailyTime: '10:30' }, { now, forceNext: true })
  assert.equal(daily.id, WORKBENCH_SCHEDULE_ID)
  assert.equal(daily.enabled, true)
  assert.equal(daily.job_type, 'workbench_schedule')
  assert.equal(daily.profile_id, null)
  assert.equal(daily.next_run_at, nextDailyRun(now, '10:30').toISOString())
  const preserved = syncWorkbenchSchedule(db, { dailyEnabled: true, dailyTime: '18:00' }, { now: new Date(now.getTime() + 3600000) })
  assert.equal(preserved.next_run_at, daily.next_run_at, 'restart sync must preserve a durable due time')

  const weekly = syncSellerSchedule(db, { weeklyEnabled: true, weeklyDay: 1, weeklyTime: '11:00' }, { now, forceNext: true })
  assert.equal(weekly.id, SELLER_SCHEDULE_ID)
  assert.equal(weekly.enabled, true)
  assert.equal(weekly.job_type, 'seller_schedule')
  assert.equal(weekly.next_run_at, nextWeeklyRun(now, 1, '11:00').toISOString())
  assert.throws(() => syncSellerSchedule(db, { weeklyEnabled: true, timezone: 'UTC' }, { now, forceNext: true }), /Asia\/Shanghai/)

  // Force both system schedules due.  They enqueue profile-less parent jobs;
  // the worker then expands them into child jobs round-robin across profiles.
  const due = new Date('2026-08-31T02:00:00.000Z')
  db.upsertSchedule({ id: WORKBENCH_SCHEDULE_ID, name: daily.name, jobType: 'workbench_schedule', enabled: true, intervalMs: 86400000, nextRunAt: new Date(due.getTime() - 1).toISOString(), payload: { kind: 'workbench' } })
  db.upsertSchedule({ id: SELLER_SCHEDULE_ID, name: weekly.name, jobType: 'seller_schedule', enabled: true, intervalMs: 604800000, nextRunAt: new Date(due.getTime() - 1).toISOString(), payload: { kind: 'seller' } })
  const enqueued = db.enqueueDueSchedules(due)
  assert.equal(enqueued.length, 2)
  assert.equal(enqueued.every(item => item.job.profile_id == null), true)

  const worker = createServerWorker({
    db,
    provider: createFakeProvider({ fixture: {
      items: [{ id: 'fixture-recurring', title: '结果', price: 128 }],
      evidence: {
        firstPageExpected: { active: 1, sold: 0 },
        expectedTrusted: { active: true, sold: true },
        itemIds: { active: ['fixture-recurring'], sold: [] }
      }
    } }),
    workerId: 'recurring-worker',
    pollMs: 10,
    leaseMs: 1000
  })
  await worker.start()
  await waitFor(() => db.listWorkbenchResults({ page: 1, pageSize: 20 }).total === 2 && db.getSellerSource('seller-recurring-1').status === 'completed')
  await worker.stop()
  assert.equal(db.listWorkbenchResults({ page: 1, pageSize: 20 }).total, 2)
  assert.equal(db.getSellerSource('seller-recurring-1').status, 'completed')
  assert.equal(db.listJobs({ limit: 100 }).filter(job => ['workbench_schedule', 'seller_schedule'].includes(job.type)).every(job => job.status === 'succeeded'), true)
  assert.equal(db.listSchedules({ limit: 10 }).filter(row => row.id === WORKBENCH_SCHEDULE_ID || row.id === SELLER_SCHEDULE_ID).length, 2)

  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
  console.log('server-recurring-schedule-regression: PASS (settings -> durable schedule -> parent job -> round-robin child jobs)')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
