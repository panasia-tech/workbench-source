import assert from 'node:assert/strict'
import {
  MAX_SPU_SEARCH_QUERIES,
  SPU_SEARCH_POLICY_VERSION,
  buildEffectiveSpuSearchPolicy,
  normalizeSpuSearchPolicy
} from '../../src/shared/spu-search-policy.js'

const raw = normalizeSpuSearchPolicy({
  version: 99,
  search: { mode: 'explicit', queries: ['小米 G24 显示器', '小米 G24 显示器', ...Array.from({ length: 20 }, (_, index) => `额外词${index}`)] },
  blacklist: { mode: 'append', terms: ['滤芯', '滤芯', '配件'] },
  priceFence: { minListingPrice: '500', maxListingPrice: 1500 },
  pageFilter: { enabled: true, password: 'DEMO_ONLY_REDACTED' },
  localization: { displayName: '小米 G24 显示器', searchAliases: ['G24 显示器'] },
  token: 'must-not-survive'
})
assert.equal(raw.version, SPU_SEARCH_POLICY_VERSION)
assert.equal(raw.search.mode, 'explicit')
assert.equal(raw.search.queries.length, MAX_SPU_SEARCH_QUERIES)
assert.deepEqual(raw.blacklist, { mode: 'append', terms: ['滤芯', '配件'] })
assert.deepEqual(raw.priceFence, { minListingPrice: 500, maxListingPrice: 1500 })
assert.deepEqual(raw.pageFilter, { enabled: true })
assert.equal('token' in raw, false)
assert.equal('password' in raw.pageFilter, false)

const inherited = buildEffectiveSpuSearchPolicy({}, {
  baseQueries: ['G24', '小米 G24'],
  globalBlacklist: ['滤芯', '配件']
})
assert.deepEqual(inherited.search, { mode: 'inherit_category', queries: ['G24', '小米 G24'], source: 'category' })
assert.deepEqual(inherited.blacklist, { mode: 'inherit', terms: ['滤芯', '配件'] })
assert.equal(normalizeSpuSearchPolicy({ search: { mode: 'explicit', queries: [] } }).search.mode, 'inherit_category', 'empty explicit configuration must preserve legacy/category fallback')

const explicit = buildEffectiveSpuSearchPolicy(raw, {
  baseQueries: ['不应执行'],
  globalBlacklist: ['滤芯', '充电器']
})
assert.equal(explicit.search.queries[0], '小米 G24 显示器')
assert.deepEqual(explicit.blacklist, { mode: 'append', terms: ['滤芯', '充电器', '配件'] })
assert.equal(explicit.search.queries.length, MAX_SPU_SEARCH_QUERIES, 'aliases must not exceed the universal 12-query cap')

const explicitWithAlias = buildEffectiveSpuSearchPolicy({
  search: { mode: 'explicit', queries: ['14600K'] },
  localization: { displayName: '英特尔 i5-14600K', searchAliases: ['14600K CPU'] }
})
assert.deepEqual(explicitWithAlias.search.queries, ['14600K', '14600K CPU'], 'explicitly configured search aliases should participate when capacity remains')

const replace = buildEffectiveSpuSearchPolicy({
  blacklist: { mode: 'replace', terms: ['滤芯'] },
  priceFence: { minListingPrice: 800, maxListingPrice: 500 }
}, { globalBlacklist: ['滤芯', '配件'] })
assert.deepEqual(replace.blacklist, { mode: 'replace', terms: ['滤芯'] })
assert.deepEqual(replace.priceFence, { minListingPrice: null, maxListingPrice: null }, 'invalid inverted fence must not filter all listings')

console.log('spu search policy regression: passed (versioned policy, effective queries, blacklist, fence, DTO sanitization)')
