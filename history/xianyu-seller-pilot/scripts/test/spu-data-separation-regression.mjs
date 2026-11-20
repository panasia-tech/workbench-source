import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'

const dataDir = mkdtempSync(join(tmpdir(), 'xianyu-spu-data-separation-'))
process.env.XIAN_YU_TASK_STORE_DIR = dataDir

try {
  const taskStore = await import(`../../src/main/task-store.js?spu-data-separation=${Date.now()}`)
  const productName = 'SPU：PHILIPS EVNIA T #27M2N5500P PHILIPS飞利浦 1台'
  const taskSpuCode = '90001'

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['品牌', '名称（兼容型号）', '别称（可能由SPU读取内容生成）', 'SPU编号', '采购价', '分类'],
    ['飞利浦', '27M2N5500P', '', taskSpuCode, 1200, '显示器']
  ]), '行情任务')
  taskStore.importSpreadsheet(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'spu-separation.xlsx')

  // A matching API row decorates the active task. Its commodity name is not a
  // replacement for the task-sheet SPU code, and its cleaned model is already
  // covered by the display search so it must not create a duplicate query.
  taskStore.replaceWmsCache([{
    sku_code: 'UK02438064399',
    spu_code: taskSpuCode,
    brand: '飞利浦',
    model: '27M2N5500P',
    product_name: productName,
    status: 'IN_STOCK'
  }], '2026-08-24T19:17:43.000Z')

  const sample = taskStore.getSample()
  const preview = sample.rows[0]
  assert.equal(sample.isBuiltin, false)
  assert.equal(preview.spuCode, taskSpuCode, 'sample must retain the task-sheet SPU code')
  assert.equal(preview.apiSpuCode, taskSpuCode, 'sample must expose the API SPU code')
  assert.equal(preview.apiProductName, productName)
  assert.equal(preview.apiSpuProductName, productName)
  assert.equal(preview.apiSpuCleanedAlias, null)
  assert.equal(preview.apiSpuAlias, null)
  assert.equal(preview.apiSpuAliasUsed, false)
  assert.equal(preview.searchKeywords.filter((value) => value === '27M2N5500P').length, 1)

  // History is deliberately fed a distinct API SPU code. It must be recorded as
  // a data mismatch, not as an associated API row.
  const run = taskStore.startRun({ total: 1 })
  const saved = taskStore.recordRunResult(run.id, preview, {
    price: 1500,
    status: 'success',
    source: 'spu-separation-regression',
    wmsMatch: {
      associated: false,
      associationStatus: 'spu_not_found',
      associationPercent: null,
      sku_code: 'UK02438064399',
      spu_code: '90002',
      brand: '飞利浦',
      model: '27M2N5500P',
      product_name: productName,
    }
  })
  assert.equal(saved.spuCode, taskSpuCode)
  assert.equal(saved.apiSpuCode, null)
  assert.equal(saved.apiSpuAssociationStatus, 'spu_not_found')
  assert.equal(saved.apiSpuProductName, null)
  assert.equal(saved.apiSpuCleanedAlias, null)
  assert.equal(saved.apiSpuAlias, null)
  assert.equal(saved.apiSpuAliasUsed, false)

  const historical = taskStore.getRunResults({ page: 1, pageSize: 10 }).items[0]
  assert.equal(historical.spuCode, taskSpuCode, 'historical task SPU must survive result writes')
  assert.equal(historical.apiSpuCode, taskSpuCode, '历史查询应刷新当前 API-SPU 主数据')
  assert.equal(historical.apiSpuAssociationStatus, 'exact')
  assert.equal(historical.historicalApiAssociationStatus, 'spu_not_found', '旧的不匹配证据必须保留')
  assert.equal(historical.apiSpuProductName, productName)
  assert.equal(historical.apiSpuCleanedAlias, null)
  assert.equal(historical.apiSpuAliasUsed, false)

  const outputPath = join(dataDir, 'spu-mapping.xlsx')
  const exported = taskStore.exportWmsMapping({ outputPath })
  assert.equal(exported.ok, true)
  assert.equal(existsSync(outputPath), true)
  const exportedWorkbook = XLSX.read(readFileSync(outputPath), { type: 'buffer', cellDates: false })
  const exportedRows = XLSX.utils.sheet_to_json(exportedWorkbook.Sheets['行情WMS对应表'], { header: 1, raw: false, defval: '' })
  const headers = exportedRows[0]
  const row = exportedRows[1]
  for (const header of ['别称（可能由SPU读取内容生成）', '别称来源', '任务SPU编码', 'API SPU编码', 'API商品名原文', 'SPU关联状态', 'SPU关联百分比']) {
    assert.ok(headers.includes(header), `mapping export must include ${header}`)
  }
  assert.equal(row[headers.indexOf('任务SPU编码')], taskSpuCode)
  assert.equal(row[headers.indexOf('别称（可能由SPU读取内容生成）')], '')
  assert.equal(row[headers.indexOf('API商品名原文')], productName)
  assert.equal(row[headers.indexOf('SPU关联状态')], 'exact')
  assert.equal(row[headers.indexOf('SPU关联百分比')], '100')

  console.log('spu data separation regression: passed (task SPU, API SPU, raw product name, cleaned alias, history and export)')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
