import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const { createDatabase } = require('../../server/db/database.js')
const { createAuthService } = require('../../server/auth/auth-service.js')
const { createFakeProvider } = require('../../server/browser/fake-provider.js')
const { createServerWorker } = require('../../server/jobs/db-worker.js')
const { buildHttpApp } = require('../../server/http/app.js')

function multipart(buffer, filename = 'tasks.xlsx') {
  const boundary = '----xianyu-workbench-boundary'
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`)
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { boundary, body: Buffer.concat([header, buffer, footer]) }
}

async function waitFor(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for workbench result')
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-server-workbench-'))
  const db = createDatabase({ filename: path.join(tempDir, 'server.sqlite') })
  const auth = createAuthService({ db })
  const admin = auth.createUser({ username: 'workbench-admin', password: 'DEMO_ONLY_REDACTED', role: 'admin', displayName: 'Workbench Admin' })
  db.upsertBrowserProfile({ id: 'profile-workbench', provider: 'fake', vendorProfileId: 'fixture-workbench', label: 'Fixture Workbench', createdBy: admin.id })
  const app = buildHttpApp({ db, auth, config: { provider: 'fake', dataDir: tempDir } })
  await app.fastify.ready()
  const login = await app.fastify.inject({ method: 'POST', url: '/auth/login', payload: { username: 'workbench-admin', password: 'DEMO_ONLY_REDACTED' } })
  assert.equal(login.statusCode, 200)
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['品牌', '名称（兼容型号）', '别称（可能由SPU读取内容生成）', 'SPU编号', '采购价', '分类'],
    ['测试品牌', '测试型号 A', '别名 A', 'SPU-A', '100', '显示器'],
    ['测试品牌', '测试型号 B', '', 'SPU-B', '200', '显示器']
  ]), '行情任务')
  const file = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  const form = multipart(file)
  const imported = await app.fastify.inject({ method: 'POST', url: '/workbench/import', headers: { cookie, 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.body })
  assert.equal(imported.statusCode, 201)
  assert.equal(imported.json().rowCount, 2)
  const summary = await app.fastify.inject({ method: 'GET', url: '/workbench/summary', headers: { cookie } })
  assert.equal(summary.statusCode, 200)
  assert.equal(summary.json().totalCount, 2)
  const tasks = await app.fastify.inject({ method: 'GET', url: '/workbench/tasks?page=1&pageSize=20', headers: { cookie } })
  assert.equal(tasks.statusCode, 200)
  assert.equal(tasks.json().items.length, 2)
  const started = await app.fastify.inject({ method: 'POST', url: '/workbench/start', headers: { cookie, 'content-type': 'application/json' }, payload: { profileId: 'profile-workbench' } })
  assert.equal(started.statusCode, 200)
  assert.equal(started.json().total, 2)
  const worker = createServerWorker({ db, provider: createFakeProvider({ fixture: { items: [{ id: 'item-1', title: '测试结果', price: 300 }] } }), workerId: 'workbench-worker', pollMs: 10, leaseMs: 1000 })
  await worker.start()
  await waitFor(async () => db.listWorkbenchResults({ page: 1, pageSize: 20 }).total === 2)
  await worker.stop()
  const results = db.listWorkbenchResults({ page: 1, pageSize: 20 })
  assert.equal(results.total, 2)
  assert.equal(results.items.every(item => item.status === 'succeeded'), true)
  assert.equal(db.getWorkbenchRun(started.json().runId).status, 'completed')
  const history = await app.fastify.inject({ method: 'GET', url: '/workbench/history?group=success', headers: { cookie } })
  assert.equal(history.statusCode, 200)
  assert.equal(history.json().total, 2)
  assert.equal(history.json().items[0].status, 'success')
  assert.equal(history.json().groupCounts.success, 2)
  assert.equal(history.json().priceBandCounts.purchase_200_plus, 1)
  const band = await app.fastify.inject({ method: 'GET', url: '/workbench/history?group=success&priceBand=purchase_200_plus', headers: { cookie } })
  assert.equal(band.statusCode, 200)
  assert.equal(band.json().total, 1)
  const projection = await app.fastify.inject({ method: 'GET', url: '/wms/projection?marketPageSize=20', headers: { cookie } })
  assert.equal(projection.statusCode, 200)
  assert.equal(projection.json().market.groupCounts.success, 2)
  assert.equal(projection.json().market.priceBandCounts.purchase_200_plus, 1)
  assert.equal(projection.json().market.items.every(item => item.lastStatus === 'success'), true)
  const plan = await app.fastify.inject({ method: 'GET', url: '/workbench/plan', headers: { cookie } })
  assert.equal(plan.statusCode, 200)
  assert.equal(plan.json().total, 0)
  const policy = await app.fastify.inject({ method: 'PUT', url: '/workbench/policies/SPU-A', headers: { cookie, 'content-type': 'application/json' }, payload: { search: { mode: 'explicit', queries: ['测试型号 A'] } } })
  assert.equal(policy.statusCode, 200)
  assert.equal((await app.fastify.inject({ method: 'GET', url: '/workbench/policies/SPU-A', headers: { cookie } })).json().search.mode, 'explicit')
  const settings = await app.fastify.inject({ method: 'PATCH', url: '/workbench/settings', headers: { cookie, 'content-type': 'application/json' }, payload: { blacklistKeywords: ['维修'] } })
  assert.equal(settings.statusCode, 200)
  assert.deepEqual(settings.json().blacklistKeywords, ['维修'])
  const identityTaskId = tasks.json().items[0].id
  const identity = await app.fastify.inject({ method: 'PATCH', url: `/workbench/tasks/${identityTaskId}/identity`, headers: { cookie, 'content-type': 'application/json' }, payload: { product_name: '服务器修正型号 A', brand: '修正品牌', model: '修正型号 A' } })
  assert.equal(identity.statusCode, 200)
  assert.equal(identity.json().localOnly, true)
  assert.equal(identity.json().task.name, '服务器修正型号 A')
  assert.equal(identity.json().task.searchKeywords[0], '修正型号 A')
  assert.equal(identity.json().task.aliases.includes('别名 A'), true)
  const searchedIdentity = await app.fastify.inject({ method: 'GET', url: '/workbench/tasks?page=1&pageSize=20&q=服务器修正型号', headers: { cookie } })
  assert.equal(searchedIdentity.statusCode, 200)
  assert.equal(searchedIdentity.json().total, 1)
  const taskAfterIdentity = db.getWorkbenchTask(identityTaskId)
  const priceIntent = await app.fastify.inject({ method: 'POST', url: `/workbench/tasks/${identityTaskId}/price-intent`, headers: { cookie, 'content-type': 'application/json' }, payload: { previewId: `${identityTaskId}-${taskAfterIdentity.updatedAt}`, policyVersion: 'server-workbench-v1', choice: 'market', confirmed: true, note: 'fixture intent' } })
  assert.equal(priceIntent.statusCode, 200)
  assert.equal(priceIntent.json().ok, true)
  assert.equal(priceIntent.json().status, 'recorded')
  assert.equal(priceIntent.json().selectedPrice, 300)
  assert.equal(db.getWorkbenchTask(identityTaskId).priceIntent.status, 'recorded')
  const belowCostIntent = await app.fastify.inject({ method: 'POST', url: `/workbench/tasks/${identityTaskId}/price-intent`, headers: { cookie, 'content-type': 'application/json' }, payload: { previewId: `${identityTaskId}-${db.getWorkbenchTask(identityTaskId).updatedAt}`, policyVersion: 'server-workbench-v1', choice: 'custom', customPrice: 99, confirmed: true } })
  assert.equal(belowCostIntent.statusCode, 400)
  assert.equal(belowCostIntent.json().error.code, 'price_below_cost')
  const historyAfterIdentity = await app.fastify.inject({ method: 'GET', url: '/workbench/history?group=success', headers: { cookie } })
  assert.equal(historyAfterIdentity.statusCode, 200)
  assert.equal(historyAfterIdentity.json().items.some(item => item.name === '服务器修正型号 A'), true)
  const template = await app.fastify.inject({ method: 'GET', url: '/workbench/template', headers: { cookie } })
  assert.equal(template.statusCode, 200)
  assert.match(template.headers['content-type'], /spreadsheetml/)
  await app.fastify.close()
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
  console.log('server-workbench-regression: PASS (import -> job -> worker -> history/settings/policy)')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
