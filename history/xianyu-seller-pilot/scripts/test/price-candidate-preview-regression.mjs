import assert from 'node:assert/strict'

import {
  PRICE_POLICY_VERSION,
  calculateSpreadRatio,
  createPriceCandidatePreview,
  createPriceCandidatePreviews,
  selectPriceCandidate,
} from '../../src/main/price-candidate.js'

const NOW = Date.parse('2026-08-25T12:00:00.000Z')
const observation = (id, price, hours = 1, extra = {}) => ({
  id,
  price,
  source: 'goofish',
  observedAt: new Date(NOW - hours * 3_600_000).toISOString(),
  ...extra,
})

const base = {
  spuCode: 'SPU-ROG-260',
  skuCode: 'SKU-ROG-260-BLK',
  costPrice: 100,
  apiCurrentSalePrice: 188,
  apiSuggestPrice: 199,
  now: NOW,
}

const ready = createPriceCandidatePreview({
  ...base,
  now: NOW,
  marketObservations: [observation('m-1', 121), observation('m-2', 125), observation('m-3', 129)],
})

assert.equal(ready.status, 'ready')
assert.equal(ready.reviewOnly, false)
assert.equal(ready.policyVersion, PRICE_POLICY_VERSION)
assert.match(ready.previewId, /^[0-9a-f]{64}$/)
assert.match(ready.inputSnapshotHash, /^[0-9a-f]{64}$/)
assert.equal(ready.market.median, 125)
assert.equal(ready.market.spreadRatio, calculateSpreadRatio([121, 125, 129]))
assert.equal(ready.costFloor, 100)
assert.equal(ready.recommendationPrice, 130)
assert.deepEqual(ready.candidates.map((item) => item.key), ['market_median', 'recommendation'])
assert.equal(ready.facts.apiCurrentSalePrice, 188)
assert.equal(ready.facts.apiSuggestPrice, 199)
assert.equal(ready.market.observations.some((item) => item.price === 188 || item.price === 199), false)
assert.equal(Object.hasOwn(ready, 'selectedPrice'), false, 'preview must never select a price implicitly')
assert.equal(ready.reasonCodes.length, 0)

// API price facts remain separate even if someone tries to inject them into
// the observation stream.  They cannot increase the sample count.
const apiFactOnly = createPriceCandidatePreview({
  ...base,
  marketObservations: [
    observation('api-current', 188, 1, { source: 'api_current_sale_price' }),
    observation('api-suggest', 199, 1, { source: 'api_suggest_price' }),
  ],
}, { now: NOW })
assert.equal(apiFactOnly.status, 'review_only')
assert.equal(apiFactOnly.market.sampleCount, 0)
assert.ok(apiFactOnly.reasonCodes.includes('API_PRICE_NOT_MARKET_OBSERVATION'))
assert.ok(apiFactOnly.reasonCodes.includes('INSUFFICIENT_FRESH_SAMPLES'))
assert.equal(apiFactOnly.facts.apiCurrentSalePrice, 188)
assert.equal(apiFactOnly.facts.apiSuggestPrice, 199)

// Fewer than three samples and stale samples are always review-only.
for (const samples of [
  [observation('only-1', 100), observation('only-2', 101)],
  [observation('stale-1', 100, 25), observation('stale-2', 101, 26), observation('stale-3', 27, 27)],
]) {
  const preview = createPriceCandidatePreview({ ...base, marketObservations: samples }, { now: NOW })
  assert.equal(preview.status, 'review_only')
  assert.equal(Object.hasOwn(preview, 'selectedPrice'), false)
  assert.ok(preview.reasonCodes.includes('INSUFFICIENT_FRESH_SAMPLES'))
}

// Cost is a hard floor; the recommendation is rounded to the nearest ten but
// never rounded below the floor.
const floorPreview = createPriceCandidatePreview({
  ...base,
  costPrice: 103,
  marketObservations: [observation('f-1', 103), observation('f-2', 103), observation('f-3', 103)],
}, { now: NOW })
assert.equal(floorPreview.recommendationPrice, 110)
assert.equal(floorPreview.candidates.every((item) => item.price >= 103), true)
assert.throws(() => selectPriceCandidate(floorPreview, { choice: 'custom', customPrice: 99, confirmed: true }), /成本底价/)

// A wide range is review-only even with enough fresh observations.
const wide = createPriceCandidatePreview({
  ...base,
  marketObservations: [observation('w-1', 100), observation('w-2', 125), observation('w-3', 150)],
}, { now: NOW })
assert.equal(wide.market.spreadRatio, 0.4)
assert.equal(wide.status, 'review_only')
assert.ok(wide.reasonCodes.includes('SPREAD_EXCEEDS_MAX'))
assert.deepEqual(wide.candidates, [])

// Each SKU receives an independent sample set and identity.
const previews = createPriceCandidatePreviews([
  { ...base, skuCode: 'SKU-A', marketObservations: [observation('a-1', 100), observation('a-2', 110), observation('a-3', 120)] },
  { ...base, skuCode: 'SKU-B', marketObservations: [observation('b-1', 300), observation('b-2', 310), observation('b-3', 320)] },
], { now: NOW })
assert.equal(previews.length, 2)
assert.notEqual(previews[0].previewId, previews[1].previewId)
assert.equal(previews[0].market.median, 110)
assert.equal(previews[1].market.median, 310)
assert.deepEqual(previews.map((item) => item.skuCode), ['SKU-A', 'SKU-B'])

// Explicit confirmation is the only path that creates selectedPrice.
assert.throws(() => selectPriceCandidate(ready, { choice: 'recommendation' }), /显式确认/)
const selected = selectPriceCandidate(ready, {
  choice: 'recommendation',
  confirmed: true,
  operatorId: 'operator-1',
  selectedAt: NOW,
})
assert.equal(selected.selectedPrice, 130)
assert.equal(selected.status, 'selected')
assert.equal(selected.selection.operatorId, 'operator-1')
assert.match(selected.selectionIdempotencyKey, /^SPU-ROG-260:SKU-ROG-260-BLK:/)
assert.equal(Object.hasOwn(ready, 'selectedPrice'), false, 'original preview stays append-only')

// A changed sample snapshot or policy version creates a new identity.
const changedSample = createPriceCandidatePreview({
  ...base,
  marketObservations: [observation('m-1', 122), observation('m-2', 125), observation('m-3', 129)],
}, { now: NOW })
const changedPolicy = createPriceCandidatePreview({
  ...base,
  marketObservations: [observation('m-1', 121), observation('m-2', 125), observation('m-3', 129)],
}, { now: NOW, policy: { policyVersion: 'price-policy-v1-revision' } })
assert.notEqual(ready.previewId, changedSample.previewId)
assert.notEqual(ready.previewId, changedPolicy.previewId)

console.log('price candidate preview regression: passed (policy-v1, per-SKU, explicit selection)')
