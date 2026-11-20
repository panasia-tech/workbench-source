import assert from 'node:assert/strict'
import { applyPagePriceFilter, normalizePagePriceFilter, pageFilterScript } from '../../src/main/goofish-price-filter-rpa.js'

assert.deepEqual(normalizePagePriceFilter({ enabled: true, min: 500, max: 1800 }), { enabled: true, minListingPrice: 500, maxListingPrice: 1800 })
assert.equal(normalizePagePriceFilter({ enabled: true, min: 1800, max: 500 }).minListingPrice, null, 'inverted range must not be applied')
assert.match(pageFilterScript({ enabled: true, min: 500 }), /500/)

const notRequested = await applyPagePriceFilter(null, { enabled: false })
assert.equal(notRequested.reasonCode, 'page_filter_not_requested')

const noAdapter = await applyPagePriceFilter({}, { enabled: true, min: 500 })
assert.equal(noAdapter.reasonCode, 'page_filter_adapter_unavailable')

const dom = {
  async executeJavaScript(script) {
    if (script.includes('filterVisible')) {
      return { requested: true, filterVisible: true, inputCount: 2, inputs: [{ value: '500' }, { value: '1800' }], confirmCount: 1 }
    }
    if (script.includes('filledCount')) return { inputCount: 2, filledCount: 2 }
    if (script.includes('node.click')) return { ok: true }
    return null
  }
}
const verified = await applyPagePriceFilter(dom, { enabled: true, min: 500, max: 1800 }, { waitMs: 0 })
assert.equal(verified.reasonCode, 'page_filter_verified')
assert.equal(verified.verified, true)

const blocked = await applyPagePriceFilter({ async executeJavaScript() { return { filterVisible: false } } }, { enabled: true, min: 500 })
assert.equal(blocked.reasonCode, 'page_filter_control_not_found')
console.log('Goofish page price-filter RPA regression: passed (not-requested, adapter unavailable, verified, locator blocked)')
