import assert from 'node:assert/strict'

import {
  buildListingConditionalHeaders,
  listingRequestPath
} from '../../src/main/api.js'
import {
  buildListingUpdateBody,
  listingConcurrencyContract,
  mergeListingDto
} from '../../src/main/price-apply.js'

const current = {
  sku_code: 'SKU-CONTRACT-001',
  spu_code: 'SPU-CONTRACT-001',
  title: '合同测试商品',
  desc: null,
  price: 199,
  original_price: null,
  express_fee: null,
  images: [],
  item_biz_type: null,
  sp_biz_type: null,
  channel_cat_id: null,
  stuff_status: null,
  version: 11,
  suggest_price: 299,
  future_server_field: 'must not be lost in GET merge'
}

assert.equal(listingRequestPath('SKU/001'), '/listing/skus/SKU%2F001')
const merged = mergeListingDto(current, 229)
assert.equal(merged.future_server_field, current.future_server_field)
const body = buildListingUpdateBody(merged)
assert.equal(body.price, 229)
assert.equal(body.title, current.title)
assert.equal(body.suggest_price, undefined)
assert.equal(body.future_server_field, undefined)

const versionContract = listingConcurrencyContract(current, {})
assert.deepEqual(versionContract, { value: '11', kind: 'version', header: 'X-Expected-Version' })
assert.deepEqual(
  buildListingConditionalHeaders({ contract: versionContract, idempotencyKey: 'idempotency-001' }),
  { 'X-Expected-Version': '11', 'Idempotency-Key': 'idempotency-001' }
)
const etagContract = listingConcurrencyContract({ ...current, version: null }, { etag: '"etag-001"' })
assert.deepEqual(etagContract, { value: '"etag-001"', kind: 'etag', header: 'If-Match' })
assert.deepEqual(
  buildListingConditionalHeaders({ contract: etagContract, idempotencyKey: 'idempotency-002' }),
  { 'If-Match': '"etag-001"', 'Idempotency-Key': 'idempotency-002' }
)
const updatedAtContract = listingConcurrencyContract({ ...current, version: null, updated_at: '2026-08-25T11:00:00Z' }, {})
assert.deepEqual(updatedAtContract, { value: '2026-08-25T11:00:00Z', kind: 'updated_at', header: 'If-Unmodified-Since' })

assert.equal(listingConcurrencyContract({ ...current, version: null, updated_at: null }, {}), null)
assert.equal(buildListingConditionalHeaders({ contract: null, idempotencyKey: 'idempotency-003' }), null)
assert.equal(buildListingConditionalHeaders({ contract: versionContract, idempotencyKey: '' }), null)

// This is a contract-level assertion: no current version/ETag means the
// transport cannot construct a conditional PUT, so the caller must stop
// before invoking axios.put.  The full zero-call proof is in the apply gate.
assert.equal('suggest_price' in body, false)
assert.equal('price' in body, true)

console.log('api price contract regression: PASS')

