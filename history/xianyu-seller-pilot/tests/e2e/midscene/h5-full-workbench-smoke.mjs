import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const { createDatabase } = require('../../../server/db/database.js')
const { createAuthService } = require('../../../server/auth/auth-service.js')
const repo = path.resolve(path.join(import.meta.dirname, '../../..'))
const platformRoot = process.env.XIAN_YU_TEST_TMP || (process.platform === 'darwin'
  ? '/Volumes/ChatGPT/Codex-External/xianyu-h5-workbench'
  : path.join('/var/tmp', 'xianyu-h5-workbench'))
const evidenceRoot = process.env.XIAN_YU_EVIDENCE_ROOT || (process.platform === 'darwin'
  ? '/Volumes/ChatGPT/Codex-External/xianyu-h5-workbench-evidence'
  : path.join('/var/tmp', 'xianyu-h5-workbench-evidence'))

function multipart(buffer, filename, boundary) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
}

async function waitFor(url, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) { lastError = error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`server did not become ready: ${url}${lastError ? ` (${lastError.message})` : ''}`)
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

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, ['server/http-server.js'], {
    cwd: repo,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SERVER_HOST: '127.0.0.1',
      SERVER_PORT: String(port),
      SERVER_WEB_UI: 'renderer',
      SERVER_WORKER_POLL_MS: '50',
      SERVER_SCHEDULER_TICK_MS: '200',
      SERVER_WORKER_CONCURRENCY: '2',
      BROWSER_PROVIDER: 'fake',
      XIAN_YU_SERVER_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const errors = []
  child.stderr.on('data', chunk => errors.push(String(chunk).slice(-2000)))
  try {
    await waitFor(`http://127.0.0.1:${port}/health`)
  } catch (error) {
    await stop(child)
    throw new Error(`${error.message}; server stderr: ${errors.join('')}`)
  }
  return child
}

async function json(response) {
  return response.json()
}

async function main() {
  assert.ok(process.argv.includes('--fixture'), 'fixture flag is required; real Linux GUI is a separate gate')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await fs.mkdir(platformRoot, { recursive: true })
  const dataDir = await fs.mkdtemp(path.join(platformRoot, 'run-'))
  const port = 32600 + Math.floor(Math.random() * 250)
  const seed = createDatabase({ filename: path.join(dataDir, 'server.sqlite') })
  const seedAuth = createAuthService({ db: seed })
  const admin = seedAuth.createUser({ username: 'h5-smoke-admin', password: 'DEMO_ONLY_REDACTED', role: 'admin', displayName: 'H5 Smoke Admin' })
  seed.upsertBrowserProfile({ id: 'h5-profile', provider: 'fake', vendorProfileId: 'fixture-h5', label: 'H5 Fixture Profile', createdBy: admin.id })
  seed.close()

  const evidence = {
    startedAt: new Date().toISOString(),
    provider: 'fake',
    mode: 'fixture HTTP contract (not real Midscene GUI)',
    gui: 'NOT RUN: target Linux desktop/browser session unavailable',
    checks: []
  }
  let child = await startServer(dataDir, port)
  const base = `http://127.0.0.1:${port}`
  try {
    const home = await fetch(`${base}/`)
    assert.equal(home.status, 200)
    assert.match(await home.text(), /闲鱼服务器控制台|<div id="app">/)
    const adapter = await fetch(`${base}/web-erp-adapter.js`)
    assert.equal(adapter.status, 200)
    assert.match(await adapter.text(), /manualBrowserAction/)
    evidence.checks.push('H5 renderer + transport asset PASS')

    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'h5-smoke-admin', password: 'DEMO_ONLY_REDACTED' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    assert.equal((await json(await fetch(`${base}/auth/me`, { headers: { cookie } }))).user.role, 'admin')
    evidence.checks.push('H5 login/session PASS')

    const taskBook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(taskBook, XLSX.utils.aoa_to_sheet([
      ['品牌', '名称（兼容型号）', '别称（可能由SPU读取内容生成）', 'SPU编号', '采购价', '分类'],
      ['H5测试品牌', 'H5测试型号', 'H5别名', 'H5-SPU-1', '100', '数码']
    ]), '行情任务')
    const taskFile = multipart(XLSX.write(taskBook, { type: 'buffer', bookType: 'xlsx' }), 'h5-tasks.xlsx', '----h5-task-boundary')
    const imported = await fetch(`${base}/workbench/import`, { method: 'POST', headers: { cookie, 'content-type': 'multipart/form-data; boundary=----h5-task-boundary' }, body: taskFile })
    assert.equal(imported.status, 201)
    assert.equal((await json(imported)).rowCount, 1)
    const started = await fetch(`${base}/workbench/start`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'h5-profile' }) })
    assert.equal(started.status, 200)
    const workbenchRunId = (await json(started)).runId
    const workbenchDeadline = Date.now() + 12_000
    let workbenchResults = null
    while (Date.now() < workbenchDeadline) {
      workbenchResults = await json(await fetch(`${base}/workbench/results?runId=${encodeURIComponent(workbenchRunId)}`, { headers: { cookie } }))
      if (workbenchResults.total === 1) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(workbenchResults.total, 1)
    assert.equal(workbenchResults.items[0].status, 'succeeded')
    assert.equal((await json(await fetch(`${base}/workbench/history`, { headers: { cookie } }))).total, 1)
    assert.equal((await json(await fetch(`${base}/workbench/settings`, { headers: { cookie } }))).blacklistKeywords instanceof Array, true)
    assert.match((await fetch(`${base}/workbench/template`, { headers: { cookie } })).headers.get('content-type'), /spreadsheetml/)
    evidence.workbenchRunId = workbenchRunId
    evidence.checks.push('行情工作台：Excel → Worker → 历史/设置/模板 PASS')

    const sellerBook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(sellerBook, XLSX.utils.aoa_to_sheet([
      ['卖家ID', '卖家主页', '卖家名称', '分类'],
      ['h5-seller-1', 'https://example.test/seller/h5', 'H5测试卖家', '数码']
    ]), '卖家主页')
    const sellerFile = multipart(XLSX.write(sellerBook, { type: 'buffer', bookType: 'xlsx' }), 'h5-sellers.xlsx', '----h5-seller-boundary')
    const sellerImported = await fetch(`${base}/seller-workbench/import`, { method: 'POST', headers: { cookie, 'content-type': 'multipart/form-data; boundary=----h5-seller-boundary' }, body: sellerFile })
    assert.equal(sellerImported.status, 201)
    assert.equal((await json(sellerImported)).added, 1)
    const sellerStarted = await fetch(`${base}/seller-workbench/start`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'h5-profile' }) })
    assert.equal(sellerStarted.status, 200)
    const sellerRunId = (await json(sellerStarted)).runId
    const sellerDeadline = Date.now() + 12_000
    let sellerRun = null
    while (Date.now() < sellerDeadline) {
      sellerRun = await json(await fetch(`${base}/seller-workbench/runs/${encodeURIComponent(sellerRunId)}`, { headers: { cookie } }))
      if (sellerRun.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(sellerRun.status, 'completed')
    assert.equal((await json(await fetch(`${base}/seller-workbench/summary`, { headers: { cookie } }))).indexed, 1)
    assert.match((await fetch(`${base}/seller-workbench/export`, { headers: { cookie } })).headers.get('content-type'), /spreadsheetml/)
    evidence.sellerRunId = sellerRunId
    evidence.checks.push('卖家工作台：Excel → Worker → 队列/运行/导出 PASS')

    const manual = await fetch(`${base}/profiles/h5-profile/manual-session`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.goofish.com/' }) })
    assert.equal(manual.status, 503)
    assert.equal((await json(manual)).error.code, 'manual_control_unavailable')
    evidence.checks.push('fixture provider 人工接管 fail-closed PASS')

    await stop(child)
    child = await startServer(dataDir, port)
    const relogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'h5-smoke-admin', password: 'DEMO_ONLY_REDACTED' }) })
    const cookie2 = relogin.headers.get('set-cookie').split(';')[0]
    assert.equal((await json(await fetch(`${base}/workbench/results?runId=${encodeURIComponent(workbenchRunId)}`, { headers: { cookie: cookie2 } }))).total, 1)
    assert.equal((await json(await fetch(`${base}/seller-workbench/runs/${encodeURIComponent(sellerRunId)}`, { headers: { cookie: cookie2 } }))).status, 'completed')
    evidence.checks.push('server restart + task/evidence persistence PASS')
    evidence.finishedAt = new Date().toISOString()
  } finally {
    await stop(child)
    const out = path.join(evidenceRoot, stamp)
    await fs.mkdir(out, { recursive: true })
    await fs.writeFile(path.join(out, 'h5-full-workbench-smoke.json'), JSON.stringify(evidence, null, 2))
    await fs.rm(dataDir, { recursive: true, force: true })
  }
  console.log(`h5-full-workbench-smoke: PASS ${JSON.stringify(evidence)}`)
}

main().catch(error => { console.error(`h5-full-workbench-smoke: FAILED ${error.stack || error.message}`); process.exitCode = 1 })
