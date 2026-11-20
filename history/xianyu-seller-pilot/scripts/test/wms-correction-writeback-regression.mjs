import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import {
  assertVerifiedWmsWriteback,
  buildWmsWritebackAudit,
  sanitizeWmsApiWritebackPatch
} from '../../src/main/wms-writeback.js'

const dataDir = mkdtempSync(join(tmpdir(), 'xianyu-wms-correction-writeback-'))
process.env.XIAN_YU_TASK_STORE_DIR = dataDir

try {
  const store = await import(`../../src/main/task-store.js?wms-correction=${Date.now()}`)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['品牌', '型号', 'SPU编号', '采购价'],
    ['华硕', '战杀2K260', 'SPU-260', 1000]
  ]), '行情任务')
  store.importSpreadsheet(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'wms-correction.xlsx')
  const task = store.getTasks({ page: 1, pageSize: 1 }).items[0]

  const first = store.applyManualTaskCorrection(task.id, {
    brand: '华硕', model: 'ROG XG27AQM', keyword: '华硕 XG27AQM', alias: 'XG27AQM', operator: 'qa'
  })
  assert.equal(first.ok, true)
  let corrected = store.getActiveTask(task.id)
  assert.equal(corrected.spuCode, 'SPU-260')
  assert.equal(corrected.aiReviewStatus, 'needs_review')
  assert.equal(corrected.correctionReviewStatus, 'review_pending')
  assert.equal(corrected.correctionAudit.at(-1).before.model, '战杀2K260')
  assert.equal(corrected.correctionAudit.at(-1).after.model, 'ROG XG27AQM')

  const duplicate = store.applyManualTaskCorrection(task.id, {
    brand: '华硕', model: 'ROG XG27AQM', keyword: '华硕 XG27AQM', alias: 'XG27AQM', operator: 'qa'
  })
  assert.equal(duplicate.idempotent, true)
  const approvedBeforeRecollect = store.approveAiReview(task.id)
  assert.equal(approvedBeforeRecollect.ok, true)
  const firstRecollect = store.requestTaskRecollect(task.id, { mode: 'local', operator: 'qa' })
  const secondRecollect = store.requestTaskRecollect(task.id, { mode: 'local', operator: 'qa' })
  assert.equal(firstRecollect.recollectKey, secondRecollect.recollectKey)
  assert.equal(secondRecollect.idempotent, true)
  store.recordCorrectionOutcome(task.id, { status: 'success', reason: 'fixture recrawl success' })
  corrected = store.getActiveTask(task.id)
  assert.equal(corrected.correctionWorkflowStatus, 'success_pending_review')
  assert.equal(corrected.aiReviewStatus, 'needs_review', 'successful recrawl must require a second human review')
  assert.equal(store.approveAiReview(task.id).ok, true)

  const patch = sanitizeWmsApiWritebackPatch({ product_name: '华硕 XG27AQM', brand: '华硕', model: 'XG27AQM', search_terms: ['XG27AQM'] })
  assert.deepEqual(patch.search_terms, ['XG27AQM'])
  for (const field of ['spec', 'spu_code', 'sale_price', 'suggest_price']) {
    assert.throws(() => sanitizeWmsApiWritebackPatch({ [field]: 'forbidden' }), /禁止字段/)
  }
  const before = { sku_code: 'SKU-260', spu_code: 'SPU-260', product_name: '旧名称', brand: '华硕', model: '战杀2K260', status: 'IN_STOCK', updated_at: 'v1' }
  const after = { ...before, product_name: '华硕 XG27AQM', model: 'XG27AQM', search_terms: ['XG27AQM'], updated_at: 'v2' }
  assert.equal(assertVerifiedWmsWriteback({ task: { spuCode: 'SPU-260' }, skuCode: 'SKU-260', patch, before, after, expectedVersion: 'v1' }).ok, true)
  assert.throws(() => assertVerifiedWmsWriteback({ task: { spuCode: 'SPU-260' }, skuCode: 'SKU-260', patch, before, after: { ...after, spu_code: 'SPU-999' }, expectedVersion: 'v1' }), /SPU/)
  const audit = buildWmsWritebackAudit({ task: { id: task.id, spuCode: 'SPU-260' }, skuCode: 'SKU-260', patch, before, response: after, expectedVersion: 'v1', verified: true, idempotencyKey: 'k1' })
  assert.equal(audit.verified, true)
  assert.equal(audit.requested.sale_price, undefined)
  assert.equal(audit.idempotencyKey, 'k1')
  console.log('WMS correction/writeback regression: passed (correction -> review -> idempotent requeue -> successful recrawl -> GET-verified allowlisted writeback)')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
