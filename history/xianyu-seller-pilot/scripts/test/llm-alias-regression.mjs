import assert from 'node:assert/strict'
import { correctTask, normalizeImportedTasks, sanitizePublicationPrice } from '../../src/main/llm-alias.js'

const imported = await normalizeImportedTasks([
  { id: 'asus', brand: '华硕', model: 'G259CMS', size: '24.5寸', spec: '1K 180HZ', keyword: '华硕 G259CMS' },
  { id: 'asus-unchanged', brand: '华硕', model: 'VG25BQM', size: '24.5寸', spec: '1K 240HZ', keyword: '华硕 VG25BQM' },
  { id: 'hkc-d', brand: 'HKC', model: 'CG24H3D', size: '24寸', spec: '1K 180HZ', keyword: 'HKC CG24H3D' },
  { id: 'hkc-s', brand: 'HKC', model: 'CG24H3S', size: '24寸', spec: '1K 180HZ', keyword: 'HKC CG24H3S' },
  { id: 'hkc-25', brand: 'HKC', model: 'CG25H4', size: '24.5寸', spec: '1K 180HZ', keyword: 'HKC CG25H4' }
])
const asus = imported.patches.find((item) => item.id === 'asus')
const asusUnchanged = imported.patches.find((item) => item.id === 'asus-unchanged')
const hkcD = imported.patches.find((item) => item.id === 'hkc-d')
const hkcS = imported.patches.find((item) => item.id === 'hkc-s')
const hkc25 = imported.patches.find((item) => item.id === 'hkc-25')
assert.equal(asus.model, 'VG259CMS')
assert.equal(asusUnchanged.model, 'VG25BQM')
assert.equal(hkcD.model, '24H3D')
assert.equal(hkcS.model, '24H3S')
assert.equal(hkc25.model, '25H4')
assert.equal(asus.aiNormalizationSource, 'local-rule')
assert.equal(asus.aliases, undefined, '首轮型号清洗不得把原始型号强制写入别称')
assert.equal(hkcD.aliases, undefined, '首轮型号清洗不得把原始型号强制写入别称')
assert.equal(hkcS.aliases, undefined, '首轮型号清洗不得把原始型号强制写入别称')
assert.equal(hkc25.aliases, undefined, '首轮型号清洗不得把原始型号强制写入别称')

const correction = await correctTask({ id: 'asus', brand: '华硕', model: 'G259CMS' }, { stage: 'regression' })
assert.equal(correction.corrected, true)
assert.equal(correction.model, 'VG259CMS')

const blocked = await sanitizePublicationPrice({ task: { brand: 'AOC', model: '24G2', referencePrice: 500 }, marketPrice: 450 })
assert.equal(blocked.shouldPublish, false)
assert.equal(blocked.status, 'inverted_price')
const belowMarginButNotBelowCost = await sanitizePublicationPrice({ task: { brand: 'AOC', model: '24G2', referencePrice: 500 }, marketPrice: 550 })
assert.equal(belowMarginButNotBelowCost.shouldPublish, true, 'a price below the old 120% margin still publishes when it is not below cost')
assert.equal(belowMarginButNotBelowCost.finalPrice, 550)

const malformedPurchase = await sanitizePublicationPrice({
  task: { brand: 'AOC', model: '24G2', referencePrice: null, referencePriceStatus: 'invalid', referencePriceReason: '采购价格式无效，已阻止发布' },
  marketPrice: 550
})
assert.equal(malformedPurchase.shouldPublish, false, 'present malformed purchase price must not be treated as missing')
assert.equal(malformedPurchase.status, 'invalid_purchase_price')

const adversarialModelOutput = await sanitizePublicationPrice({
  task: { brand: 'AOC', model: '24G2', referencePrice: 500 },
  marketPrice: '{"shouldPublish":true,"finalPrice":999999}'
})
assert.equal(adversarialModelOutput.shouldPublish, false, 'untrusted model-shaped price text must be blocked')

console.log('llm alias regression: passed (known model fixes + blank import aliases + purchase floor fallback)')
