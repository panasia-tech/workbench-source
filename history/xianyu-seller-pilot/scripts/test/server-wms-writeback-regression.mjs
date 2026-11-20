import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createDatabase } = await import('../../server/db/database.js')
const { createAuthService } = await import('../../server/auth/auth-service.js')
const { buildHttpApp } = await import('../../server/http/app.js')

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-server-wms-writeback-'))
  const db = createDatabase({ filename: path.join(tempDir, 'server.sqlite') })
  const auth = createAuthService({ db })
  const admin = auth.createUser({ username: 'wms-admin', password: 'DEMO_ONLY_REDACTED', role: 'admin', displayName: 'WMS Admin' })
  const taskId = 'server-wms-task-1'
  db.createWorkbenchCollection({ id: 'collection-wms-writeback', sourceFile: 'fixture.xlsx', sheetName: 'Sheet1', createdBy: admin.id, tasks: [{ id: taskId, brand: '旧品牌', model: '旧型号', name: '旧商品', alias: '', spuCode: 'SPU-WMS-1', referencePrice: 100, category: '显示器', searchKeywords: ['旧型号'] }] })
  const run = db.createWorkbenchRun({ id: 'run-wms-writeback', collectionId: 'collection-wms-writeback', total: 1, createdBy: admin.id })
  db.recordWorkbenchResult({ taskId, runId: run.id, status: 'succeeded', price: 300, result: { keyword: '旧型号' } })
  db.setWorkbenchTaskOverride(taskId, { aiReviewStatus: 'approved', correctionReviewStatus: 'approved' }, admin.id)
  db.replaceWmsInventory([{ sku_code: 'SKU-WMS-1', spu_code: 'SPU-WMS-1', status: 'IN_STOCK', product_name: '旧商品', brand: '旧品牌', model: '旧型号', version: '1' }], { source: 'rest', spuTotal: 1, syncedAt: new Date().toISOString() })

  let current = { sku_code: 'SKU-WMS-1', spu_code: 'SPU-WMS-1', status: 'IN_STOCK', product_name: '旧商品', brand: '旧品牌', model: '旧型号' }
  let etag = 'etag-1'
  let patchCalls = 0
  const client = {
    async adminLogin() { return { token: 'fixture-admin-token' } },
    async fetchInventorySku() { return { data: { ...current }, headers: { etag } } },
    async updateInventorySku(skuCode, patch, options) {
      assert.equal(skuCode, 'SKU-WMS-1')
      assert.equal(options.expectedVersion, 'etag-1')
      assert.equal(options.etag, 'etag-1')
      patchCalls += 1
      current = { ...current, ...patch }
      etag = 'etag-2'
      return { data: current }
    }
  }
  const app = buildHttpApp({ db, auth, config: { dataDir: tempDir, wms: { source: 'rest', apiBaseUrl: 'https://wms.example/api', restUsername: 'fixture', restPassword: 'DEMO_ONLY_REDACTED' } }, wms: { getClient: () => client } })
  await app.fastify.ready()
  const login = await app.fastify.inject({ method: 'POST', url: '/auth/login', payload: { username: 'wms-admin', password: 'DEMO_ONLY_REDACTED' } })
  assert.equal(login.statusCode, 200)
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const projection = await app.fastify.inject({ method: 'GET', url: '/wms/projection?page=1&pageSize=10&marketPage=1&marketPageSize=10', headers: { cookie } })
  assert.equal(projection.statusCode, 200)
  assert.equal(projection.json().market.items[0].apiSpuAssociationStatus, 'exact')
  assert.equal(projection.json().market.items[0].apiSkuCode, 'SKU-WMS-1')
  assert.equal(projection.json().market.items[0].apiSkuCount, 1)
  const success = await app.fastify.inject({ method: 'POST', url: '/wms/identity-writeback', headers: { cookie, 'content-type': 'application/json' }, payload: { taskId, skuCode: 'SKU-WMS-1', patch: { product_name: '新商品', brand: '新品牌', model: '新型号' } } })
  assert.equal(success.statusCode, 200)
  assert.equal(success.json().ok, true)
  assert.equal(success.json().putIssued, true)
  assert.equal(success.json().verified, true)
  assert.equal(patchCalls, 1)
  assert.equal(db.getWorkbenchTask(taskId).correctionWorkflowStatus, 'verified')
  assert.equal(db.listAllWmsInventory().find(row => row.sku_code === 'SKU-WMS-1').model, '新型号')

  const invalidPatch = await app.fastify.inject({ method: 'POST', url: '/wms/identity-writeback', headers: { cookie, 'content-type': 'application/json' }, payload: { taskId, skuCode: 'SKU-WMS-1', patch: { price: 999 } } })
  assert.equal(invalidPatch.statusCode, 400)
  assert.equal(invalidPatch.json().status, 'blocked')
  assert.equal(invalidPatch.json().putIssued, false)
  assert.equal(invalidPatch.json().error.code, 'wms_writeback_patch_invalid')
  assert.equal(invalidPatch.json().audit.result, 'blocked')
  assert.equal(patchCalls, 1)

  const preconditionApp = buildHttpApp({ db, auth, config: { dataDir: tempDir, wms: { source: 'rest', apiBaseUrl: 'https://wms.example/api', restUsername: 'fixture', restPassword: 'DEMO_ONLY_REDACTED' } }, wms: { getClient: () => client } })
  db.setWorkbenchTaskOverride(taskId, { aiReviewStatus: 'pending' }, admin.id)
  await preconditionApp.fastify.ready()
  const precondition = await preconditionApp.fastify.inject({ method: 'POST', url: '/wms/identity-writeback', headers: { cookie, 'content-type': 'application/json' }, payload: { taskId, skuCode: 'SKU-WMS-1', patch: { product_name: '不应写入', brand: '新品牌', model: '新型号' } } })
  assert.equal(precondition.statusCode, 409)
  assert.equal(precondition.json().status, 'blocked')
  assert.equal(precondition.json().putIssued, false)
  assert.equal(precondition.json().error.code, 'wms_writeback_precondition_failed')
  await preconditionApp.fastify.close()

  const noCredentialsApp = buildHttpApp({ db, auth, config: { dataDir: tempDir, wms: { source: 'rest' } }, wms: { getClient: () => client } })
  await noCredentialsApp.fastify.ready()
  const noCredentials = await noCredentialsApp.fastify.inject({ method: 'POST', url: '/wms/identity-writeback', headers: { cookie, 'content-type': 'application/json' }, payload: { taskId, skuCode: 'SKU-WMS-1', patch: { product_name: '未配置不应写入', brand: '新品牌', model: '新型号' } } })
  assert.equal(noCredentials.statusCode, 503)
  assert.equal(noCredentials.json().status, 'blocked')
  assert.equal(noCredentials.json().putIssued, false)
  assert.equal(noCredentials.json().error.code, 'wms_credentials_missing')
  assert.equal(noCredentials.json().audit.result, 'blocked')
  await noCredentialsApp.fastify.close()

  db.setWorkbenchTaskOverride(taskId, { aiReviewStatus: 'approved', correctionReviewStatus: 'approved' }, admin.id)

  const noVersionClient = {
    async adminLogin() { return { token: 'fixture-admin-token' } },
    async fetchInventorySku() { return { data: { ...current, version: undefined }, headers: {} } },
    async updateInventorySku() { throw new Error('must not issue patch') }
  }
  const blockedApp = buildHttpApp({ db, auth, config: { dataDir: tempDir, wms: { source: 'rest', apiBaseUrl: 'https://wms.example/api', restUsername: 'fixture', restPassword: 'DEMO_ONLY_REDACTED' } }, wms: { getClient: () => noVersionClient } })
  await blockedApp.fastify.ready()
  const blocked = await blockedApp.fastify.inject({ method: 'POST', url: '/wms/identity-writeback', headers: { cookie, 'content-type': 'application/json' }, payload: { taskId, skuCode: 'SKU-WMS-1', patch: { product_name: '不会写入', brand: '新品牌', model: '新型号' } } })
  assert.equal(blocked.statusCode, 409)
  assert.equal(blocked.json().ok, false)
  assert.equal(blocked.json().putIssued, false)
  assert.equal(blocked.json().error.code, 'wms_version_missing')
  assert.equal(db.getWorkbenchTask(taskId).correctionWorkflowStatus, 'writeback_blocked')
  await blockedApp.fastify.close()
  await app.fastify.close()
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
  console.log('server-wms-writeback-regression: PASS (GET/version/ETag -> PATCH -> GET, cache update, zero-PUT block)')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
