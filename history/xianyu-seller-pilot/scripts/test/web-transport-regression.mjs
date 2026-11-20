import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const { createDatabase } = require('../../server/db/database.js')
const { createAuthService } = require('../../server/auth/auth-service.js')
const { registerWebRoutes } = require('../../server/http/routes/web.js')
const repo = path.resolve(path.join(import.meta.dirname, '../..'))

async function waitFor(url) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`server did not become ready: ${url}`)
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
    // Attach the listener before sending SIGTERM. A fast local server can
    // exit in the same tick; registering it afterwards leaves the regression
    // process waiting forever even though the child is already gone.
    child.once('exit', finish)
    child.kill('SIGTERM')
  })
}

async function main() {
  const originalNodeEnv = process.env.NODE_ENV
  const originalServerWebUi = process.env.SERVER_WEB_UI
  process.env.NODE_ENV = 'production'
  process.env.SERVER_WEB_UI = 'renderer'
  assert.throws(
    () => registerWebRoutes({ get() {} }, { root: '/definitely-missing-h5-fallback', builtRoot: '/definitely-missing-h5-build' }),
    /SERVER_WEB_UI=renderer requires built H5 artifact/,
    'production must fail closed when the full H5 build is missing'
  )
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalServerWebUi === undefined) delete process.env.SERVER_WEB_UI
  else process.env.SERVER_WEB_UI = originalServerWebUi
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xianyu-web-transport-'))
  const db = createDatabase({ filename: path.join(dataDir, 'server.sqlite') })
  const auth = createAuthService({ db })
  auth.createUser({ username: 'web-admin', password: 'DEMO_ONLY_REDACTED', role: 'admin', displayName: 'Web Admin' })
  db.close()
  const port = 32700 + Math.floor(Math.random() * 200)
  const child = spawn(process.execPath, ['server/http-server.js'], { cwd: repo, env: { ...process.env, SERVER_HOST: '127.0.0.1', SERVER_PORT: String(port), SERVER_WEB_UI: 'renderer', BROWSER_PROVIDER: 'fake', NODE_ENV: 'test', XIAN_YU_SERVER_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const home = await waitFor(`http://127.0.0.1:${port}/`)
    const html = await home.text()
    assert.match(html, /web-erp-adapter\.js/)
    assert.match(html, /assets\/index-[^"']+\.js/)
    const jsAsset = html.match(/(assets\/index-[^"']+\.js)/)?.[1]
    assert.ok(jsAsset, 'renderer HTML must reference a JavaScript asset')
    const bundle = await fetch(`http://127.0.0.1:${port}/${jsAsset}`)
    assert.equal(bundle.status, 200)
    assert.match(bundle.headers.get('content-type') || '', /javascript/)
    const cssAsset = html.match(/(assets\/index-[^"']+\.css)/)?.[1]
    assert.ok(cssAsset, 'renderer HTML must reference a CSS asset')
    const stylesheet = await fetch(`http://127.0.0.1:${port}/${cssAsset}`)
    assert.equal(stylesheet.status, 200)
    assert.match(stylesheet.headers.get('content-type') || '', /css/)
    const adapter = await fetch(`http://127.0.0.1:${port}/web-erp-adapter.js`)
    assert.equal(adapter.status, 200)
    const adapterText = await adapter.text()
    assert.match(adapterText, /window\.erp = webErp/)
    const consoleView = await fs.readFile(path.join(repo, 'src/renderer/src/views/Console.vue'), 'utf8')
    assert.match(consoleView, /<div v-if="!isWeb" class="win-ops">/, 'H5 must not expose Electron-only window controls')
    assert.match(consoleView, /const isWeb = window\.erp\?\.mode === ['"]web['"]/, 'console must detect the server transport before rendering desktop controls')
    const taskCenter = await fs.readFile(path.join(repo, 'src/renderer/src/views/TaskCenter.vue'), 'utf8')
    assert.match(taskCenter, /服务器 Worker 运行/, 'H5 task center must identify server-side worker execution')
    assert.match(taskCenter, /const isWeb = window\.erp\?\.mode === ['"]web['"]/, 'task center must detect server mode for execution status copy')
    const accountsView = await fs.readFile(path.join(repo, 'src/renderer/src/views/Accounts.vue'), 'utf8')
    assert.match(accountsView, /服务器 Scheduler 持久化执行/, 'H5 accounts settings must explain that daily schedules survive a closed browser')
    const pricesView = await fs.readFile(path.join(repo, 'src/renderer/src/views/Prices.vue'), 'utf8')
    assert.match(pricesView, /isWeb \? ['"]服务器策略复采['"] : ['"]本地策略复采['"]/, 'H5 prices actions must identify server-side recollection')
    assert.match(pricesView, /const isWeb = window\.erp\?\.mode === ['"]web['"]/, 'prices must detect server mode for recollection copy')
    const eventSources = []
    const crawlEvents = []
    const sellerEvents = []
    const intervalCallbacks = []
    const clearedIntervals = []
    class FakeEventSource {
      constructor(url) { this.url = url; this.closed = false; this.handlers = {}; eventSources.push(this) }
      addEventListener(type, handler) { this.handlers[type] = handler }
      emit(type, payload) { this.handlers[type]?.({ type, data: JSON.stringify(payload) }) }
      close() { this.closed = true }
    }
    const previewContext = {
      window: {},
      document: { createElement: () => ({ click() {}, style: {}, append() {} }) },
      FormData,
      Blob,
      EventSource: FakeEventSource,
      URL: { createObjectURL: () => 'blob:h5-preview' },
      setTimeout,
      setInterval: callback => { intervalCallbacks.push(callback); return intervalCallbacks.length },
      clearInterval: handle => { clearedIntervals.push(handle) },
      fetch: async url => {
        if (String(url) === '/wms/state') return { ok: true, headers: { get: key => key === 'content-type' ? 'application/json' : '' }, json: async () => ({ status: 'synced', skuTotal: 2 }) }
        return { ok: true, headers: { get: key => key === 'content-type' ? 'application/octet-stream' : "attachment; filename*=UTF-8''snapshot.html" }, blob: async () => new Blob(['<html>snapshot</html>'], { type: 'application/octet-stream' }) }
      }
    }
    vm.runInNewContext(adapterText, previewContext)
    const preview = await previewContext.window.erp.getTaskSnapshot('artifact-id')
    assert.equal(preview.ok, true)
    assert.equal(preview.kind, 'html')
    assert.equal(preview.url, 'blob:h5-preview')
    assert.equal(preview.name, 'snapshot.html')
    const unsubscribe = previewContext.window.erp.onCrawlEvent(event => crawlEvents.push(event))
    const eventSource = eventSources.at(-1)
    assert.ok(eventSource, 'H5 adapter must create an EventSource for crawl events')
    await new Promise(resolve => setImmediate(resolve))
    eventSource.emit('job.created', { jobId: 'market-job', jobType: 'market_snapshot', status: 'pending', payload: { keyword: 'fixture' } })
    eventSource.emit('job.created', { jobId: 'market-job-2', jobType: 'market_snapshot', status: 'pending', payload: { keyword: 'fixture-2' } })
    eventSource.emit('job.succeeded', { jobId: 'market-job', jobType: 'market_snapshot', status: 'succeeded', payload: { result: { price: 123 } } })
    assert.deepEqual(crawlEvents.map(event => event.type), ['start'], 'market server events must aggregate a multi-job run before terminal refresh')
    assert.equal(crawlEvents[0].payload.jobType, 'market_snapshot')
    eventSource.emit('job.succeeded', { jobId: 'market-job-2', jobType: 'market_snapshot', status: 'succeeded', payload: { result: { price: 456 } } })
    assert.deepEqual(crawlEvents.map(event => event.type), ['start', 'done'], 'market server events must keep the renderer lifecycle contract')
    assert.equal(crawlEvents[1].payload.result.price, 456)
    eventSource.onerror()
    assert.equal(eventSource.closed, false, 'transient SSE errors must leave EventSource open for Last-Event-ID reconnect')
    unsubscribe()
    assert.equal(eventSource.closed, true, 'SSE cleanup must close the EventSource explicitly')
    const sellerUnsubscribe = previewContext.window.erp.onSellerEvent(event => sellerEvents.push(event))
    const sellerSource = eventSources.at(-1)
    await new Promise(resolve => setImmediate(resolve))
    sellerSource.emit('job.created', { jobId: 'seller-job', jobType: 'seller_snapshot', status: 'pending', payload: {} })
    sellerSource.emit('task.paused', { jobId: 'seller-job', jobType: 'seller_snapshot', status: 'pending', payload: {} })
    sellerSource.emit('job.failed', { jobId: 'seller-job', jobType: 'seller_snapshot', status: 'failed', payload: { errorCode: 'fixture_failed' } })
    assert.deepEqual(sellerEvents.map(event => event.type), ['seller-start', 'seller-progress', 'seller-error'], 'seller server events must keep the seller renderer lifecycle contract')
    assert.equal(sellerEvents[1].payload.current, '已暂停')
    sellerUnsubscribe()
    const wmsStates = []
    const stopWms = previewContext.window.erp.onWmsSyncState(state => wmsStates.push(state))
    assert.equal(intervalCallbacks.length, 1, 'H5 adapter must schedule a server WMS state poll')
    await intervalCallbacks[0]()
    assert.deepEqual(wmsStates, [{ status: 'synced', skuTotal: 2 }])
    stopWms()
    assert.deepEqual(clearedIntervals, [1], 'WMS state polling must be cleaned up with the page')
    const login = await fetch(`http://127.0.0.1:${port}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'web-admin', password: 'DEMO_ONLY_REDACTED' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const summary = await fetch(`http://127.0.0.1:${port}/workbench/summary`, { headers: { cookie } })
    assert.equal(summary.status, 200)
    const projection = await fetch(`http://127.0.0.1:${port}/wms/projection?page=1&pageSize=10&marketPage=1&marketPageSize=10`, { headers: { cookie } })
    assert.equal(projection.status, 200)
    assert.equal(Array.isArray((await projection.json()).inventory.items), true)
    console.log('web-transport-regression: PASS (renderer bundle + runtime adapter + authenticated HTTP)')
  } finally {
    await stop(child)
    await fs.rm(dataDir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
