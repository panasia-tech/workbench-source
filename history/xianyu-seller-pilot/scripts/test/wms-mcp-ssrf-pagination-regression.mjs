import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { convergeInventoryPages } from '../../src/main/api.js'
import { fetchInventorySkusViaMcp } from '../../src/main/wms.js'

const root = resolve(process.cwd())
const wmsSource = readFileSync(resolve(root, 'src/main/wms.js'), 'utf8')

// MCP is a read-only adapter.  The transport must reject the URL before
// calling fetch, so a stored/edited URL cannot turn the desktop app into an
// SSRF client.  The production allowlist currently contains the company's
// REST/MCP host; this fixture never contacts it because fetch is replaced.
const unsafeUrls = [
  'http://127.0.0.1:8080/mcp',
  'https://localhost/mcp',
  'http://127.0.0.1/latest/meta-data',
  'http://127.0.0.1/mcp',
  'https://user:df72b778e7@example.invalid/mcp',
  'file:///tmp/wms-mcp'
]

const originalFetch = globalThis.fetch
const calls = []
const mcpPayload = {
  result: {
    content: [{
      type: 'text',
      text: '列: sku_code, spu_code, brand, model, product_name, spec, suggest_price, sale_price, location_code, product_type, status\n返回 1 行\n\nSKU-MCP-1\tSPU-MCP-1\t华硕\t战杀2K260\t华硕 战杀2K260\t27英寸\t1899\t1599\tA-01\t显示器\tIN_STOCK'
    }]
  }
}

function mcpResponse(payload = mcpPayload) {
  return {
    ok: true,
    status: 200,
    async text() { return `data: ${JSON.stringify(payload)}\n\n` }
  }
}

try {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return mcpResponse()
  }

  for (const url of unsafeUrls) {
    await assert.rejects(
      fetchInventorySkusViaMcp({ url, key: 'fixture-mcp-secret' }),
      undefined,
      `unsafe MCP URL must be rejected: ${url}`
    )
  }
  assert.equal(calls.length, 0, 'SSRF candidates must be rejected before network I/O')

  // The allowed host remains a bounded, read-only query.  A very large caller
  // limit is clamped to the transport maximum instead of becoming an unbounded
  // SQL result.  The fixture captures the request body but never logs or
  // prints the bearer secret.
  const rows = await fetchInventorySkusViaMcp({ url: 'http://127.0.0.1:8000', key: 'fixture-mcp-secret', limit: 1_000_000 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sku_code, 'SKU-MCP-1')
  assert.equal(calls.length, 1)
  const requestBody = JSON.parse(calls[0].options.body)
  assert.equal(requestBody.params.arguments.limit, 10_000)
  assert.match(requestBody.params.arguments.sql, /LIMIT 10000$/)
  assert.equal(requestBody.method, 'tools/call')
  assert.equal(requestBody.params.name, 'query_database')
  assert.equal(/\b(?:PUT|PATCH|DELETE)\b/i.test(requestBody.params.arguments.sql), false, 'MCP query must remain read-only')

  // Adapter failures must not echo bearer/API-key material into the IPC-safe
  // error.  This is intentionally an actual thrown transport error, not a
  // source-only redaction assertion.
  globalThis.fetch = async () => {
    throw new Error('authorization=Bearer fixture-mcp-secret api_key=fixture-api-key')
  }
  let safeError = null
  try {
    await fetchInventorySkusViaMcp({ url: 'http://127.0.0.1:8000', key: 'fixture-mcp-secret' })
  } catch (error) {
    safeError = error
  }
  assert.ok(safeError)
  assert.doesNotMatch(String(safeError.message), /fixture-mcp-secret|fixture-api-key/)

  // REST paging is tested here as the shared bounded-page contract used by
  // the WMS sync.  It must converge from total/has_more, reject illegal page
  // sizes, repeated pages, wrong page numbers and incomplete terminal pages.
  await assert.rejects(convergeInventoryPages({ pageSize: 101, fetchPage: async () => ({ items: [] }) }), /size (?:must be|必须是) 1-100/)
  await assert.rejects(convergeInventoryPages({ status: 'SHIPPED', fetchPage: async () => ({ items: [] }) }), /只允许读取 IN_STOCK/)

  const requestedPages = []
  const converged = await convergeInventoryPages({
    pageSize: 100,
    fetchPage: async ({ page, size, status }) => {
      requestedPages.push({ page, size, status })
      const count = page < 3 ? 100 : 5
      return {
        page,
        total: 205,
        has_more: page < 3,
        items: Array.from({ length: count }, (_, index) => ({
          sku_code: `SKU-${page}-${index}`,
          spu_code: `SPU-${page}-${index}`,
          model: `M-${page}-${index}`,
          status
        }))
      }
    }
  })
  assert.equal(converged.items.length, 205)
  assert.equal(converged.total, 205)
  assert.deepEqual(requestedPages.map(({ page }) => page), [1, 2, 3])
  assert.ok(requestedPages.every(({ size, status }) => size === 100 && status === 'IN_STOCK'))

  await assert.rejects(convergeInventoryPages({ pageSize: 100, maxRows: 150, fetchPage: async ({ page, status }) => ({ page, total: 200, has_more: true, items: Array.from({ length: 100 }, (_, i) => ({ sku_code: `SKU-${page}-${i}`, spu_code: `SPU-${page}-${i}`, status })) }) }), /超过安全上限 150/)
  await assert.rejects(convergeInventoryPages({ fetchPage: async ({ page, status }) => ({ page, total: 2, has_more: true, items: [{ sku_code: 'DUP', spu_code: 'DUP', status }] }) }), /分页重复/)
  await assert.rejects(convergeInventoryPages({ fetchPage: async () => ({ page: 2, total: 1, has_more: false, items: [{ sku_code: 'WRONG-PAGE', spu_code: 'WRONG-PAGE', status: 'IN_STOCK' }] }) }), /分页响应不一致/)
  await assert.rejects(convergeInventoryPages({ fetchPage: async ({ page, status }) => ({ page, total: 2, has_more: false, items: [{ sku_code: 'PARTIAL', spu_code: 'PARTIAL', status }] }) }), /has_more=false 但未收齐 total/)

  // Keep the security assertion tied to the implementation boundary too: the
  // MCP adapter must expose bounded timeout and explicit redirect handling,
  // while the query remains `query_database` read-only.
  assert.match(wmsSource, /AbortController/)
  assert.match(wmsSource, /redirect\s*:\s*['"]error['"]/) 
  assert.match(wmsSource, /MAX_MCP_ROWS\s*=\s*10000/)
  assert.match(wmsSource, /tools\/call/)
  assert.doesNotMatch(wmsSource, /mcpRequest[\s\S]{0,300}\b(?:PUT|PATCH|DELETE)\b/i)

  console.log('WMS MCP SSRF/pagination regression: passed (URL boundary, bounded read-only query, safe errors, convergent REST pages)')
} finally {
  globalThis.fetch = originalFetch
}
