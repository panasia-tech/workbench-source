import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDatabase } = require('../../server/db/database.js')
const { createAuthService } = require('../../server/auth/auth-service.js')
const { buildHttpApp } = require('../../server/http/app.js')
const { createServerWmsSyncService } = require('../../server/jobs/wms-sync.js')
const { createWmsClient } = require('../../server/wms/client.js')

const row = (sku, spu, extra = {}) => ({ sku_code: sku, spu_code: spu, status: 'IN_STOCK', brand: 'Acme', model: sku, product_name: `Acme ${sku}`, ...extra })

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-server-wms-'))
  const filename = path.join(tempDir, 'server.sqlite')
  const config = { provider: 'fake', dataDir: tempDir, wms: { source: 'rest', apiBaseUrl: 'https://wms.example.test/api', restUsername: 'admin', restPassword: 'DEMO_ONLY_REDACTED' } }
  let shouldFail = false
  const client = {
    async adminLogin() { return { token: 'server-token' } },
    async fetchAllInventory() {
      if (shouldFail) throw Object.assign(new Error('upstream unavailable'), { status: 503 })
      return { total: 2, items: [row('SKU-1', 'SPU-1', { cost_price: '100' }), row('SKU-2', 'SPU-1', { cost_price: '120' })] }
    }
  }

  const db = createDatabase({ filename })
  const service = createServerWmsSyncService({ db, config, client, intervalMs: 60_000 })
  assert.equal(db.schemaVersion(), 9)
  assert.equal(service.getState().status, 'unconfigured')
  const synced = await service.refresh({ reason: 'test' })
  assert.equal(synced.status, 'synced')
  assert.equal(synced.skuTotal, 2)
  assert.equal(synced.spuTotal, 1)
  assert.equal(db.listAllWmsInventory().length, 2)
  assert.equal(JSON.stringify(db.listAllWmsInventory()).includes('never-return-this'), false)

  const auth = createAuthService({ db })
  auth.createUser({ username: 'admin', password: 'DEMO_ONLY_REDACTED', displayName: 'Admin', role: 'admin' })
  const app = buildHttpApp({ db, auth, config, wms: service })
  await app.fastify.ready()
  const login = await app.fastify.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'DEMO_ONLY_REDACTED' } })
  const cookieHeader = login.headers['set-cookie']
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader).split(';')[0]
  const projection = await app.fastify.inject({ method: 'GET', url: '/wms/projection?page=1&pageSize=10', headers: { cookie } })
  assert.equal(projection.statusCode, 200)
  assert.equal(projection.json().sync.status, 'synced')
  assert.equal(projection.json().inventory.items.length, 1)
  assert.equal(projection.json().inventory.items[0].sku_count, 2)
  const publicConfig = await app.fastify.inject({ method: 'GET', url: '/wms/config', headers: { cookie } })
  assert.equal(publicConfig.statusCode, 200)
  assert.deepEqual(publicConfig.json(), { source: 'rest', apiConfigured: true, mcpConfigured: false, apiBaseConfigured: true })
  assert.equal(JSON.stringify(publicConfig.json()).includes('never-return-this'), false)

  // MCP remains a server-side, read-only fallback.  The employee-facing H5
  // never sees the key, while the adapter accepts the tabular text shape used
  // by the upstream query_database tool.
  const mcpClient = createWmsClient({ apiBaseUrl: 'https://wms.example.test/api', mcpUrl: 'http://127.0.0.1:8000', mcpKey: 'mcp-secret' }, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'POST')
      assert.match(options.headers.Authorization, /^Bearer mcp-secret$/)
      return {
        ok: true,
        status: 200,
        async text() {
          return `data: ${JSON.stringify({ result: { content: [{ type: 'text', text: '列: sku_code, spu_code, status\n返回 1 行\n\nMCP-SKU\tMCP-SPU\tIN_STOCK' }] } })}\n\n`
        }
      }
    }
  })
  const mcpSnapshot = await mcpClient.fetchMcpInventory()
  assert.equal(mcpSnapshot.items[0].sku_code, 'MCP-SKU')
  assert.equal(mcpClient.settings.mcpKey, undefined)

  let mcpCalls = 0
  const mcpDb = createDatabase({ filename: path.join(tempDir, 'mcp.sqlite') })
  const mcpService = createServerWmsSyncService({
    db: mcpDb,
    config: { wms: { source: 'mcp', mcpUrl: 'http://127.0.0.1:8000', mcpKey: 'mcp-secret' } },
    client: {
      async fetchMcpInventory() { mcpCalls += 1; return { items: [row('MCP-SKU', 'MCP-SPU')] } }
    }
  })
  const mcpSynced = await mcpService.refresh({ reason: 'mcp-test' })
  assert.equal(mcpSynced.source, 'mcp')
  assert.equal(mcpCalls, 1)
  const fallbackService = createServerWmsSyncService({
    db: mcpDb,
    config: { wms: { source: 'auto', restUsername: 'admin', restPassword: 'DEMO_ONLY_REDACTED', mcpUrl: 'http://127.0.0.1:8000', mcpKey: 'mcp-secret' } },
    client: {
      async adminLogin() { throw new Error('REST temporarily unavailable') },
      async fetchMcpInventory() { return { items: [row('MCP-FALLBACK', 'MCP-SPU')] } }
    }
  })
  const fallbackSynced = await fallbackService.refresh({ reason: 'auto-fallback-test' })
  assert.equal(fallbackSynced.source, 'mcp-fallback')
  mcpDb.close()

  shouldFail = true
  await assert.rejects(() => service.refresh({ reason: 'failure-test' }), /upstream unavailable/)
  assert.equal(service.getState().status, 'failed')
  assert.equal(db.listAllWmsInventory().length, 2)

  await app.fastify.close()
  db.close()
  const reopened = createDatabase({ filename })
  assert.equal(reopened.getWmsSyncState().status, 'failed')
  assert.equal(reopened.listAllWmsInventory().length, 2)
  reopened.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
  console.log('server-wms-regression: PASS (server credentials boundary, sync, projection, restart, failure retention)')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
