import assert from 'node:assert/strict'
import { classifyPriceAgainstPurchase, MIN_SALES_MARGIN_RATIO, normalizeMoney, parseMoney, priceFenceCheck } from '../../src/main/price-fence.js'

assert.equal(MIN_SALES_MARGIN_RATIO, 1)

// 采购价 100：只有低于采购价才硬拦截；120% 不再是硬门槛。
assert.equal(priceFenceCheck({ marketPrice: 99.99, purchasePrice: 100 }).ok, false, '99.99 低于采购价，必须拦截')
assert.equal(priceFenceCheck({ marketPrice: 80, purchasePrice: 100 }).ok, false, '80 低于采购价，必须拦截')
assert.equal(priceFenceCheck({ marketPrice: 100, purchasePrice: 100 }).ok, true, '100 恰好等于采购价，放行')
assert.equal(priceFenceCheck({ marketPrice: 119.99, purchasePrice: 100 }).ok, true, '119.99 虽低于 120% 但不低于采购价，放行')
assert.equal(priceFenceCheck({ marketPrice: 119.99, purchasePrice: 100, minMarginRatio: 1.2 }).ok, true, 'legacy 120% 参数也不能恢复旧硬围栏')
assert.equal(priceFenceCheck({ marketPrice: 120, purchasePrice: 100 }).ok, true, '120 放行')
assert.equal(priceFenceCheck({ marketPrice: 260, purchasePrice: 100 }).ok, true, '260 达标，放行')

// Excel/人工输入的常见人民币格式必须归一化为同一个正数。
assert.equal(parseMoney('¥1,200.50', { label: '采购价' }).value, 1200.5)
assert.equal(parseMoney('￥ 1，200.50 元', { label: '采购价' }).value, 1200.5)
assert.equal(normalizeMoney(' 1 200 ', { label: '采购价' }), 1200)
assert.equal(priceFenceCheck({ marketPrice: '￥1,200.00', purchasePrice: '¥1,000 元' }).ok, true)
assert.equal(priceFenceCheck({ marketPrice: '¥999.99', purchasePrice: '￥1,000' }).ok, false)

const blocked = priceFenceCheck({ marketPrice: 99.99, purchasePrice: 100 })
assert.equal(blocked.requiredMin, 100)
assert.doesNotMatch(blocked.reason, /120%/, '拦截原因不再宣称 120% 硬门槛')
assert.ok(blocked.reason.includes('采购价 ¥100'), '拦截原因应带采购价')

// 真正缺失采购价才跳过围栏；0、负数、NaN 和恶意文本是 present-but-invalid，必须阻断。
assert.equal(priceFenceCheck({ marketPrice: 50, purchasePrice: '' }).ok, true)
assert.equal(priceFenceCheck({ marketPrice: 50 }).ok, true)
for (const purchasePrice of [0, -1, NaN, 'abc', '¥']) {
  const invalid = priceFenceCheck({ marketPrice: 200, purchasePrice })
  assert.equal(invalid.ok, false, `采购价 ${String(purchasePrice)} 存在但非法，必须阻断`)
  assert.match(invalid.reason, /采购价|阻止发布/)
}

// 无效行情价也必须阻断，即使没有采购价；模型输出不能用字符串/负数绕过。
for (const marketPrice of ['abc', 0, -1, NaN, 'javascript:alert(1)']) {
  assert.equal(priceFenceCheck({ marketPrice, purchasePrice: '' }).ok, false)
}

const adversarial = priceFenceCheck({ marketPrice: '{"finalPrice":999999}', purchasePrice: '¥1,000' })
assert.equal(adversarial.ok, false)
assert.equal(adversarial.marketPrice, null)

// 预览分档只负责解释行情价与采购价的关系，不改变上面的发布围栏。
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 80, purchasePrice: 100 }).key, 'below_minimum')
assert.match(classifyPriceAgainstPurchase({ marketPrice: 80, purchasePrice: 100 }).reason, /低于 100 元/)
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 110, purchasePrice: 100 }).key, 'purchase_100_119')
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 120, purchasePrice: 100 }).key, 'purchase_120_plus')
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 150, purchasePrice: 100 }).key, 'purchase_150_plus')
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 200, purchasePrice: 100 }).key, 'purchase_200_plus')
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 90, purchasePrice: 200 }).key, 'below_minimum')
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 140, purchasePrice: 200 }).key, 'below_purchase_price')
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 140, purchasePrice: 100 }).ratioPercent, 140)
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 140, purchasePrice: 100 }).markupPercent, 40)
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 300 }).key, 'no_purchase_price')
assert.equal(classifyPriceAgainstPurchase({ marketPrice: 300, purchasePriceStatus: 'invalid', purchasePriceReason: '采购价格式无效' }).key, 'invalid_purchase_price')

console.log('price fence regression: passed (publication floor + preview purchase-price bands)')
