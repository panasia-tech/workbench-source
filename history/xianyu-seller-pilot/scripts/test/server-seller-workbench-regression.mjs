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

function multipart(buffer, filename = 'sellers.xlsx') {
  const boundary = '----xianyu-seller-boundary'
  return { boundary, body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), buffer, Buffer.from(`\r\n--${boundary}--\r\n`)]) }
}
async function waitFor(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error('timed out waiting for seller workbench result')
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-server-seller-'))
  const db = createDatabase({ filename: path.join(tempDir, 'server.sqlite') })
  const auth = createAuthService({ db })
  const admin = auth.createUser({ username: 'seller-admin', password: 'DEMO_ONLY_REDACTED', role: 'admin', displayName: 'Seller Admin' })
  db.upsertBrowserProfile({ id: 'seller-profile', provider: 'fake', vendorProfileId: 'fixture-seller', label: 'Fixture Seller', createdBy: admin.id })
  const app = buildHttpApp({ db, auth, config: { provider: 'fake', dataDir: tempDir } }); await app.fastify.ready()
  const login = await app.fastify.inject({ method: 'POST', url: '/auth/login', payload: { username: 'seller-admin', password: 'DEMO_ONLY_REDACTED' } }); assert.equal(login.statusCode, 200); const cookie = String(login.headers['set-cookie']).split(';')[0]
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['卖家ID', '卖家主页', '卖家名称', '分类'], ['seller-1', 'https://example.test/seller/1', '测试卖家', '数码'], ['seller-2', 'https://example.test/seller/2', '空卖家', '数码']]), '卖家主页')
  const file = multipart(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
  const imported = await app.fastify.inject({ method: 'POST', url: '/seller-workbench/import', headers: { cookie, 'content-type': `multipart/form-data; boundary=${file.boundary}` }, payload: file.body }); assert.equal(imported.statusCode, 201); assert.equal(imported.json().added, 2)
  assert.equal((await app.fastify.inject({ method: 'GET', url: '/seller-workbench/summary', headers: { cookie } })).json().indexed, 2)
  const started = await app.fastify.inject({ method: 'POST', url: '/seller-workbench/start', headers: { cookie, 'content-type': 'application/json' }, payload: { profileId: 'seller-profile' } }); assert.equal(started.statusCode, 200); assert.equal(started.json().total, 2)
  const paused = await app.fastify.inject({ method: 'POST', url: '/seller-workbench/pause', headers: { cookie, 'content-type': 'application/json' }, payload: {} }); assert.equal(paused.statusCode, 200); assert.equal(paused.json().paused, 2)
  assert.equal((await app.fastify.inject({ method: 'GET', url: '/seller-workbench/summary', headers: { cookie } })).json().paused, true)
  const resumed = await app.fastify.inject({ method: 'POST', url: '/seller-workbench/resume', headers: { cookie, 'content-type': 'application/json' }, payload: {} }); assert.equal(resumed.statusCode, 200); assert.equal(resumed.json().resumed, 2)
  const provider = createFakeProvider({ fixture: { sellerName: '页面全名卖家', evidence: { firstPageExpected: { active: 1, sold: 1 }, expected: { active: 1, sold: 1 }, expectedTrusted: { active: true, sold: true }, itemIds: { active: ['a'], sold: ['s'] } }, items: [{ id: 'a', title: '在售商品', branch: 'active', price: 99 }] } })
  const worker = createServerWorker({ db, provider, workerId: 'seller-worker', pollMs: 10, leaseMs: 1000 }); await worker.start(); await waitFor(() => db.getSellerRun(started.json().runId)?.status === 'completed'); await worker.stop()
  const summary = (await app.fastify.inject({ method: 'GET', url: '/seller-workbench/summary', headers: { cookie } })).json(); assert.equal(summary.groupCounts.completed, 2)
  const queues = (await app.fastify.inject({ method: 'GET', url: '/seller-workbench/queues?group=completed', headers: { cookie } })).json(); assert.equal(queues.items.length, 2); assert.equal(queues.items.every(item => item.sellerName === '页面全名卖家'), true)
  const detail = (await app.fastify.inject({ method: 'GET', url: `/seller-workbench/queues/${queues.items[0].id}`, headers: { cookie } })).json(); assert.equal(detail.ok, true); assert.equal(Array.isArray(detail.items), true)
  const exportResponse = await app.fastify.inject({ method: 'GET', url: '/seller-workbench/export-detail', headers: { cookie } }); assert.equal(exportResponse.statusCode, 200); assert.match(exportResponse.headers['content-type'], /spreadsheetml/)
  await app.fastify.close(); db.close(); fs.rmSync(tempDir, { recursive: true, force: true })
  console.log('server-seller-workbench-regression: PASS (import -> queue -> worker -> evidence -> export)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
