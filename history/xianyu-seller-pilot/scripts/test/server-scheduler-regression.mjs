import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDatabase } = require('../../server/db/database.js')
const { createServerScheduler } = require('../../server/jobs/scheduler.js')
const { createServerWorker } = require('../../server/jobs/db-worker.js')

function provider() {
  const sessions = new Set()
  return {
    name: 'scheduler-fixture', capabilities: { cdp: false, playwright: false, persistentProfile: true, remoteView: false },
    async health() { return { ok: true } },
    async openSession() { const session = { sessionId: `s-${sessions.size}` }; sessions.add(session.sessionId); return session },
    async getPage(session) { return { sessionId: session.sessionId } },
    async navigate(_page, url) { return { ok: true, url } },
    async evaluate() { return { items: [{ id: 'scheduled-item', title: 'Scheduled fixture', price: 300 }] } },
    async closeSession(session) { sessions.delete(session.sessionId); return { ok: true } }
  }
}

async function main() {
  const db = createDatabase()
  db.upsertBrowserProfile({ id: 'profile-1', provider: 'fake', vendorProfileId: 'fixture', label: 'Fixture' })
  const schedule = db.createSchedule({ name: 'Every fixture', jobType: 'market_snapshot', payload: { keyword: 'scheduled' }, profileId: 'profile-1', intervalMs: 1000, nextRunAt: new Date(Date.now() - 1).toISOString() })
  const scheduler = createServerScheduler({ db, tickMs: 20 })
  const secondScheduler = createServerScheduler({ db, tickMs: 20 })
  const concurrentTicks = await Promise.all([scheduler.tick(), secondScheduler.tick()])
  assert.equal(concurrentTicks.flat().length, 1)
  const worker = createServerWorker({ db, provider: provider(), workerId: 'scheduler-worker', pollMs: 20 })
  await scheduler.start(); await worker.start()
  const deadline = Date.now() + 5000
  let generated = db.listJobs()
  while (Date.now() < deadline && !generated.length) { await new Promise(resolve => setTimeout(resolve, 30)); generated = db.listJobs() }
  assert.equal(generated.length, 1)
  while (Date.now() < deadline && db.getJob(generated[0].id).status === 'pending') { await new Promise(resolve => setTimeout(resolve, 30)) }
  assert.equal(db.getJob(generated[0].id).status, 'succeeded')
  assert.equal(db.getSchedule(schedule.id).last_run_at != null, true)
  assert.ok(db.listEvents({ after: 0 }).some(event => event.eventType === 'schedule.enqueued'))
  await scheduler.stop(); await secondScheduler.stop(); await worker.stop(); db.close()
  console.log('server-scheduler-regression: PASS (due schedule -> job -> worker result)')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
