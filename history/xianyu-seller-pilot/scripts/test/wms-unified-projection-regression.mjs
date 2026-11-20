import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'

const storeDir = mkdtempSync(join(tmpdir(), 'xianyu-wms-projection-'))
process.env.XIAN_YU_TASK_STORE_DIR = storeDir

function workbook(rows) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['品牌', '名称（兼容型号）', 'SPU编号', '采购价'],
    ...rows
  ]), '行情任务')
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
}

try {
  const taskStore = await import('../../src/main/task-store.js')

  // A local Excel collection is never an implicit warehouse source. Before
  // the first successful API snapshot it is visible only as an auditable
  // blocked/no-source row and must not reach the executable queue.
  taskStore.importSpreadsheet(workbook([
    ['Excel品牌', 'Excel-A', 'SPU-A', 1000]
  ]), 'before-api.xlsx')
  const blocked = taskStore.getUnifiedTasks({ includeDisabled: true })
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].source, 'no_source')
  assert.equal(blocked[0].sourceOrigin, 'excel_extension')
  assert.equal(blocked[0].sourceStatus, 'blocked')
  assert.equal(blocked[0].enabled, false)
  assert.ok(blocked[0].reason)
  assert.equal(taskStore.getUnifiedTasks().length, 0, '未成功同步 API 时 Excel 不得进入执行投影')
  const blockedQueue = taskStore.getTaskQueues({ kind: 'all' })
  assert.equal(blockedQueue.items.length, 0, '未成功同步 API 时队列不得暴露可执行 Excel 任务')
  assert.equal(blockedQueue.sourceState.ready, false)
  assert.equal(blockedQueue.sourceState.source, 'no_source')
  assert.ok(blockedQueue.blockedReason)

  taskStore.replaceWmsSnapshot([
    { sku_code: 'SKU-A', spu_code: 'SPU-A', brand: '旧品牌', model: '旧型号', product_name: '旧名称', status: 'IN_STOCK' }
  ], '2026-08-25T08:00:00.000Z')
  taskStore.importSpreadsheet(workbook([
    ['Excel品牌', 'Excel-A', 'SPU-A', 1000],
    ['扩展品牌', '扩展-X', 'SPU-X', 800]
  ]), 'projection.xlsx')

  const first = taskStore.getUnifiedTasks({ includeDisabled: true })
  assert.equal(first.length, 2)
  const apiTask = first.find((task) => task.spuCode === 'SPU-A')
  const extensionTask = first.find((task) => task.spuCode === 'SPU-X')
  assert.equal(apiTask.source, 'api_spu')
  assert.equal(extensionTask.source, 'excel_extension')
  assert.equal(extensionTask.extensionReason, 'api_spu_missing')
  assert.equal(first.filter((task) => task.spuCode === 'SPU-A').length, 1)

  const correction = taskStore.applyManualTaskCorrection(apiTask.id, {
    brand: '人工品牌', model: '人工搜索型号', keyword: '人工搜索型号', alias: '人工别称'
  })
  assert.equal(correction.ok, true)
  const stableId = apiTask.id
  const corrected = taskStore.getActiveTask(stableId)
  assert.equal(corrected.brand, '人工品牌')
  assert.equal(corrected.aiReviewStatus, 'needs_review')

  taskStore.replaceWmsSnapshot([
    { sku_code: 'SKU-A', spu_code: 'SPU-A', brand: '新 API 品牌', model: '新 API 型号', product_name: '新 API 名称', status: 'IN_STOCK' }
  ], '2026-08-25T09:00:00.000Z')
  const refreshed = taskStore.getUnifiedTasks({ includeDisabled: true }).find((task) => task.spuCode === 'SPU-A')
  assert.equal(refreshed.id, stableId)
  assert.equal(refreshed.apiProductName, '新 API 名称')
  assert.equal(refreshed.brand, '人工品牌', 'API current fields and operator override remain separate')
  assert.equal(refreshed.model, '人工搜索型号')
  assert.equal(refreshed.aiReviewStatus, 'needs_review')
  assert.equal(taskStore.getApiSpuLedger()['SPU-A'].lastSeenAt, '2026-08-25T09:00:00.000Z')

  // A complete departure creates a tombstone; importing a replacement Excel
  // file cannot turn that historical API identity into an extension task.
  taskStore.replaceWmsSnapshot([
    { sku_code: 'SKU-Y', spu_code: 'SPU-Y', brand: 'Y', model: 'Y', product_name: 'Y', status: 'IN_STOCK' }
  ], '2026-08-25T10:00:00.000Z')
  taskStore.importSpreadsheet(workbook([
    ['Excel品牌', 'Excel-A', 'SPU-A', 1000],
    ['扩展品牌', '扩展-X', 'SPU-X', 800]
  ]), 'replacement.xlsx')
  const departed = taskStore.getUnifiedTasks({ includeDisabled: true })
  assert.equal(departed.some((task) => task.spuCode === 'SPU-A'), false)
  assert.equal(taskStore.getApiSpuLedger()['SPU-A'].active, false)

  taskStore.replaceWmsSnapshot([
    { sku_code: 'SKU-A2', spu_code: 'SPU-A', brand: '回库品牌', model: '回库型号', product_name: '回库名称', status: 'IN_STOCK' },
    { sku_code: 'SKU-Y', spu_code: 'SPU-Y', brand: 'Y', model: 'Y', product_name: 'Y', status: 'IN_STOCK' }
  ], '2026-08-25T11:00:00.000Z')
  const returned = taskStore.getUnifiedTasks({ includeDisabled: true }).find((task) => task.spuCode === 'SPU-A')
  assert.equal(returned.id, stableId)
  assert.equal(returned.source, 'api_spu')
  assert.equal(taskStore.getUnifiedTasks({ includeDisabled: true }).filter((task) => task.spuCode === 'SPU-A').length, 1)

  // The scheduler consumes getUnifiedTasks() as its API source; keeping this
  // assertion in the pure task-store fixture avoids loading Electron's GUI
  // module in a Node-only regression.
  assert.equal(taskStore.getUnifiedTasks().every((task) => task.source === 'api_spu' || task.source === 'excel_extension'), true)

  console.log('WMS unified projection regression: passed (ledger, tombstone, Excel extension, stable operator task, scheduler source)')
} finally {
  rmSync(storeDir, { recursive: true, force: true })
}
