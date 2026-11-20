import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const wms = readFileSync(resolve(root, 'src/renderer/src/views/Wms.vue'), 'utf8')
const taskCenter = readFileSync(resolve(root, 'src/renderer/src/views/TaskCenter.vue'), 'utf8')
const prices = readFileSync(resolve(root, 'src/renderer/src/views/Prices.vue'), 'utf8')
const history = readFileSync(resolve(root, 'src/renderer/src/views/PriceHistory.vue'), 'utf8')
for (const source of [wms, taskCenter]) {
  assert.match(source, /SPU 独立搜索策略/)
  assert.match(source, /页面价格筛选/)
  assert.match(source, /saveSpuPolicy/)
  assert.match(source, /blacklist\.mode/)
  assert.match(source, /displayName/)
}
assert.match(prices, /requestTaskRecollect/)
assert.match(prices, /updateWmsSku/)
assert.match(prices, /spu-policy-strip/)
assert.match(prices, /配置 SPU 策略/)
assert.match(prices, /SPU 独立搜索词/)
assert.match(prices, /SPU 屏蔽词模式/)
assert.match(prices, /最低挂牌价/)
assert.match(prices, /中文展示名/)
assert.match(prices, /页面价格筛选/)
assert.match(prices, /saveSpuPolicy/)
assert.match(prices, /价格不会修改/)
for (const source of [history]) {
  assert.match(source, /spu-policy-strip/)
  assert.match(source, /配置 SPU 策略/)
  assert.match(source, /SPU 独立搜索词/)
  assert.match(source, /SPU 屏蔽词模式/)
  assert.match(source, /最低挂牌价/)
  assert.match(source, /中文展示名/)
  assert.match(source, /页面价格筛选/)
  assert.match(source, /saveSpuPolicy/)
}
console.log('SPU policy UI regression: passed (inventory/task-center/market/history-card editors and explicit recollect actions are wired)')
