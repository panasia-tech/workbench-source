import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const read = (relative) => readFileSync(resolve(root, relative), 'utf8')
const wms = read('src/renderer/src/views/Wms.vue')
const prices = read('src/renderer/src/views/Prices.vue')
const history = read('src/renderer/src/views/PriceHistory.vue')
const main = read('src/main/index.js')
const preload = read('src/preload/index.js')

assert.match(wms, /API-SPU 是唯一主键/)
assert.match(wms, /库存 API-SPU 主表/)
assert.match(wms, /getWmsProjection/)
assert.match(wms, /onWmsSyncState/)
assert.match(wms, /API 当前销售价/)
assert.match(wms, /最近行情价/)
assert.match(wms, /待处理队列/)
assert.doesNotMatch(wms, /queryUnifiedTasks\([^)]*100000/)
assert.doesNotMatch(wms, /API 尚未同步/)
assert.doesNotMatch(wms, /匹配度|候选货号|型号精确匹配|SPU精准匹配/)

assert.match(prices, /const queueKind = ref\('all'\)/)
assert.match(prices, /key: 'all',[\s\S]*key: 'failed',[\s\S]*key: 'pending',[\s\S]*key: 'success',[\s\S]*key: 'review'/)
assert.match(prices, /getWmsProjection/)
assert.match(prices, /previewPriceCandidates/)
assert.match(prices, /confirmPriceSelection/)
assert.match(prices, /API 销售价/)
assert.match(prices, /API 建议价/)
assert.match(prices, /价格意图已记录，API 价格未修改/)
assert.match(prices, /updateWmsSku/)
assert.match(prices, /spu-policy-strip/)
assert.match(prices, /SPU 独立搜索词/)
assert.match(prices, /SPU 屏蔽词模式/)
assert.match(prices, /最低挂牌价/)
assert.match(prices, /中文展示名/)
assert.match(prices, /页面价格筛选/)
assert.match(prices, /saveSpuPolicy/)
assert.match(prices, /配置 SPU 策略/)
assert.doesNotMatch(prices, /getTaskQueues\(/)
assert.doesNotMatch(prices, /queryTaskResults|tasks:results/)

assert.match(history, /全部/)
assert.match(history, /失败/)
assert.match(history, /待采集/)
assert.match(history, /成功/)
assert.match(history, /待复核/)
assert.match(history, /queryMarketHistory/)
assert.match(history, /API 销售价/)
assert.match(history, /spu-policy-strip/)
assert.match(history, /SPU 独立搜索词/)
assert.match(history, /SPU 屏蔽词模式/)
assert.match(history, /最低挂牌价/)
assert.match(history, /中文展示名/)
assert.match(history, /页面价格筛选/)
assert.match(history, /saveSpuPolicy/)
assert.doesNotMatch(history, /<el-select[^>]+priceBand/)
assert.doesNotMatch(history, /(?:queryTaskResults|tasks:results)\s*\(/)

assert.match(preload, /getWmsProjection:.*wms:projection/)
assert.match(preload, /previewPriceCandidates:.*market:price-preview/)
assert.match(preload, /confirmPriceSelection:.*market:price-select/)
assert.match(preload, /queryMarketHistory:.*market:history/)
assert.doesNotMatch(preload, /wmsMcpKey|wmsRestPassword/)

const selectionBlock = main.slice(main.indexOf("ipcMain.handle('market:price-select'"), main.indexOf("ipcMain.handle('market:history'"))
// `market:price-select` is an explicit operator intent boundary.  The IPC
// handler returns the selected intent together with the downstream apply
// result; a blocked apply is represented by `status: 'blocked'` and
// `putIssued: false` in the downstream result (or in the stale/error guards),
// rather than by a hard-coded `intent_created` status string in this handler.
// Keep the assertion tied to the actual response contract so a future status
// label change cannot make this test pass while dropping the selected intent.
assert.match(selectionBlock, /intent:\s*selected\.selection/)
assert.match(selectionBlock, /status:\s*writeback\?\.status\s*\|\|\s*'blocked'/)
assert.match(selectionBlock, /putIssued:\s*false/)
assert.match(selectionBlock, /价格候选确认失败/)
assert.doesNotMatch(selectionBlock, /updateInventorySku|fetchInventorySku|adminLogin/)

console.log(JSON.stringify({ ok: true, checks: 32, mode: 'api-spu-unified-ui-observability' }))
