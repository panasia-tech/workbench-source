import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'

const dataDir = mkdtempSync(join(tmpdir(), 'xianyu-spu-correction-recollect-'))
process.env.XIAN_YU_TASK_STORE_DIR = dataDir
try {
  const store = await import(`../../src/main/task-store.js?spu-correction=${Date.now()}`)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['品牌', '型号', 'SPU编号', '采购价'],
    ['Apple', 'Apple TV', 'SPU-TV-1', 800]
  ]), '行情任务')
  store.importSpreadsheet(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'spu-correction.xlsx')
  const task = store.getTasks({ page: 1, pageSize: 1 }).items[0]
  const corrected = store.applyManualTaskCorrection(task.id, { brand: 'Apple', model: 'Apple TV 4K', alias: 'Apple TV' })
  assert.equal(corrected.ok, true)
  let updated = store.getActiveTask(task.id)
  assert.equal(updated.spuCode, 'SPU-TV-1')
  assert.equal(updated.correctionWorkflowStatus, 'recollect_pending')
  const first = store.requestTaskRecollect(task.id, { mode: 'local', operator: 'qa' })
  const second = store.requestTaskRecollect(task.id, { mode: 'local', operator: 'qa' })
  assert.equal(first.recollectKey, second.recollectKey, 'recollect intent must be idempotent for one correction version')
  store.recordCorrectionOutcome(task.id, { status: 'empty', reason: '仍无在售' })
  updated = store.getActiveTask(task.id)
  assert.equal(updated.correctionWorkflowStatus, 'custom_search_pending')
  store.setSpuSearchPolicy('SPU-TV-1', { search: { mode: 'explicit', queries: ['Apple TV'] }, blacklist: { mode: 'append', terms: ['滤芯'] }, priceFence: { minListingPrice: 500 }, localization: { displayName: '苹果电视' } })
  const dto = store.getActiveTask(task.id)
  assert.deepEqual(dto.effectiveSearchPolicy.queries, ['Apple TV'])
  assert.equal(dto.localizedDisplayName, '苹果电视')
  store.recordCorrectionOutcome(task.id, { status: 'invalid_price', reason: '价格围栏仍未通过' })
  assert.equal(store.getActiveTask(task.id).correctionWorkflowStatus, 'price_review')
  console.log('SPU correction/recollect regression: passed (SPU stable, idempotent recollect, custom-search/price-review escalation)')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
