import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDatabase } = require('../../server/db/database.js')
const { createServerWorker, createServerWorkerPool } = require('../../server/jobs/db-worker.js')
const { BrowserProviderError } = require('../../server/browser/provider.js')

function fixtureProvider({ failFirstOpen = false } = {}) {
  const sessions = new Set()
  const activeProfiles = new Set()
  let sameProfileOverlap = false
  let failed = false
  return {
    name: 'fixture-worker',
    capabilities: { cdp: false, playwright: false, persistentProfile: true, remoteView: false },
    async health() { return { ok: true, provider: 'fixture-worker' } },
    async openSession(profile = {}) {
      const profileId = String(profile.id || profile.profileId || '').trim()
      if (activeProfiles.has(profileId)) sameProfileOverlap = true
      activeProfiles.add(profileId)
      if (failFirstOpen && !failed) { failed = true; activeProfiles.delete(profileId); throw new BrowserProviderError('temporary CDP outage', { code: 'cdp_unavailable', retryable: true }) }
      await new Promise(resolve => setTimeout(resolve, 30))
      const session = { sessionId: `worker-session-${sessions.size + 1}`, profileId }; sessions.add(session.sessionId); return session
    },
    async getPage(session) { if (!sessions.has(session.sessionId)) throw new Error('session closed'); return { sessionId: session.sessionId, url: '' } },
    async navigate(page, url) { page.url = url; return { ok: true, url } },
    async evaluate(_page, expression) {
      if (expression === 'window.__sellerFixture') return { evidence: { firstPageExpected: { active: 1, sold: 1 }, expectedTrusted: { active: true, sold: true }, itemIds: { active: ['active-1'], sold: ['sold-1'] } }, items: [{ itemId: 'active-1', status: 'active' }, { itemId: 'sold-1', status: 'sold' }] }
      return { items: [{ id: 'market-1', title: 'Fixture monitor', price: 300 }, { id: 'market-2', title: 'Fixture monitor', price: 420 }] }
    },
    async closeSession(session) { sessions.delete(session.sessionId); activeProfiles.delete(session.profileId); return { ok: true } },
    get sameProfileOverlap() { return sameProfileOverlap }
  }
}

async function waitForTerminal(db, ids) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const jobs = ids.map(id => db.getJob(id))
    if (jobs.every(job => ['succeeded', 'failed', 'cancelled'].includes(job?.status))) return jobs
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('worker jobs did not reach terminal state')
}

async function main() {
  const db = createDatabase()
  db.upsertBrowserProfile({ id: 'profile-1', provider: 'fake', vendorProfileId: 'fixture-profile', label: 'Fixture' })
  db.upsertBrowserProfile({ id: 'profile-2', provider: 'fake', vendorProfileId: 'fixture-profile-2', label: 'Fixture 2' })
  const market = db.createJob({ type: 'market_snapshot', payload: { keyword: 'monitor' }, profileId: 'profile-1' })
  const seller = db.createJob({ type: 'seller_snapshot', payload: { sellerUrl: 'https://example.test/seller' }, profileId: 'profile-1' })
  const probe = db.createJob({ type: 'browser_probe', payload: { url: 'https://example.test' }, profileId: 'profile-1' })
  const missingProfile = db.createJob({ type: 'browser_probe', payload: { url: 'https://example.test' } })
  const worker = createServerWorker({ db, provider: fixtureProvider(), workerId: 'worker-fixture', pollMs: 20, leaseMs: 1000 })
  await worker.start()
  const jobs = await waitForTerminal(db, [market.id, seller.id, probe.id, missingProfile.id])
  await worker.stop()
  assert.equal(jobs[0].status, 'succeeded')
  assert.equal(jobs[1].status, 'succeeded')
  assert.equal(jobs[2].status, 'succeeded')
  assert.equal(jobs[3].status, 'failed')
  assert.equal(jobs[3].error_code, 'profile_required')
  assert.equal(db.listJobs().some(job => Object.hasOwn(job, 'lease_token')), false)
  const eventTypes = db.listEvents({ after: 0 }).map(event => event.eventType)
  assert.ok(eventTypes.includes('job.claimed'))
  assert.ok(eventTypes.includes('job.succeeded'))
  assert.ok(eventTypes.includes('job.failed'))

  const transient = db.createJob({ type: 'browser_probe', payload: { url: 'https://example.test/transient', maxAttempts: 2 }, profileId: 'profile-1' })
  const transientWorker = createServerWorker({ db, provider: fixtureProvider({ failFirstOpen: true }), workerId: 'worker-transient', pollMs: 20, leaseMs: 1000 })
  await transientWorker.start()
  const [transientJob] = await waitForTerminal(db, [transient.id])
  await transientWorker.stop()
  assert.equal(transientJob.status, 'succeeded')
  assert.equal(transientJob.attempt, 2)
  assert.ok(db.listEvents({ after: 0, jobId: transient.id }).some(event => event.eventType === 'job.retry_scheduled'))

  const parallelA = db.createJob({ type: 'browser_probe', payload: { url: 'https://example.test/profile-a' }, profileId: 'profile-1' })
  const parallelB = db.createJob({ type: 'browser_probe', payload: { url: 'https://example.test/profile-b' }, profileId: 'profile-2' })
  const sameProfileA = db.createJob({ type: 'browser_probe', payload: { url: 'https://example.test/profile-same-a' }, profileId: 'profile-1' })
  const sameProfileB = db.createJob({ type: 'browser_probe', payload: { url: 'https://example.test/profile-same-b' }, profileId: 'profile-1' })
  const poolProvider = fixtureProvider()
  const pool = createServerWorkerPool({ db, provider: poolProvider, concurrency: 2, workerId: 'worker-pool', pollMs: 10, leaseMs: 1000 })
  assert.equal(pool.workers.length, 2)
  await pool.start()
  const parallelJobs = await waitForTerminal(db, [parallelA.id, parallelB.id, sameProfileA.id, sameProfileB.id])
  await pool.stop()
  assert.equal(parallelJobs.every(job => job.status === 'succeeded'), true)
  assert.equal(poolProvider.sameProfileOverlap, false)

  const restarted = db.createJob({ type: 'browser_probe', payload: { url: 'https://example.test/restart' }, profileId: 'profile-1' })
  const workerAfterRestart = createServerWorker({ db, provider: fixtureProvider(), workerId: 'worker-after-restart', pollMs: 20, leaseMs: 1000 })
  await workerAfterRestart.start()
  const [restartedJob] = await waitForTerminal(db, [restarted.id])
  await workerAfterRestart.stop()
  assert.equal(restartedJob.status, 'succeeded')
  db.close()
  console.log('server-worker-regression: PASS (market/seller/probe/lease/restart)')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
