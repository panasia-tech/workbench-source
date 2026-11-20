import assert from 'node:assert/strict'
import { assertWritebackTaskReady } from '../../src/main/wms-match.js'
import { sanitizeInventorySkuPatch } from '../../src/main/api.js'
import { sanitizeWmsApiWritebackPatch } from '../../src/main/wms-writeback.js'

const base = {
  id: 'task-1',
  spuCode: 'SPU-260',
  apiSpuCode: 'SPU-260',
  apiSkuCode: 'SKU-260',
  apiSpuAssociated: true,
  apiSpuAssociationStatus: 'exact',
  aiReviewStatus: 'approved',
  lastStatus: 'success',
  lastRunAt: '2026-08-25T08:00:00.000Z'
}

assert.equal(assertWritebackTaskReady(base, 'SKU-260'), true)
for (const [field, value, message] of [
  ['apiSpuAssociationStatus', 'spu_not_found', 'SPU 精确关联'],
  ['aiReviewStatus', 'needs_review', '人工复核'],
  ['lastStatus', 'fail', '采集未成功']
]) {
  assert.throws(() => assertWritebackTaskReady({ ...base, [field]: value }, 'SKU-260'), new RegExp(message))
}
assert.throws(() => assertWritebackTaskReady({ ...base, aiCorrectionAt: '2026-08-25T09:00:00.000Z' }, 'SKU-260'), /成功复采/)
assert.throws(() => assertWritebackTaskReady(base, 'SKU-999'), /当前任务精确关联/)
assert.throws(() => assertWritebackTaskReady({ ...base, apiSpuCode: 'SPU-999' }, 'SKU-260'), /SPU 与 API SPU 不一致/)
assert.throws(() => assertWritebackTaskReady({ ...base, apiSkuCount: 2 }, 'SKU-260'), /多个 SKU|数据复核/)
assert.throws(() => assertWritebackTaskReady({ ...base, apiDataConflict: true }, 'SKU-260'), /多个 SKU|数据复核/)

// 可写字段就是服务端窄接口 SkuMarketInfoIn 的那三个。
// search_terms 被拿掉了：服务端压根没有这个字段，一直是白送；窄接口 extra=forbid
// 之后再送会 422，所以客户端这一侧也说清楚只有三个。
assert.deepEqual(sanitizeWmsApiWritebackPatch({ product_name: '新名称', brand: '品牌', model: '型号', search_terms: ['型号'] }), {
  product_name: '新名称', brand: '品牌', model: '型号'
})
assert.deepEqual(sanitizeInventorySkuPatch({ product_name: '新名称', model: '型号', search_terms: ['型号'] }), {
  product_name: '新名称', model: '型号'
})
for (const field of ['spec', 'spu_code', 'sale_price', 'suggest_price', 'cost_price']) {
  assert.throws(() => sanitizeWmsApiWritebackPatch({ [field]: 'forbidden' }), /禁止字段/)
  assert.throws(() => sanitizeInventorySkuPatch({ [field]: 'forbidden' }), /禁止字段/)
}

console.log('API writeback gate regression: passed (exact SPU + unique SKU + approved + successful current crawl + no identity/spec/price fields)')
