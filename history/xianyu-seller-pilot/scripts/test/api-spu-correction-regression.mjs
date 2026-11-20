import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'

const dataDir = mkdtempSync(join(tmpdir(), 'xianyu-api-spu-correction-'))
process.env.XIAN_YU_TASK_STORE_DIR = dataDir

try {
  const store = await import(`../../src/main/task-store.js?api-spu-correction=${Date.now()}`)
  // This regression exercises the API-SPU correction path, so establish the
  // required authoritative snapshot before importing the matching Excel row.
  // A correction row without a successful API source must remain blocked and
  // is covered by the unified projection regression instead.
  store.replaceWmsSnapshot([{
    sku_code: 'SKU-260', spu_code: 'SPU-260', brand: '华硕', model: '战杀2K260',
    product_name: '华硕 战杀2K260', status: 'IN_STOCK'
  }], '2026-08-25T08:00:00.000Z')
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['品牌', '型号', 'SPU编号', '采购价'],
    ['华硕', '战杀2K260', 'SPU-260', 1000]
  ]), '行情任务')
  store.importSpreadsheet(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), '纠错任务.xlsx')
  const task = store.getUnifiedTaskList({ page: 1, pageSize: 1, includeDisabled: true }).items[0]
  assert.equal(task.source, 'api_spu')
  const result = store.applyManualTaskCorrection(task.id, {
    brand: '华硕',
    model: 'ROG XG27AQM',
    keyword: '华硕 XG27AQM',
    searchTerms: ['华硕 XG27AQM', '华硕 ROG XG27AQM', 'ROG XG27AQM', 'XG27AQM'],
    alias: 'XG27AQM 人工别名',
    operator: 'qa'
  })
  assert.equal(result.ok, true)
  const updated = store.getActiveTask(task.id)
  assert.equal(updated.model, 'ROG XG27AQM')
  assert.equal(updated.effectiveAlias, 'XG27AQM 人工别名')
  assert.equal(updated.aiReviewStatus, 'needs_review')
  assert.equal(updated.aiReviewReason, '人工修改后待复核')
  assert.ok(updated.searchKeywords.includes('华硕 XG27AQM'))
  assert.ok(updated.searchKeywords.includes('华硕 ROG XG27AQM'))
  assert.equal(updated.correctionAudit.at(-1).operator, 'qa')
  assert.equal(updated.correctionAudit.at(-1).correctionVersion.length, 24)
  assert.equal(updated.spuCode, 'SPU-260', 'manual search correction must not change the task SPU')
  assert.equal(store.getTaskQueues({ kind: 'review', page: 1, pageSize: 10 }).total, 1, 'manual correction must enter the five-state review bucket')
  console.log('API-SPU correction regression: passed (manual edit -> review; SPU preserved)')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
