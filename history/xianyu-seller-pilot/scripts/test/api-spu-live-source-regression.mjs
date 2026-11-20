import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'

const storeDir = mkdtempSync(join(tmpdir(), 'xianyu-api-spu-source-'))
process.env.XIAN_YU_TASK_STORE_DIR = storeDir

try {
  const taskStore = await import('../../src/main/task-store.js')
  taskStore.replaceWmsCache([
    {
      sku_code: 'SKU-A', spu_code: 'SPU-A', brand: '华硕', model: '战杀2K260',
      product_name: '华硕 战杀2K260', spec: '27英寸', sale_price: '1599',
      suggest_price: '1899', status: 'IN_STOCK'
    }
  ], '2026-08-25T08:00:00.000Z')

  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['品牌', '名称（兼容型号）', 'SPU编号', '采购价'],
    ['华硕', '旧 Excel 名称', 'SPU-A', 1000],
    ['戴尔', '仓库外扩展型号', 'SPU-X', 800]
  ])
  XLSX.utils.book_append_sheet(workbook, sheet, '行情任务')
  taskStore.importSpreadsheet(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), '扩展采购.xlsx')

  const first = taskStore.getUnifiedTasks()
  assert.equal(first.length, 2, 'API-SPU + API 不存在的 Excel 扩展任务')
  assert.equal(first.filter((task) => task.spuCode === 'SPU-A').length, 1, '相同 SPU 不重复爬取')
  const apiTask = first.find((task) => task.spuCode === 'SPU-A')
  assert.equal(apiTask.source, 'api_spu')
  assert.equal(apiTask.name, '华硕 战杀2K260', 'API 商品名是自动任务的当前名称')
  assert.equal(taskStore.setTaskEnabled(apiTask.id, false)?.enabled, false)
  assert.equal(taskStore.getUnifiedTasks().some((task) => task.spuCode === 'SPU-A'), false, '禁用 API-SPU 后不会让 Excel 同 SPU 重新进入')
  assert.equal(taskStore.setTaskEnabled(apiTask.id, true)?.enabled, true)
  const extraTask = first.find((task) => task.spuCode === 'SPU-X')
  assert.equal(extraTask.source, 'excel_extension', 'Excel 只保留 API 缺失的扩展 SPU')
  assert.equal(extraTask.extensionReason, 'api_spu_missing')
  assert.equal(taskStore.getTasks({ page: 1, pageSize: 20 }).total, 2)

  // An API row may carry a display-only product_name without a model. It must
  // fall back to the explicit SPU identity, never turn that display text into
  // a real search query.
  taskStore.replaceWmsCache([
    {
      sku_code: 'SKU-A', spu_code: 'SPU-A', brand: '华硕', model: '战杀2K260',
      product_name: '华硕 战杀2K260', spec: '27英寸', sale_price: '1599',
      suggest_price: '1899', status: 'IN_STOCK'
    },
    {
      sku_code: 'SKU-NO-MODEL', spu_code: 'SPU-NO-MODEL', brand: '测试品牌', model: '',
      product_name: '测试品牌 超长展示商品名 1台', sale_price: '299', status: 'IN_STOCK'
    }
  ], '2026-08-25T08:30:00.000Z')
  const noModelTask = taskStore.getUnifiedTasks({ includeDisabled: true }).find((task) => task.spuCode === 'SPU-NO-MODEL')
  assert.ok(noModelTask)
  assert.equal(noModelTask.model, 'SPU-NO-MODEL', 'API 缺失 model 时必须回退到明确 SPU')
  assert.deepEqual(noModelTask.searchKeywords, ['SPU-NO-MODEL'], 'API product_name 只能作为证据，不能成为隐式搜索词')
  assert.equal(noModelTask.searchKeywords.includes('测试品牌 超长展示商品名 1台'), false)
  const apiAliasSave = taskStore.setTaskAliases(noModelTask.id, ['测试品牌人工别称'])
  assert.equal(apiAliasSave.ok, true)
  const noModelAliased = taskStore.getActiveTask(noModelTask.id)
  assert.equal(noModelAliased.searchFieldLabels.at(-1), '别称（人工填写）', 'API 任务中的人工别称不能标为 API 商品字段')
  taskStore.replaceWmsCache([
    {
      sku_code: 'SKU-A', spu_code: 'SPU-A', brand: '华硕', model: '战杀2K260',
      product_name: '华硕 战杀2K260', spec: '27英寸', sale_price: '1599',
      suggest_price: '1899', status: 'IN_STOCK'
    }
  ], '2026-08-25T08:45:00.000Z')

  const run = taskStore.startRun({ source: 'api_spu', total: 1 })
  taskStore.recordRunResult(run.id, apiTask, {
    status: 'success', price: 1800, source: 'fixture', searchKeywords: ['战杀2K260'],
    snapshotEntries: [], queryLogs: []
  })
  taskStore.finishRun(run.id, { status: 'done' })
  taskStore.replaceWmsCache([
    {
      sku_code: 'SKU-A', spu_code: 'SPU-A', brand: '华硕', model: '战杀2K260',
      product_name: '华硕 战杀2K260', spec: '27英寸', sale_price: '1699',
      suggest_price: '1899', status: 'IN_STOCK'
    }
  ], '2026-08-25T09:00:00.000Z')
  const history = taskStore.getRunResults({ page: 1, pageSize: 20 }).items.find((row) => row.taskId === apiTask.id)
  assert.equal(history.apiSalePrice, '1699', '历史查询读取当前 API 销售价而非旧快照')
  assert.equal(history.apiSnapshotSyncedAt, '2026-08-25T09:00:00.000Z')

  taskStore.replaceWmsCache([], null)
  const unsynced = taskStore.getRunResults({ page: 1, pageSize: 20 }).items.find((row) => row.taskId === apiTask.id)
  assert.equal(unsynced.apiSpuAssociationStatus, 'api_not_synced', '没有同步时间时不能误报 SPU 已消失')
  assert.equal(unsynced.apiSalePrice, '1599', '未同步时保留历史行中旧 current API 销售价')

  taskStore.replaceWmsCache([
    {
      sku_code: 'SKU-A', spu_code: 'SPU-A', brand: '华硕', model: '战杀2K260',
      product_name: '华硕 战杀2K260', spec: '27英寸', sale_price: '1699',
      suggest_price: '1899', status: 'IN_STOCK'
    }
  ], '2026-08-25T09:30:00.000Z')
  const ledgerBeforeDeparture = taskStore.getApiSpuLedger()['SPU-A']
  assert.equal(ledgerBeforeDeparture.active, true)
  assert.equal(ledgerBeforeDeparture.taskId, apiTask.id)
  taskStore.replaceWmsCache([], '2026-08-25T10:30:00.000Z')
  const emptyCache = taskStore.getRunResults({ page: 1, pageSize: 20 }).items.find((row) => row.taskId === apiTask.id)
  assert.equal(emptyCache.apiSpuAssociationStatus, 'spu_not_found', '已同步但当前缓存为空时不能继续声称 exact')
  assert.equal(emptyCache.apiSpuAssociated, false)
  assert.equal(emptyCache.apiSalePrice, null, '当前缓存为空时必须清除当前 API 销售价')
  assert.equal(emptyCache.historicalApiSalePrice, '1599', '当前缓存为空时仍保留历史 API 价格证据')
  assert.equal(emptyCache.historicalApiProductName, '华硕 战杀2K260', '当前缓存为空时仍保留历史 API 商品证据')
  const tombstone = taskStore.getApiSpuLedger()['SPU-A']
  assert.equal(tombstone.active, false, '离库只更新 tombstone，不删除 API 身份')
  assert.equal(tombstone.taskId, apiTask.id)
  assert.equal(taskStore.getUnifiedTasks({ includeDisabled: true }).filter((task) => task.spuCode === 'SPU-A').length, 0, '历史 API tombstone 阻止同 SPU Excel 自动重入')

  taskStore.replaceWmsCache([{
    sku_code: 'SKU-OTHER', spu_code: 'SPU-OTHER', brand: '其他', model: 'Other',
    product_name: '其他商品', sale_price: '99', status: 'IN_STOCK'
  }], '2026-08-25T10:00:00.000Z')
  const disappeared = taskStore.getRunResults({ page: 1, pageSize: 20 }).items.find((row) => row.taskId === apiTask.id)
  assert.equal(disappeared.apiSpuAssociationStatus, 'spu_not_found')
  assert.equal(disappeared.apiSalePrice, null, '当前 API 缺少 SPU 时不继续显示旧当前销售价')
  assert.equal(disappeared.historicalApiSalePrice, '1599')
  taskStore.replaceWmsCache([
    {
      sku_code: 'SKU-A', spu_code: 'SPU-A', brand: '华硕', model: '战杀2K260',
      product_name: '华硕 战杀2K260', spec: '27英寸', sale_price: '1699',
      suggest_price: '1899', status: 'IN_STOCK'
    }
  ], '2026-08-25T09:00:00.000Z')
  const reappeared = taskStore.getUnifiedTasks({ includeDisabled: true }).find((task) => task.spuCode === 'SPU-A')
  assert.equal(reappeared.id, apiTask.id, 'API SPU 重现复用 ledger taskId')
  assert.equal(taskStore.getApiSpuLedger()['SPU-A'].active, true)

  const corrected = taskStore.applyManualTaskCorrection(apiTask.id, {
    brand: '华硕', model: '战杀2K260 新搜索名', alias: '战杀 2K260'
  })
  assert.equal(corrected.ok, true, 'API-SPU 任务可以在软件内修改搜索信息')
  assert.equal(taskStore.getActiveTask(apiTask.id).aiReviewStatus, 'needs_review')
  assert.equal(taskStore.approveAiReview(apiTask.id).ok, true)
  assert.equal(taskStore.getActiveTask(apiTask.id).aiReviewStatus, 'approved')

  // ---- 成本价来自库存 API 本身 ----------------------------------------------
  // 桌面端以前只认 Excel 的「采购价」列，库存 API 生成的任务成本价永远是空的，
  // 调价台因此永远停在需复核。服务端对行情工作台放行 cost_price 后，这里必须
  // 把它当成成本价（成本底价的唯一来源），但不能覆盖人工填过的值。
  taskStore.replaceWmsCache([
    { sku_code: 'SKU-C1', spu_code: 'SPU-C1', brand: '华硕', model: 'C1', product_name: '成本价可读', cost_price: '1200.00', sale_price: '1599', suggest_price: '1899', status: 'IN_STOCK' },
    { sku_code: 'SKU-C2', spu_code: 'SPU-C2', brand: '华硕', model: 'C2', product_name: '成本价被脱敏', sale_price: '1599', suggest_price: '1899', status: 'IN_STOCK' },
    { sku_code: 'SKU-C3a', spu_code: 'SPU-C3', brand: '华硕', model: 'C3', product_name: '两个批次', cost_price: '1000', status: 'IN_STOCK' },
    { sku_code: 'SKU-C3b', spu_code: 'SPU-C3', brand: '华硕', model: 'C3', product_name: '两个批次', cost_price: '1400', status: 'IN_STOCK' }
  ], '2026-09-15T02:00:00.000Z')
  const costTasks = new Map(taskStore.getUnifiedTasks({ includeDisabled: true })
    .map((task) => [task.spuCode, task]))

  const readable = costTasks.get('SPU-C1')
  assert.equal(readable.referencePrice, 1200, '库存 API 的成本价就是任务的成本价')
  assert.equal(readable.referencePriceStatus, 'valid')
  assert.equal(readable.apiCostPrice, '1200.00', '原始值保留为证据')

  const masked = costTasks.get('SPU-C2')
  assert.equal(masked.referencePrice, null, '服务端脱敏时没有成本价')
  assert.equal(masked.referencePriceStatus, 'missing')
  assert.equal(masked.referencePriceReason, '', '拿不到不是错误，不编造理由')

  const mixed = costTasks.get('SPU-C3')
  assert.equal(mixed.referencePrice, null, '同一 SPU 多个不同成本价时不自动选取')
  assert.equal(mixed.referencePriceStatus, 'missing')
  assert.match(mixed.referencePriceReason, /成本价不一致/, '界面要能解释这个破折号')
  assert.deepEqual(mixed.apiCostPriceValues, ['1000', '1400'])

  // 建议价/销售价都不是成本：任何一条都不能被当成成本底价顶上来。
  for (const task of [masked, mixed]) {
    assert.notEqual(task.referencePrice, 1899)
    assert.notEqual(task.referencePrice, 1599)
  }

  console.log('API-SPU live source regression: passed (API primary, Excel extras, stable IDs, live history price, cost price from inventory, correction workflow)')
} finally {
  rmSync(storeDir, { recursive: true, force: true })
}
