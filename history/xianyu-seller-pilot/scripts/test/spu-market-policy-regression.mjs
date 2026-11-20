import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { crawlOne } from '../../src/main/goofish.js'
import { listingPriceFenceCheck } from '../../src/main/price-fence.js'
import { effectiveCrawlPolicyForTask } from '../../src/main/search-queries.js'
import { installSearchCapture } from '../../src/main/search-capture.js'

// This fixture verifies the executable contract, rather than only checking
// the shape emitted by task-store. It mirrors the captured Xianyu API payload
// used by the production crawler and proves that SPU policy survives into the
// candidate filter and audit output.
const query = 'Apple TV'
const items = [
  { itemId: 'apple-low', title: 'Apple TV 4K 自用', price: 300 },
  { itemId: 'apple-good', title: 'Apple TV 4K 国行', price: 800 },
  { itemId: 'apple-high', title: 'Apple TV 4K 收藏价', price: 1500 },
  { itemId: 'apple-blacklist', title: 'Apple TV 配件遥控器', price: 900 }
]

const protocol = new EventEmitter()
protocol.attached = false
protocol.isAttached = () => protocol.attached
protocol.attach = () => { protocol.attached = true }
protocol.detach = () => { protocol.attached = false }
protocol.sendCommand = async (method) => {
  if (method !== 'Network.getResponseBody') return {}
  return {
    body: JSON.stringify({
      data: {
        resultList: items.map((item) => ({
          data: {
            item: {
              main: {
                exContent: {
                  itemId: item.itemId,
                  title: item.title,
                  targetUrl: `https://www.goofish.com/item?id=${item.itemId}`,
                  price: [{ text: String(item.price) }]
                }
              }
            }
          }
        }))
      }
    })
  }
}

const wc = new EventEmitter()
Object.assign(wc, {
  debugger: protocol,
  isDestroyed: () => false,
  loadURL: async () => {
    const requestUrl = 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch/1.0/pc.search'
    protocol.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'policy-fixture', request: { url: requestUrl } })
    protocol.emit('message', {}, 'Network.responseReceived', { requestId: 'policy-fixture', response: { url: requestUrl } })
    protocol.emit('message', {}, 'Network.loadingFinished', { requestId: 'policy-fixture' })
    await new Promise((resolve) => setImmediate(resolve))
  },
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
    return { noResult: false, loggedOut: false }
  }
})
installSearchCapture(wc)

const policy = effectiveCrawlPolicyForTask({
  name: 'Apple TV',
  model: 'APPLETV64G',
  searchKeywords: ['Apple TV'],
  spuSearchPolicy: { version: 1 },
  effectiveBlacklist: { mode: 'replace', terms: ['配件'] },
  effectivePriceFence: { minListingPrice: 500, maxListingPrice: 1200 },
  effectivePageFilter: { enabled: true }
}, { globalBlacklist: ['不应继承'], strategy: 'normal' })

assert.deepEqual(policy.queries, [query])
assert.deepEqual(policy.blacklist, { mode: 'replace', terms: ['配件'] })
assert.deepEqual(policy.priceFence, { minListingPrice: 500, maxListingPrice: 1200 })
assert.deepEqual(policy.pageFilter, { enabled: true })

const result = await crawlOne(wc, policy.queries, {
  effectivePolicy: policy,
  queryDelayMinMs: 1,
  queryDelayMaxMs: 1
})

assert.equal(result.ok, true)
assert.equal(result.price, 800, 'only the SPU-in-range listing contributes to the market quote')
assert.deepEqual(result.policyEvidence.effectiveQueries, [query])
assert.deepEqual(result.policyEvidence.blacklist, { mode: 'replace', terms: ['配件'] })
assert.equal(result.policyEvidence.priceFence.belowSpuMinPriceCount, 1)
assert.equal(result.policyEvidence.priceFence.aboveSpuMaxPriceCount, 1)
assert.equal(result.policyEvidence.pageFilter.reasonCode, 'page_filter_unverified', 'no fixture may pretend the future RPA page filter was verified')
assert.equal(result.priceBreakdown.policyEvidence.pageFilter.status, 'unverified')
assert.equal(result.queryLogs[0].markReasonCodes.includes('page_filter_unverified'), true)

const decisions = Object.fromEntries(result.decisionMapByQuery[query].entries.map((entry) => [entry.itemId, entry.reasonCode]))
assert.equal(decisions['apple-low'], 'below_spu_min_price')
assert.equal(decisions['apple-high'], 'above_spu_max_price')
assert.equal(decisions['apple-blacklist'], 'blacklist')
assert.equal(decisions['apple-good'], 'accepted')

assert.equal(listingPriceFenceCheck({ listingPrice: 499, priceFence: { minListingPrice: 500 } }).reasonCode, 'below_spu_min_price')
assert.equal(listingPriceFenceCheck({ listingPrice: 1201, priceFence: { maxListingPrice: 1200 } }).reasonCode, 'above_spu_max_price')
assert.equal(listingPriceFenceCheck({ listingPrice: 800, priceFence: { minListingPrice: 500, maxListingPrice: 1200 } }).ok, true)

console.log('spu market policy regression: passed (effective policy, candidate fence reasons, page-filter audit evidence)')
