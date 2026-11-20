import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDatabase } = require('../../../server/db/database.js')
const { createAuthService } = require('../../../server/auth/auth-service.js')
const repo = path.resolve(path.join(import.meta.dirname, '../../..'))
const platformRoot = process.env.XIAN_YU_TEST_TMP || (process.platform === 'darwin'
  ? '/Volumes/ChatGPT/Codex-External/xianyu-server-smoke'
  : path.join('/var/tmp', 'xianyu-server-smoke'))
const evidenceRoot = process.env.XIAN_YU_EVIDENCE_ROOT || (process.platform === 'darwin'
  ? '/Volumes/ChatGPT/Codex-External/xianyu-server-evidence'
  : path.join('/var/tmp', 'xianyu-server-evidence'))

async function waitFor(url) {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`server did not become ready: ${url}`)
}

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, ['server/http-server.js'], { cwd: repo, env: { ...process.env, SERVER_HOST: '127.0.0.1', SERVER_PORT: String(port), BROWSER_PROVIDER: 'fake', XIAN_YU_SERVER_DATA_DIR: dataDir, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] })
  await waitFor(`http://127.0.0.1:${port}/health`)
  return child
}

function stop(child) {
  if (!child || child.exitCode != null) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      if (child.exitCode == null) child.kill('SIGKILL')
      finish()
    }, 5_000)
    child.once('exit', finish)
    child.kill('SIGTERM')
  })
}

async function main() {
  assert.ok(process.argv.includes('--fixture'), 'fixture flag is required')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await fs.mkdir(platformRoot, { recursive: true })
  const dataDir = await fs.mkdtemp(path.join(platformRoot, 'run-'))
  const port = 32300 + Math.floor(Math.random() * 300)
  const seed = createDatabase({ filename: path.join(dataDir, 'server.sqlite') })
  const seedAuth = createAuthService({ db: seed })
  const admin = seedAuth.createUser({ username: 'smokeadmin', password: 'DEMO_ONLY_REDACTED', role: 'admin', displayName: 'Smoke Admin' })
  seed.upsertBrowserProfile({ id: 'profile-1', provider: 'fake', vendorProfileId: 'fixture-profile', label: 'Smoke fixture', createdBy: admin.id })
  seed.close()

  const evidence = { startedAt: new Date().toISOString(), checks: [], provider: 'fake', gui: 'NOT RUN (Midscene browser session unavailable)' }
  let child = await startServer(dataDir, port)
  const base = `http://127.0.0.1:${port}`
  try {
    const health = await fetch(`${base}/health`); assert.equal(health.status, 200); evidence.checks.push('health PASS')
    const home = await fetch(`${base}/`); assert.equal(home.status, 200); assert.match(await home.text(), /闲鱼服务器控制台/); evidence.checks.push('H5 static launch PASS')
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'smokeadmin', password: 'DEMO_ONLY_REDACTED' }) }); assert.equal(login.status, 200)
    const cookieHeader = login.headers.get('set-cookie'); assert.match(cookieHeader, /^sid=/); const cookie = cookieHeader.split(';')[0]; evidence.checks.push('employee login PASS')
    const initial = await fetch(`${base}/jobs`, { headers: { cookie } }); assert.equal(initial.status, 200); evidence.checks.push('job list PASS')
    const createdResponse = await fetch(`${base}/jobs`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'market_snapshot', payload: { keyword: 'fixture monitor' } }) }); assert.equal(createdResponse.status, 201)
    const created = (await createdResponse.json()).job; evidence.jobId = created.id; evidence.checks.push('job create PASS')
    const eventResponse = await fetch(`${base}/events?after=0`, { headers: { cookie, accept: 'text/event-stream' } }); const eventBody = await eventResponse.text(); assert.match(eventBody, /job.created/); evidence.checks.push('SSE event PASS')
    const cancel = await fetch(`${base}/jobs/${created.id}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }); assert.equal(cancel.status, 200); assert.equal((await cancel.json()).job.status, 'cancelled'); evidence.checks.push('job cancel PASS')
    const workerJobResponse = await fetch(`${base}/jobs`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'market_snapshot', profileId: 'profile-1', payload: { keyword: 'fixture monitor' } }) }); assert.equal(workerJobResponse.status, 201)
    const workerJob = (await workerJobResponse.json()).job; evidence.workerJobId = workerJob.id
    let workerStatus = 'pending'; const workerDeadline = Date.now() + 10_000
    while (Date.now() < workerDeadline && !['succeeded', 'failed', 'cancelled'].includes(workerStatus)) { await new Promise(resolve => setTimeout(resolve, 100)); const current = await fetch(`${base}/jobs/${workerJob.id}`, { headers: { cookie } }); workerStatus = (await current.json()).job.status }
    assert.equal(workerStatus, 'succeeded'); evidence.checks.push('server Worker market job PASS')
    await stop(child); child = await startServer(dataDir, port)
    const relogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'smokeadmin', password: 'DEMO_ONLY_REDACTED' }) }); const cookie2 = relogin.headers.get('set-cookie').split(';')[0]
    const persisted = await fetch(`${base}/jobs/${created.id}`, { headers: { cookie: cookie2 } }); assert.equal(persisted.status, 200); assert.equal((await persisted.json()).job.status, 'cancelled'); evidence.checks.push('restart persistence PASS')
    const persistedWorker = await fetch(`${base}/jobs/${workerJob.id}`, { headers: { cookie: cookie2 } }); assert.equal(persistedWorker.status, 200); assert.equal((await persistedWorker.json()).job.status, 'succeeded'); evidence.checks.push('worker result persistence PASS')
    evidence.finishedAt = new Date().toISOString()
  } finally {
    await stop(child)
    const out = path.join(evidenceRoot, stamp); await fs.mkdir(out, { recursive: true }); await fs.writeFile(path.join(out, 'server-console-smoke.json'), JSON.stringify(evidence, null, 2)); await fs.rm(dataDir, { recursive: true, force: true })
  }
  console.log(`server-console-smoke: PASS ${JSON.stringify(evidence)}`)
}

main().catch(error => { console.error(`server-console-smoke: FAILED ${error.message}`); process.exitCode = 1 })
