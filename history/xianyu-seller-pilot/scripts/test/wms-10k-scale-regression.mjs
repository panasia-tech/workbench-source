import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSpuCatalog } from '../../src/main/wms-match.js'
import { convergeInventoryPages } from '../../src/main/api.js'

const rows = []
for (let index = 0; index < 10_000; index += 1) {
  const spu = `SPU-${String(index).padStart(5, '0')}`
  rows.push({ sku_code: `${spu}-A`, spu_code: spu, brand: '品牌', model: `型号-${index}`, product_name: `商品-${index}`, status: 'IN_STOCK' })
  rows.push({ sku_code: `${spu}-B`, spu_code: spu, brand: '品牌', model: `型号-${index}`, product_name: `商品-${index}`, status: 'IN_STOCK' })
}

const pageSize = 100
const calls = []
const result = await convergeInventoryPages({
  pageSize,
  maxRows: rows.length,
  fetchPage: async ({ page, size, status }) => {
    calls.push({ page, size, status })
    const start = (page - 1) * size
    const items = rows.slice(start, start + size)
    return { items, total: rows.length, page, has_more: start + items.length < rows.length }
  }
})
assert.equal(result.items.length, rows.length)
assert.equal(result.total, rows.length)
assert.equal(result.pageCount, 200)
assert.equal(calls.length, 200)
assert.equal(calls.every((call) => call.size <= 100 && call.status === 'IN_STOCK'), true)
assert.equal(buildSpuCatalog(result.items).items.length, 10_000, 'multiple SKUs aggregate into one exact SPU row')

await assert.rejects(
  convergeInventoryPages({
    fetchPage: async () => ({ items: [], total: 10, page: 1, has_more: false })
  }),
  /首页为空/
)
await assert.rejects(
  convergeInventoryPages({
    fetchPage: async ({ page }) => ({
      items: [{ sku_code: 'DUP', spu_code: 'SPU-DUP', status: 'IN_STOCK' }],
      total: 2,
      page,
      has_more: page === 1
    })
  }),
  /分页重复/
)
await assert.rejects(
  convergeInventoryPages({
    fetchPage: async ({ page }) => ({
      items: [{ sku_code: `SKU-${page}`, spu_code: `SPU-${page}`, status: 'IN_STOCK' }],
      total: 2,
      page,
      has_more: false
    })
  }),
  /has_more=false/
)
await assert.rejects(
  convergeInventoryPages({
    fetchPage: async ({ page }) => ({
      items: [{ sku_code: `SKU-${page}`, spu_code: `SPU-${page}`, status: 'SHIPPED' }],
      total: 1,
      page,
      has_more: false
    })
  }),
  /非 IN_STOCK/
)

const storeDir = mkdtempSync(join(tmpdir(), 'xianyu-wms-10k-'))
process.env.XIAN_YU_TASK_STORE_DIR = storeDir
try {
  const taskStore = await import('../../src/main/task-store.js')
  taskStore.replaceWmsSnapshot(rows, '2026-08-25T12:00:00.000Z')
  const page = taskStore.getUnifiedTaskList({ page: 100, pageSize: 100, includeDisabled: true })
  assert.equal(page.total, 10_000)
  assert.equal(page.items.length, 100)
  assert.equal(page.pageSize, 100)
  assert.equal(taskStore.getUnifiedTaskList({ page: 1, pageSize: 100_000, includeDisabled: true }).items.length, 500, 'renderer page is bounded to 500 rows')
  console.log('WMS 10k scale regression: passed (convergent paging, duplicate/partial rejection, 10k SPU projection, bounded query)')
} finally {
  rmSync(storeDir, { recursive: true, force: true })
}
