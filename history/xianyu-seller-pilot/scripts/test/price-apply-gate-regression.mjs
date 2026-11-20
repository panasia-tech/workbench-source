import assert from 'node:assert/strict'

import {
  applyPriceSelection,
  buildListingUpdateBody,
  currentListingPrice,
  listingConcurrencyContract,
  mergeListingDto
} from '../../src/main/price-apply.js'

const NOW = Date.parse('2026-08-25T12:00:00.000Z')

function preview(overrides = {}) {
  return {
    previewId: 'preview-001',
    policyVersion: 'price-policy-v1',
    status: 'selected',
    spuCode: 'SPU-ASUS-001',
    skuCode: 'SKU-ASUS-001',
    evaluatedAt: '2026-08-25T08:00:00.000Z',
    policy: { freshnessHours: 24, minimumSampleCount: 3, maxSpreadRatio: 0.25 },
    market: { sampleCount: 3, spreadRatio: 0.1 },
    costFloor: 100,
    selectedPrice: 130,
    selectionIdempotencyKey: 'SPU-ASUS-001:SKU-ASUS-001:preview-001:price-policy-v1:130',
    selection: { confirmedAt: '2026-08-25T08:01:00.000Z', operatorId: 'operator-test' },
    ...overrides
  }
}

function listing(overrides = {}) {
  return {
    sku_code: 'SKU-ASUS-001',
    spu_code: 'SPU-ASUS-001',
    title: '华硕显示器',
    desc: '保留原始描述',
    price: 120,
    original_price: 150,
    express_fee: 0,
    images: ['https://example.invalid/a.jpg'],
    item_biz_type: 1,
    sp_biz_type: 2,
    channel_cat_id: 'monitor',
    stuff_status: 99,
    version: 7,
    suggest_price: 200,
    unknown_future_field: { preserved: true },
    ...overrides
  }
}

function auth(role = 'ADMIN') {
  return { source: 'rest', token: 'fixture-admin-token', role }
}

let getCalls = 0
let putCalls = 0
let cached = null
let audits = []
const validBefore = listing()
const validAfter = listing({ price: 130, version: 8 })
const success = await applyPriceSelection({
  preview: preview(),
  skuCode: 'SKU-ASUS-001',
  auth: auth(),
  now: NOW,
  fetchCurrentListing: async () => {
    getCalls += 1
    return { item: getCalls === 1 ? validBefore : validAfter, headers: {} }
  },
  putListing: async (_sku, body, options) => {
    putCalls += 1
    assert.equal(body.price, 130)
    assert.equal(body.title, validBefore.title)
    assert.equal(options.headers['X-Expected-Version'], '7')
    assert.ok(options.headers['Idempotency-Key'])
  },
  recordAudit: async (audit) => audits.push(audit),
  updateCache: async (after) => { cached = after }
})
assert.equal(success.ok, true)
assert.equal(success.status, 'applied')
assert.equal(success.putIssued, true)
assert.equal(getCalls, 2, 'valid flow must GET before and after one PUT')
assert.equal(putCalls, 1, 'valid flow must issue exactly one PUT')
assert.equal(cached.price, 130, 'cache updates only after exact GET')
assert.equal(audits.at(-1).status, 'success')

const merged = mergeListingDto(validBefore, 130)
assert.deepEqual(merged.unknown_future_field, { preserved: true })
const body = buildListingUpdateBody(merged)
assert.equal(body.price, 130)
assert.equal('suggest_price' in body, false, 'suggest_price must never enter listing PUT')
assert.equal(currentListingPrice(validBefore), 120)
assert.deepEqual(listingConcurrencyContract(validBefore, {}), { value: '7', kind: 'version', header: 'X-Expected-Version' })

async function blockedCase(name, current, expectedReason, options = {}) {
  let gets = 0
  let puts = 0
  const result = await applyPriceSelection({
    preview: options.preview || preview(),
    skuCode: 'SKU-ASUS-001',
    auth: options.auth || auth(),
    now: NOW,
    hasAppliedIdempotency: options.hasAppliedIdempotency || (async () => false),
    fetchCurrentListing: async () => { gets += 1; return { item: current, headers: options.headers || {} } },
    putListing: async () => { puts += 1 },
    recordAudit: async (audit) => assert.equal(audit.putIssued, false)
  })
  assert.equal(result.ok, false, name)
  assert.equal(result.reason, expectedReason, name)
  assert.equal(puts, 0, `${name}: blocked gate must issue zero PUT calls`)
  return { result, gets }
}

await blockedCase('missing current listing price', listing({ price: null }), 'blocked_missing_price')
await blockedCase('missing version contract', listing({ version: null, updated_at: null }), 'blocked_no_version_contract')
await blockedCase('stale preview', listing(), 'blocked_stale_preview', { preview: preview({ evaluatedAt: '2026-08-23T00:00:00.000Z' }) })
await blockedCase('invalid custom selection', listing(), 'blocked_below_cost_floor', { preview: preview({ selectedPrice: 80 }) })
await blockedCase('wrong role', listing(), 'blocked_admin_required', { auth: auth('WAREHOUSE') })
await blockedCase('MCP source', listing(), 'blocked_admin_required', { auth: { source: 'mcp', token: 'fixture', role: 'ADMIN' } })
await blockedCase('duplicate idempotency', listing(), 'blocked_duplicate_idempotency', { hasAppliedIdempotency: async () => true })

let conflictPuts = 0
let conflictAudit = null
const conflict = await applyPriceSelection({
  preview: preview(), skuCode: 'SKU-ASUS-001', auth: auth(), now: NOW,
  fetchCurrentListing: async () => ({ item: listing(), headers: {} }),
  putListing: async () => { conflictPuts += 1; throw new Error('409 conflict') },
  recordAudit: async (audit) => { conflictAudit = audit }
})
assert.equal(conflict.status, 'failed')
assert.equal(conflict.putIssued, true)
assert.equal(conflictPuts, 1)
assert.equal(conflictAudit.status, 'failed')

let mismatchGets = 0
let mismatchCache = false
const mismatch = await applyPriceSelection({
  preview: preview(), skuCode: 'SKU-ASUS-001', auth: auth(), now: NOW,
  fetchCurrentListing: async () => ({ item: listing({ price: mismatchGets++ ? 129 : 120 }), headers: {} }),
  putListing: async () => {},
  updateCache: async () => { mismatchCache = true },
  recordAudit: async () => {}
})
assert.equal(mismatch.status, 'failed')
assert.equal(mismatch.reason, 'failed_get_mismatch')
assert.equal(mismatchCache, false)

console.log('price apply gate regression: PASS')

