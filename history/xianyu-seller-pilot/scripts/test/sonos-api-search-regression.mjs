import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const storeDir = mkdtempSync(join(tmpdir(), 'xianyu-sonos-search-'))
process.env.XIAN_YU_TASK_STORE_DIR = storeDir

try {
  const taskStore = await import('../../src/main/task-store.js')
  const { searchQueriesForTask } = await import('../../src/main/search-queries.js')

  taskStore.replaceWmsCache([{
    sku_code: 'SKU-SONOS-PLAY5',
    spu_code: 'SPU-SONOS-PLAY5',
    brand: 'SONOS',
    model: 'PLAY5',
    product_name: 'SONOS PLAY5',
    status: 'IN_STOCK'
  }], '2026-08-26T00:00:00.000Z')

  const sonosTask = taskStore.getUnifiedTasks({ includeDisabled: true })[0]
  assert.equal(sonosTask.keyword, 'Sonos PLAY5', 'Sonos API-SPU 默认关键词必须包含规范品牌和型号')
  assert.deepEqual(sonosTask.searchKeywords, ['Sonos PLAY5'], 'Sonos API-SPU 不能退化为只搜型号')
  assert.deepEqual(searchQueriesForTask(sonosTask), ['Sonos PLAY5'], '调度执行必须消费同一个 Sonos 全名称搜索词')

  const explicit = taskStore.applyTaskPatches([{ id: sonosTask.id, searchKeywords: ['PLAY5 白色'] }])
  assert.equal(explicit.ok, true)
  assert.deepEqual(taskStore.getActiveTask(sonosTask.id).searchKeywords, ['PLAY5 白色'], '人工明确搜索词继续优先于 Sonos 默认规则')

  taskStore.replaceWmsCache([{
    sku_code: 'SKU-NON-SONOS',
    spu_code: 'SPU-NON-SONOS',
    brand: 'Bose',
    model: 'QC45',
    product_name: 'Bose QC45',
    status: 'IN_STOCK'
  }], '2026-08-26T00:01:00.000Z')
  assert.deepEqual(taskStore.getUnifiedTasks({ includeDisabled: true })[0].searchKeywords, ['QC45'], '非 Sonos API-SPU 保持原有默认搜索行为')

  console.log('Sonos API search regression: passed (brand + model default, explicit override, non-Sonos compatibility)')
} finally {
  rmSync(storeDir, { recursive: true, force: true })
}
